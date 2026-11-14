import OpenAI from "openai";
import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { askAfterSteps } from "./config.js";
import { compressHistory, contextBudget, estimateTokens, processToolOutput } from "./context.js";
import type { AppConfig, ChatMessage, MediaAttachment, McpTool, ReasoningLevel, StreamEvent, ToolResult } from "./types.js";
import { DEFAULT_REASONING, isExtendedReasoning, isXiaomiMimoEndpoint } from "./reasoning.js";
import { hasMediaData, mediaNote, pruneMedia, rejectMedia, userContent } from "./services/media.js";

export interface ChatOptions {
  config: AppConfig;
  messages: ChatMessage[];
  tools: McpTool[];
  reasoning: ReasoningLevel;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  signal?: AbortSignal;
  /**
   * Asked every `askAfterSteps` steps of one turn: true goes on. Without it (subagents), the
   * turn stops there, since nobody could answer.
   */
  confirmContinue?: (steps: number) => Promise<boolean>;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Abortado", "AbortError");
}

/** Result of the calls of a step that never ran: every call needs one, or the history is invalid. */
export const NOT_RUN_AFTER_CANCEL = "Não executada: o usuário cancelou o turno antes desta chamada.";

/** A connection that drops in the middle of a response: the step is requested again this many times. */
const STREAM_DROP_RETRIES = 2;
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

/** The same call with the same result this many times in one turn gets a warning in the result. */
export const REPEATED_CALL_WARNING_AT = 3;

/** JSON with sorted keys: the same arguments in another order are the same call. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Counts identical calls of a turn and returns the warning to append to the result, if any. A
 * different result starts the count again: running the tests after each edit, or checking a
 * background task, is not a loop.
 */
function repeatedCallWarning(
  repeats: Map<string, { digest: string; count: number }>,
  name: string,
  args: Record<string, unknown>,
  result: string
): string {
  const key = `${name}\0${canonicalJson(args)}`;
  const digest = createHash("sha256").update(result).digest("hex");
  const seen = repeats.get(key);
  const count = seen?.digest === digest ? seen.count + 1 : 1;
  repeats.set(key, { digest, count });
  if (count < REPEATED_CALL_WARNING_AT) return "";
  return `\n\n[Aviso: é a ${count}ª vez neste turno que você chama ${name} com os mesmos argumentos e recebe o mesmo resultado. Repetir não muda nada: mude de abordagem ou responda ao usuário com o que já tem.]`;
}

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal, confirmContinue } = opts;
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
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
  const historyBudget = Math.max(
    MIN_HISTORY_TOKENS,
    contextBudget(config.contextTokens) - estimateTokens(config.system ?? "") - estimateTokens(JSON.stringify(apiTools))
  );
  const turn: ChatMessage[] = [];
  let finalContent = "";
  let finalThinking = "";
  const checkpoint = askAfterSteps(config.askAfterSteps);
  const repeats = new Map<string, { digest: string; count: number }>();

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  // No step cap: a long task ends when the model answers without tools, on an error or when
  // the turn is cancelled. The history is re-compacted on every step, so it stays in budget.
  // Every `askAfterSteps` steps the user is asked whether to go on: a loop stops there.
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    if (checkpoint && step > 0 && step % checkpoint === 0) {
      const goOn = confirmContinue ? await confirmContinue(step) : false;
      throwIfAborted(signal);
      if (!goOn) {
        void log("warn", `LLM step ${step}: turno parado no limite de ${checkpoint} passos (askAfterSteps)`);
        const notice = confirmContinue
          ? `[Turno pausado a pedido do usuário depois de ${step} passos. Envie uma mensagem para continuar ou mudar o rumo.]`
          : `[Parado depois de ${step} passos sem uma resposta final.]`;
        finalContent += (finalContent ? "\n\n" : "") + notice;
        yield { type: "text", text: notice };
        turn.push({ role: "assistant", content: notice });
        yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
        return;
      }
    }
    const buildRequest = () =>
      buildOpenAIMessages(config, compressHistory(pruneMedia(history), historyBudget, { keepToolCallReasoning: isXiaomiMimo }));
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
      try {
        const chunks = withIdleTimeout(
          stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
          signal,
          () => requestController?.abort()
        );
        for await (const chunk of chunks) {
          if (chunk.usage) {
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
          result = await processToolOutput(String(r.result ?? ""));
          isError = r.isError;
          if (r.media) stepMedia.push(...r.media);
        } catch (err) {
          result = String(err);
          isError = true;
        }
        result += repeatedCallWarning(repeats, call.name, parsed, result);
      }
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
