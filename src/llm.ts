import OpenAI from "openai";
import { log } from "./logger.js";
import { askAfterMinutes, askAfterSteps, askAfterTokens, knownSecrets, redactKnownSecrets } from "./config.js";
import { compressHistory, contextBudget, estimateTokens, processToolOutput } from "./context.js";
import { LoopGuard, TurnBudget, describeLimit, limitHeader, wrapUpPrompt, type LimitHit } from "./turn-limits.js";
import type { AppConfig, ChatMessage, MediaAttachment, McpTool, ReasoningLevel, StreamEvent, TodoItem, ToolResult } from "./types.js";
import { DEFAULT_REASONING, isExtendedReasoning, isXiaomiMimoEndpoint } from "./reasoning.js";
import { hasMediaData, mediaNote, pruneMedia, rejectMedia, userContent } from "./services/media.js";

export interface ChatOptions {
  config: AppConfig;
  messages: ChatMessage[];
  tools: McpTool[];
  reasoning: ReasoningLevel;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  signal?: AbortSignal;
  /** Current plan (`todowrite`), carried into the compaction note so it survives a cut history. */
  plan?: TodoItem[];
  /**
   * Asked when the turn reaches a limit (`askAfterSteps`, `askAfterTokens`, `askAfterMinutes`)
   * or looks stuck in a loop: true goes on. Without it (subagents, `run` without a terminal),
   * nobody could answer: the turn ends there with a summary written without tools.
   */
  confirmContinue?: (hit: LimitHit) => Promise<boolean>;
}

export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  try {
    yield* streamOpenAI(opts);
  } catch (err) {
    if (isCancellation(err, opts.signal)) throw err;
    void log("error", `streamChat: ${describeApiError(err)}`);
    yield { type: "error", message: enrichError(err, opts.config) };
  }
}

/**
 * Whether the error is the user's cancel. Only the turn's signal says so: a network failure
 * whose text has "aborted" in it ("connection aborted by peer") is an error to show.
 */
export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal) return signal.aborted;
  return err instanceof Error && err.name === "AbortError";
}

export function enrichError(err: unknown, config: AppConfig): string {
  const e = err as { message?: string; status?: number; status_code?: number; error?: { message?: string } };
  const status = e?.status ?? e?.status_code;
  const inner = e?.error?.message ?? e?.message ?? String(err);
  const hint =
    status === 404
      ? ` - 404: check the baseURL and the model ID. SiliconFlow and other OpenAI-compatible providers use a baseURL ending in "/v1".`
      : status === 401
        ? " - 401: API key is invalid."
        : "";
  return `[${config.model}] ${inner}${status ? ` (HTTP ${status})` : ""}${hint}`;
}

/* ----------------------------- OpenAI-compatible ----------------------------- */

export function buildOpenAIMessages(
  config: AppConfig,
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const preserveReasoningContent = isXiaomiMimoEndpoint(config.baseURL);
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (config.system) out.push({ role: "system", content: config.system });
  // compressHistory may drop the assistant(tool_calls) message that a tool result answers;
  // an orphan tool message makes the API reject the request, so skip those.
  const knownCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) knownCallIds.add(c.id);
    if (m.role === "tool" && m.toolCallId && !knownCallIds.has(m.toolCallId)) continue;
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.media ? userContent(m, preserveReasoningContent) : m.content,
      } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: m.content || "",
          tool_calls: m.toolCalls,
          ...(preserveReasoningContent && m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      } else {
        out.push({
          role: "assistant",
          content: m.content,
          ...(preserveReasoningContent && m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      }
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? m.toolName ?? "call",
      });
    }
  }
  return out;
}

export function buildOpenAITools(tools: McpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? `MCP tool from "${t.server}"`,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

const STREAM_CONNECT_TIMEOUT_MS = 300_000;
/** Time without any data in an open stream: the provider or the network stopped answering. */
export const STREAM_IDLE_TIMEOUT_MS = 300_000;

const connectTimeoutMessage = () => `Sem resposta da API após ${STREAM_CONNECT_TIMEOUT_MS / 1000}s (timeout de conexão)`;

async function withConnectTimeout<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onTimeout?: () => void,
  ms = STREAM_CONNECT_TIMEOUT_MS,
  message: () => string = connectTimeoutMessage
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      onTimeout?.();
      reject(new Error(message()));
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Abortado", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new DOMException("Abortado", "AbortError"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); }
    );
  });
}

/** Official OpenAI endpoints reject `max_tokens` for reasoning models (o-series, gpt-5). */
export function isOfficialOpenAIEndpoint(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

// Enough for a large file in one call, even with reasoning on. A higher value only makes a
// runaway response cost more: 16k tokens already took 4.5 minutes on MiMo.
const MAX_OUTPUT_TOKENS = 32768;
// Models and providers with a smaller cap reject the value above instead of clamping it.
const FALLBACK_OUTPUT_TOKENS = 16384;
// Keeps room for the conversation even when many MCP tools fill most of the context budget.
const MIN_HISTORY_TOKENS = 20_000;

/**
 * The share of the input the provider served from its prompt cache. OpenAI reports it in
 * `prompt_tokens_details.cached_tokens` (a hit inside `prompt_tokens`); DeepSeek in
 * `prompt_cache_hit_tokens` (a count beside `prompt_tokens`). Providers that report neither
 * get 0, and the whole input is priced as new.
 */
function cachedInputTokens(usage: {
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
}): number {
  const openai = usage.prompt_tokens_details?.cached_tokens;
  if (typeof openai === "number" && openai > 0) return openai;
  const deepseek = usage.prompt_cache_hit_tokens;
  return typeof deepseek === "number" && deepseek > 0 ? deepseek : 0;
}

const GENERIC_RETRY_DELAY_MS = 1000;

/**
 * The chunks of a stream, failing when none arrives for `idleMs`: without this, a provider
 * that stops in the middle of an answer leaves the turn waiting forever.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
  idleMs = STREAM_IDLE_TIMEOUT_MS
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const message = () => `A API parou de enviar dados por ${Math.round(idleMs / 1000)}s no meio da resposta (stream travado).`;
  try {
    while (true) {
      const next = await withConnectTimeout(iterator.next(), signal, onTimeout, idleMs, message);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Not awaited: on a stalled stream the provider's iterator may never answer.
    void iterator.return?.()?.catch?.(() => {});
  }
}

/**
 * Xiaomi MiMo sometimes answers a valid request with HTTP 400 and only "Request failed"
 * (the same request works right after). Any 400 that explains itself is a real error.
 */
function isGenericRejection(err: unknown): boolean {
  const e = err as { status?: number; error?: { message?: string } };
  return e?.status === 400 && /^request failed\.?$/i.test(e.error?.message?.trim() ?? "");
}

/** Statuses a provider uses for a payload it cannot take: unsupported file, too large, invalid. */
function isPayloadRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 413 || status === 415 || status === 422;
}

/** The token parameter was understood but its value is above what the model accepts. */
function isOutputLimitRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isPayloadRejection(err)
    && /max_(completion_)?tokens/i.test(msg)
    && /too large|exceed|maximum|less than|at most|range|between/i.test(msg);
}

function describeApiError(err: unknown): string {
  const e = err as { status?: number; error?: unknown; message?: string };
  return `HTTP ${e?.status}: ${JSON.stringify(e?.error ?? e?.message ?? String(err)).slice(0, 500)}`;
}

/** Rate limit or a provider-side failure: the same request usually works again a moment later. */
function isTransientFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

/**
 * The provider's own limit on the request size, not the model's: our budget (90K by default) is
 * only an estimate, and a model with a smaller window than it says, or with different token
 * accounting, refuses the request instead of answering it. Compacting harder is the only way out.
 *
 * A bare 413 is not enough: it is also what a provider says about a file that is too large, and
 * that has its own recovery (the media is dropped from the request). The message has to be about
 * the context; without one, the payload case wins.
 */
export function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const e = err as { error?: { message?: string; code?: string } };
  const text = `${e?.error?.message ?? ""} ${e?.error?.code ?? ""} ${msg}`;
  return /context_length|context length|maximum context|context window|prompt is too long|too many tokens|reduce the length|input is too long|exceeds the (model'?s )?(maximum )?context/i.test(text);
}

/** How long the provider asked us to wait, bounded to what a turn can afford. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: { get?: (name: string) => string | null } })?.headers;
  const raw = headers?.get?.("retry-after") ?? undefined;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, TRANSIENT_RETRY_MAX_DELAY_MS);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), TRANSIENT_RETRY_MAX_DELAY_MS);
  return undefined;
}

/** Null when the arguments are not a JSON object: usually a response cut off mid tool call. */
function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function invalidArgsMessage(name: string, finishReason: string | null, outputLimit: number): string {
  if (finishReason === "length") {
    return `Nada foi executado: a resposta atingiu o limite de ${outputLimit} tokens de saída e os argumentos de ${name} foram cortados. Refaça em partes menores: escreva o arquivo com a primeira parte e acrescente o restante em chamadas separadas com edit_file.`;
  }
  // The stream ended without a finish_reason: the arguments may have been correct so far.
  if (finishReason === null) {
    return `Nada foi executado: a resposta foi interrompida antes do fim (o provedor ou a conexão encerrou o stream) e os argumentos de ${name} ficaram incompletos. Repita a chamada.`;
  }
  return `Nada foi executado: os argumentos de ${name} não são um objeto JSON válido. Corrija e tente de novo.`;
}

/**
 * The provider's limit on the request size counts against an estimate: the history is cut down to
 * this fraction of itself and sent again, at most this many times.
 */
const CONTEXT_OVERFLOW_SHRINK = 0.6;
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Abortado", "AbortError");
}

/** Result of the calls of a step that never ran: every call needs one, or the history is invalid. */
export const NOT_RUN_AFTER_CANCEL = "Não executada: o usuário cancelou o turno antes desta chamada.";

/** A connection that drops in the middle of a response: the step is requested again this many times. */
const STREAM_DROP_RETRIES = 2;
/** A rate limit or a provider failure: how many times the same request is sent again. */
const TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;
const STREAM_DROP_RETRY_DELAY_MS = 1000;
const CONNECTION_DROP_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"]);

/**
 * A connection lost while the response was coming (Bun: ECONNRESET, "The socket connection was
 * closed unexpectedly"; undici: "terminated"). HTTP errors come with a status and are not this.
 */
export function isConnectionDrop(err: unknown): boolean {
  let e = err as { code?: unknown; message?: unknown; status?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    if (e.status !== undefined) return false;
    if (typeof e.code === "string" && CONNECTION_DROP_CODES.has(e.code)) return true;
    const msg = typeof e.message === "string" ? e.message : "";
    if (/ECONNRESET|ETIMEDOUT|EPIPE|socket connection was closed|socket hang up|other side closed|^terminated$/i.test(msg)) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Waits `ms`, or less if the turn is cancelled meanwhile. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) return done();
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal, confirmContinue, plan } = opts;
  // Retries are ours (`isTransientFailure`): the SDK's own would multiply them and ignore the
  // `Retry-After` the provider sends.
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, maxRetries: 0 });
  const secrets = await knownSecrets(config);
  const apiTools = buildOpenAITools(tools);
  const isXiaomiMimo = isXiaomiMimoEndpoint(config.baseURL);
  let effort = !isXiaomiMimo && reasoning !== "none" ? reasoning : undefined;
  let supportsEffort = true;
  let outputLimit = MAX_OUTPUT_TOKENS;
  let tokenParam: "max_tokens" | "max_completion_tokens" = isOfficialOpenAIEndpoint(config.baseURL)
    ? "max_completion_tokens"
    : "max_tokens";

  // `history` is the full conversation; `turn` collects only the messages produced in this
  // call (assistant tool calls, tool results, final answer) so the caller can persist them.
  // The history is re-compacted before every request: a long tool loop can otherwise grow
  // far beyond the context budget.
  const history: ChatMessage[] = [...messages];
  // The system prompt and the tool schemas are sent in every request and use the same budget.
  // `let`: a provider that refuses the size makes the next request fit a smaller window.
  let historyBudget = Math.max(
    MIN_HISTORY_TOKENS,
    contextBudget(config.contextTokens) - estimateTokens(config.system ?? "") - estimateTokens(JSON.stringify(apiTools))
  );
  const turn: ChatMessage[] = [];
  let finalContent = "";
  let finalThinking = "";
  const budget = new TurnBudget(
    {
      steps: askAfterSteps(config.askAfterSteps),
      tokens: askAfterTokens(config.askAfterTokens),
      minutes: askAfterMinutes(config.askAfterMinutes),
    },
    () => Date.now(),
    config.tokenWeights
  );
  const loops = new LoopGuard();
  /** Set by the loop guard during a step: the turn stops (or asks) before the next one. */
  let loopStop: string | undefined;

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  /** Text written before what comes next, separated from it by a blank line. */
  function* appendText(text: string): Generator<StreamEvent> {
    const sep = finalContent && !finalContent.endsWith("\n") ? "\n\n" : "";
    finalContent += sep + text;
    yield { type: "text", text: sep + text };
  }

  /**
   * The last request of a turn stopped at a limit, with nobody to ask: no tools, only a report
   * of what was done and what is left, so whoever called gets something to work with. If it
   * fails, the turn still ends with the note saying where it stopped.
   */
  async function* wrapUp(hit: LimitHit): AsyncGenerator<StreamEvent> {
    const header = limitHeader(hit);
    yield* appendText(`${header}\n\n`);
    const request = buildOpenAIMessages(config, [
      ...compressHistory(pruneMedia(history), historyBudget, { keepToolCallReasoning: isXiaomiMimo }),
      { role: "user", content: wrapUpPrompt(hit) },
    ]);
    let summary = "";
    let failure = "";
    // tool_choice "none" keeps the request equal to the earlier ones (prompt cache); a provider
    // that refuses it gets the request again without tools.
    for (let withTools = apiTools.length > 0; ; withTools = false) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const stream = await withConnectTimeout(
          client.chat.completions.create(
            {
              model: config.model,
              messages: request,
              stream: true,
              [tokenParam]: outputLimit,
              stream_options: { include_usage: true },
              ...(supportsEffort && effort ? { reasoning_effort: "low" } : {}),
              ...(isXiaomiMimo ? { thinking: { type: "disabled" } } : {}),
              ...(withTools ? { tools: apiTools, tool_choice: "none" } : {}),
            } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            { signal: controller.signal }
          ),
          signal,
          () => controller.abort()
        );
        const chunks = withIdleTimeout(stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>, signal, () => controller.abort());
        for await (const chunk of chunks) {
          if (chunk.usage) {
            budget.addUsage(
              chunk.usage.prompt_tokens ?? 0,
              chunk.usage.completion_tokens ?? Math.max(0, (chunk.usage.total_tokens ?? 0) - (chunk.usage.prompt_tokens ?? 0)),
              cachedInputTokens(chunk.usage)
            );
            yield {
              type: "usage",
              totalTokens: chunk.usage.total_tokens,
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              cachedTokens: cachedInputTokens(chunk.usage),
            };
          }
          const delta = chunk.choices?.[0]?.delta as { content?: string | null; reasoning_content?: string; reasoning?: string } | undefined;
          const reasoningText = delta?.reasoning_content || delta?.reasoning;
          if (reasoningText) {
            finalThinking += reasoningText;
            yield { type: "thinking", text: reasoningText };
          }
          if (delta?.content) {
            summary += delta.content;
            finalContent += delta.content;
            yield { type: "text", text: delta.content };
          }
        }
        throwIfAborted(signal);
        break;
      } catch (err) {
        throwIfAborted(signal);
        void log("warn", `Resumo do turno parado falhou${withTools ? "; repetindo sem ferramentas" : ""}: ${describeApiError(err)}`);
        // Only before any text: otherwise the summary would be written twice.
        if (withTools && !summary) continue;
        failure = err instanceof Error ? err.message : String(err);
        break;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    if (!summary.trim()) {
      const note = failure ? `[Não consegui escrever o resumo: ${failure}]` : "[O modelo não escreveu o resumo.]";
      summary += note;
      finalContent += note;
      yield { type: "text", text: note };
    }
    turn.push({ role: "assistant", content: `${header}\n\n${summary.trim()}` });
    const { reason, steps, tokens, elapsedMs, detail } = { ...hit, tokens: budget.tokens };
    yield { type: "limit", reason, steps, tokens, elapsedMs, ...(detail ? { detail } : {}) };
    yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
  }

  // No hard step cap: a long task ends when the model answers without tools, on an error or
  // when the turn is cancelled. The history is re-compacted on every step, so it stays in
  // budget. When a budget runs out or the loop guard fires, the user is asked whether to go
  // on; with nobody to ask, the turn ends with a summary (wrapUp).
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    const hit: LimitHit | null = loopStop
      ? { reason: "loop", limit: 0, detail: loopStop, ...budget.usage() }
      : budget.exceeded();
    if (hit) {
      const goOn = confirmContinue ? await confirmContinue(hit) : false;
      throwIfAborted(signal);
      if (goOn) {
        if (hit.reason === "loop") loops.reset();
        loopStop = undefined;
        budget.extend();
      } else {
        void log("warn", `LLM step ${step}: turno parado (${hit.reason}): ${describeLimit(hit)}`);
        if (!confirmContinue) {
          yield* wrapUp(hit);
          return;
        }
        const notice = `[Turno pausado a pedido do usuário depois de ${step} passos. Envie uma mensagem para continuar ou mudar o rumo.]`;
        yield* appendText(notice);
        turn.push({ role: "assistant", content: notice });
        yield { type: "limit", reason: hit.reason, steps: hit.steps, tokens: hit.tokens, elapsedMs: hit.elapsedMs, ...(hit.detail ? { detail: hit.detail } : {}) };
        yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
        return;
      }
    }
    const buildRequest = () =>
      buildOpenAIMessages(config, compressHistory(pruneMedia(history), historyBudget, { keepToolCallReasoning: isXiaomiMimo, plan }));
    let working = buildRequest();
    let content = "";
    let thinking = "";
    const pendingCalls: {
      id: string;
      name: string;
      args: string;
    }[] = [];
    let argBuffers = new Map<number, { id?: string; name?: string; args: string }>();
    let finishReason: string | null = null;
    let toolCallChunkCount = 0;
    // What earlier steps wrote: a step requested again starts from here.
    const contentBefore = finalContent;
    const thinkingBefore = finalThinking;
    let drops = 0;
    // The step spent the whole output limit thinking: it is requested again with less thinking.
    let lowered = false;
    const canLowerReasoning = () => (isXiaomiMimo ? reasoning !== "none" : Boolean(supportsEffort && effort && effort !== "low"));

    let requestController: AbortController | undefined;
    let detachRequestAbort = () => {};
    const makeRequest = (withEffort: boolean) => {
      detachRequestAbort();
      requestController = new AbortController();
      if (signal?.aborted) requestController.abort();
      const onExternalAbort = () => requestController?.abort();
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      detachRequestAbort = () => signal?.removeEventListener("abort", onExternalAbort);
      const sentEffort = effort && lowered ? "low" : effort;
      return client.chat.completions.create(
        {
          model: config.model,
          messages: working,
          stream: true,
          [tokenParam]: outputLimit,
          stream_options: { include_usage: true },
          ...(withEffort && sentEffort ? { reasoning_effort: sentEffort } : {}),
          ...(isXiaomiMimo ? { thinking: { type: reasoning === "none" || lowered ? "disabled" : "enabled" } } : {}),
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: requestController.signal }
      );
    };

    // One response for this step. Tools only run after it ends, so requesting it again (lost
    // connection, only thinking) runs nothing twice.
    for (;;) {
      content = "";
      thinking = "";
      argBuffers = new Map();
      finishReason = null;
      toolCallChunkCount = 0;
      finalContent = contentBefore;
      finalThinking = thinkingBefore;

      let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | undefined;
      void log("info", `LLM step ${step}: conectando (timeout=${STREAM_CONNECT_TIMEOUT_MS / 1000}s)`);
      // Providers differ in which optional parameters they accept. Each rejected parameter
      // is adjusted at most once and remembered for the following steps.
      let retriedGeneric = false;
      // Counted across the whole step: a retry loop that keeps failing must end somewhere.
      let transientRetries = 0;
      let overflowRetries = 0;
      for (let attempt = 0; !stream; attempt++) {
        try {
          stream = await withConnectTimeout(makeRequest(supportsEffort), signal, () => requestController?.abort());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!retriedGeneric && isGenericRejection(err)) {
            // Refused before any output, so repeating it costs nothing and runs no tool.
            retriedGeneric = true;
            void log("warn", `Provedor recusou o pedido sem explicar; repetindo uma vez: ${describeApiError(err)}`);
            await new Promise((resolve) => setTimeout(resolve, GENERIC_RETRY_DELAY_MS));
            throwIfAborted(signal);
          } else if (isContextOverflow(err) && overflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES) {
            // Our budget is an estimate: the provider knows the real window. Cutting the history
            // and asking again beats failing the whole turn over a few thousand tokens.
            overflowRetries++;
            const next = Math.max(MIN_HISTORY_TOKENS, Math.floor(historyBudget * CONTEXT_OVERFLOW_SHRINK));
            void log("warn", `Provedor recusou o tamanho do pedido; reduzindo o histórico de ${historyBudget} para ${next} tokens e repetindo: ${describeApiError(err)}`);
            if (next >= historyBudget) throw err;
            historyBudget = next;
            working = buildRequest();
            yield {
              type: "retry",
              message: `⚠️ o pedido passou do contexto do modelo; compactando o histórico e repetindo (${overflowRetries}/${MAX_CONTEXT_OVERFLOW_RETRIES})...`,
            };
          } else if (isTransientFailure(err) && transientRetries < TRANSIENT_RETRIES) {
            // Rate limit or provider outage. Nothing was written yet, so the step is just resent.
            transientRetries++;
            const delay = retryAfterMs(err) ?? TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (transientRetries - 1);
            void log("warn", `Provedor indisponível ou limitado; repetindo em ${Math.round(delay / 1000)}s (${transientRetries}/${TRANSIENT_RETRIES}): ${describeApiError(err)}`);
            yield {
              type: "retry",
              message: `⏳ o provedor não respondeu (${(err as { status?: number })?.status ?? "?"}); tentando de novo em ${Math.round(delay / 1000)}s (${transientRetries}/${TRANSIENT_RETRIES})...`,
            };
            await wait(delay, signal);
            throwIfAborted(signal);
          } else if (outputLimit > FALLBACK_OUTPUT_TOKENS && isOutputLimitRejection(err)) {
            // Before the checks below: they would blame the media or the parameter name.
            outputLimit = FALLBACK_OUTPUT_TOKENS;
            void log("warn", `Provedor recusou o limite de saída; repetindo com ${outputLimit}: ${describeApiError(err)}`);
          } else if (isPayloadRejection(err) && hasMediaData(history)) {
            // Otherwise the file stays in the history and blocks the rest of the conversation.
            void log("warn", `Provedor recusou um pedido com mídia; repetindo sem ela: ${describeApiError(err)}`);
            rejectMedia(history);
            working = buildRequest();
          } else if (attempt < 3 && supportsEffort && effort && isExtendedReasoning(effort) && /reasoning/i.test(msg)) {
            // Most providers stop at "high": keep thinking on instead of dropping the parameter.
            void log("warn", `Provedor rejeitou reasoning_effort=${effort}; repetindo com ${DEFAULT_REASONING}`);
            effort = DEFAULT_REASONING;
          } else if (attempt < 3 && supportsEffort && effort && /reasoning/i.test(msg)) {
            supportsEffort = false;
            void log("warn", "Provedor rejeitou reasoning_effort; repetindo sem ele");
          } else if (attempt < 3 && tokenParam === "max_tokens" && /max_tokens/.test(msg) && /max_completion_tokens/.test(msg)) {
            tokenParam = "max_completion_tokens";
            void log("warn", "Provedor exige max_completion_tokens; repetindo");
          } else if (attempt < 3 && tokenParam === "max_completion_tokens" && /max_completion_tokens/.test(msg) && /unsupported|unknown|unrecognized|not supported|invalid/i.test(msg)) {
            tokenParam = "max_tokens";
            void log("warn", "Provedor não aceita max_completion_tokens; repetindo com max_tokens");
          } else {
            detachRequestAbort();
            throw err;
          }
        }
      }
      void log("info", `LLM step ${step}: stream conectado`);

      let stepHasText = false;
      let stepHasThinking = false;
      let gotUsage = false;
      try {
        const chunks = withIdleTimeout(
          stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
          signal,
          () => requestController?.abort()
        );
        for await (const chunk of chunks) {
          if (chunk.usage) {
            gotUsage = true;
            const prompt = chunk.usage.prompt_tokens ?? 0;
            const completion = chunk.usage.completion_tokens ?? Math.max(0, (chunk.usage.total_tokens ?? 0) - prompt);
            budget.addUsage(prompt, completion, cachedInputTokens(chunk.usage));
            yield {
              type: "usage",
              totalTokens: chunk.usage.total_tokens,
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta as
            | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
                reasoning_content?: string;
                reasoning?: string;
              })
            | undefined;
          if (!delta) continue;
          const reasoningText = delta.reasoning_content || delta.reasoning;
          if (reasoningText) {
            if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !reasoningText.startsWith("\n")) {
              const sep = "\n\n";
              finalThinking += sep;
              yield { type: "thinking", text: sep };
            }
            stepHasThinking = true;
            thinking += reasoningText;
            yield { type: "thinking", text: reasoningText };
          }
          if (delta.content) {
            if (!stepHasText && finalContent && !finalContent.endsWith("\n") && !delta.content.startsWith("\n")) {
              const sep = "\n\n";
              finalContent += sep;
              yield { type: "text", text: sep };
            }
            stepHasText = true;
            content += delta.content;
            yield { type: "text", text: delta.content };
          }
          if (delta.tool_calls) {
            toolCallChunkCount += delta.tool_calls.length;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const buf = argBuffers.get(idx) ?? { args: "" };
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;
              argBuffers.set(idx, buf);
            }
          }
        }
      } catch (err) {
        if (signal?.aborted || drops >= STREAM_DROP_RETRIES || !isConnectionDrop(err)) throw err;
        drops++;
        void log("warn", `LLM step ${step}: conexão caiu no meio da resposta; repetindo o passo (${drops}/${STREAM_DROP_RETRIES}): ${describeApiError(err)}`);
        yield { type: "retry", message: `⚠️ a conexão caiu; repetindo (${drops}/${STREAM_DROP_RETRIES})...` };
        await wait(STREAM_DROP_RETRY_DELAY_MS * drops, signal);
        throwIfAborted(signal);
        continue;
      } finally {
        detachRequestAbort();
      }
      // The SDK ends the iteration silently on abort: without this, a cancelled response would
      // count as finished and the tool calls received so far would still run.
      throwIfAborted(signal);
      // A provider without usage in the stream still spends tokens: estimate them.
      if (!gotUsage) {
        const written = content.length + thinking.length + [...argBuffers.values()].reduce((n, b) => n + b.args.length, 0);
        budget.addUsage(estimateTokens(JSON.stringify(working)), Math.ceil(written / 3.5));
      }

      // Only thinking, cut at the output limit: there is no answer to continue, and "continue"
      // would think the same again.
      if (finishReason === "length" && !content && argBuffers.size === 0 && thinking && !lowered && canLowerReasoning()) {
        lowered = true;
        void log("warn", `LLM step ${step}: limite de saída gasto só com raciocínio (${thinking.length} chars); repetindo com menos raciocínio`);
        yield { type: "retry", message: "🧠 o modelo gastou o limite de saída pensando; repetindo com menos pensamento..." };
        continue;
      }
      break;
    }

    void log("info", `LLM step ${step}: finish_reason=${finishReason}, argBuffers=${argBuffers.size}, toolCallChunks=${toolCallChunkCount}`);

    for (const [, buf] of argBuffers) {
      if (buf.name) pendingCalls.push({ id: buf.id ?? `call_${Math.random().toString(36).slice(2)}`, name: buf.name, args: buf.args });
    }

    finalContent += content;
    finalThinking += thinking;

    void log("info", `LLM step ${step}: pendingCalls=${pendingCalls.length}, content=${content.length}chars`);

    if (pendingCalls.length === 0) {
      if (finishReason === "tool_calls") {
        // O modelo sinalizou tool_calls mas nenhum foi parseado — log para diagnóstico
        void log("warn", `LLM step ${step}: finish_reason=tool_calls mas 0 calls parseados. argBuffers raw: ${JSON.stringify(Object.fromEntries(argBuffers))}`);
      }
      if (finishReason === "length" && !content && thinking) {
        // The thinking stays out of the history: it led to nothing.
        const notice = `[O modelo gastou todo o limite de ${outputLimit} tokens de saída pensando e não escreveu nada${lowered ? ", mesmo com menos pensamento" : ""}. Reduza o nível de pensamento ou divida o pedido em partes menores.]`;
        finalContent += (finalContent ? "\n\n" : "") + notice;
        yield { type: "text", text: notice };
        turn.push({ role: "assistant", content: notice });
        yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
        return;
      }
      if (content || thinking) {
        turn.push({ role: "assistant", content, ...(thinking ? { reasoning: thinking } : {}) });
      }
      if (finishReason === "length") {
        const notice = `[Resposta cortada: atingiu o limite de ${outputLimit} tokens de saída. Envie "continue" para prosseguir.]`;
        finalContent += (finalContent ? "\n\n" : "") + notice;
        yield { type: "text", text: notice };
      } else if (finishReason === null) {
        void log("warn", `LLM step ${step}: stream encerrado sem finish_reason`);
        const notice = `[Resposta interrompida: o provedor ou a conexão encerrou o stream antes do fim, e ela pode estar incompleta. Envie "continue" para prosseguir.]`;
        finalContent += (finalContent ? "\n\n" : "") + notice;
        yield { type: "text", text: notice };
      }
      yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
      return;
    }

    // Record the assistant tool-call message and execute.
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: content || "",
      toolCalls: pendingCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        // Broken JSON in the history can make a provider refuse every later request.
        function: { name: c.name, arguments: parseToolArgs(c.args) ? c.args : "{}" },
      })),
      // MiMo requires reasoning_content on the assistant message preceding tool results.
      ...(isXiaomiMimo ? { reasoning: thinking } : {}),
    };
    const stepMessages: ChatMessage[] = [];
    const record = (message: ChatMessage) => {
      history.push(message);
      turn.push(message);
      stepMessages.push(message);
    };
    record(assistantMsg);

    void log("info", `LLM step ${step}: executando ${pendingCalls.length} tool(s): ${pendingCalls.map(c => c.name).join(", ")}`);
    budget.steps++;
    // Nobody to ask at the limit: the model is told beforehand, so it can finish by itself.
    const landing = confirmContinue ? "" : budget.landingNotice();

    const stepMedia: MediaAttachment[] = [];
    for (const [index, call] of pendingCalls.entries()) {
      if (signal?.aborted) {
        // What already ran must not be forgotten: close the step so the turn can keep it.
        for (const skipped of pendingCalls.slice(index)) {
          record({ role: "tool", toolCallId: skipped.id, toolName: skipped.name, content: NOT_RUN_AFTER_CANCEL });
        }
        yield { type: "step", messages: stepMessages };
        throwIfAborted(signal);
      }
      void log("info", `LLM step ${step}: ->${call.name}(${call.args.slice(0, 200)})`);
      yield { type: "tool_call", id: call.id, name: call.name, args: call.args };
      const parsed = parseToolArgs(call.args);
      let result = "";
      let isError = false;
      if (!parsed) {
        result = invalidArgsMessage(call.name, finishReason, outputLimit);
        isError = true;
      } else {
        try {
          const r = await executeTool(call.name, parsed);
          // Here and not in each tool: MCP servers and subagents can return megabytes too.
          // Secrets go first, before truncation could cut one in half.
          result = await processToolOutput(redactKnownSecrets(String(r.result ?? ""), secrets));
          isError = r.isError;
          if (r.media) stepMedia.push(...r.media);
        } catch (err) {
          result = redactKnownSecrets(String(err), secrets);
          isError = true;
        }
        const verdict = loops.observe(call.name, parsed, result, isError);
        result += verdict.notice;
        if (verdict.stop) loopStop ??= verdict.stop;
      }
      if (landing && index === pendingCalls.length - 1) result += landing;
      void log(isError ? "warn" : "info", `LLM step ${step}: <- ${call.name} isError=${isError} result=${result.slice(0, 200)}`);
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      record({ role: "tool", toolCallId: call.id, toolName: call.name, content: result });
    }
    // After every result of the step: the API requires them right after the tool calls.
    if (stepMedia.length) {
      record({ role: "user", content: mediaNote(stepMedia), media: stepMedia });
    }
    yield { type: "step", messages: stepMessages };
    void log("info", `LLM step ${step}: histórico agora: ${history.length} mensagens`);
    // loop continues: model sees tool results and may respond or call again.
  }
}
