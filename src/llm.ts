import OpenAI from "openai";
import { log } from "./logger.js";
import { CONTEXT_TOKEN_BUDGET, compressHistory, estimateTokens } from "./context.js";
import type { AppConfig, ChatMessage, MediaAttachment, McpTool, ReasoningLevel, StreamEvent, ToolResult } from "./types.js";
import { isXiaomiMimoEndpoint } from "./reasoning.js";
import { hasMediaData, mediaNote, pruneMedia, rejectMedia, userContent } from "./services/media.js";

export interface ChatOptions {
  config: AppConfig;
  messages: ChatMessage[];
  tools: McpTool[];
  reasoning: ReasoningLevel;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  signal?: AbortSignal;
}

export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  try {
    yield* streamOpenAI(opts);
  } catch (err) {
    if (isAbortError(err)) throw err;
    void log("error", `streamChat: ${describeApiError(err)}`);
    yield { type: "error", message: enrichError(err, opts.config) };
  }
}

function isAbortError(err: unknown): boolean {
  return (err instanceof Error && err.name === "AbortError") || /abort/i.test(String(err));
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

async function withConnectTimeout<T>(promise: Promise<T>, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      onTimeout?.();
      reject(new Error(`Sem resposta da API após ${STREAM_CONNECT_TIMEOUT_MS / 1000}s (timeout de conexão)`));
    }, STREAM_CONNECT_TIMEOUT_MS);

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
export const MAX_STEPS = 50;
// Keeps room for the conversation even when many MCP tools fill most of the context budget.
const MIN_HISTORY_TOKENS = 20_000;

const GENERIC_RETRY_DELAY_MS = 1000;

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

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal } = opts;
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const apiTools = buildOpenAITools(tools);
  const isXiaomiMimo = isXiaomiMimoEndpoint(config.baseURL);
  const effort = !isXiaomiMimo && reasoning !== "none" ? reasoning : undefined;
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
    CONTEXT_TOKEN_BUDGET - estimateTokens(config.system ?? "") - estimateTokens(JSON.stringify(apiTools))
  );
  const turn: ChatMessage[] = [];
  let finalContent = "";
  let finalThinking = "";

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  for (let step = 0; step < MAX_STEPS; step++) {
    throwIfAborted(signal);
    const buildRequest = () => buildOpenAIMessages(config, compressHistory(pruneMedia(history), historyBudget));
    let working = buildRequest();
    let content = "";
    let thinking = "";
    const pendingCalls: {
      id: string;
      name: string;
      args: string;
    }[] = [];
    const argBuffers = new Map<number, { id?: string; name?: string; args: string }>();

    let requestController: AbortController | undefined;
    let detachRequestAbort = () => {};
    const makeRequest = (withEffort: boolean) => {
      detachRequestAbort();
      requestController = new AbortController();
      if (signal?.aborted) requestController.abort();
      const onExternalAbort = () => requestController?.abort();
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      detachRequestAbort = () => signal?.removeEventListener("abort", onExternalAbort);
      return client.chat.completions.create(
        {
          model: config.model,
          messages: working,
          stream: true,
          [tokenParam]: outputLimit,
          stream_options: { include_usage: true },
          ...(withEffort && effort ? { reasoning_effort: effort } : {}),
          ...(isXiaomiMimo ? { thinking: { type: reasoning === "none" ? "disabled" : "enabled" } } : {}),
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: requestController.signal }
      );
    };

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

    let finishReason: string | null = null;
    let stepHasText = false;
    let stepHasThinking = false;
    let toolCallChunkCount = 0;

    try {
      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
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
      if (delta.reasoning_content) {
        if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !delta.reasoning_content.startsWith("\n")) {
          const sep = "\n\n";
          finalThinking += sep;
          yield { type: "thinking", text: sep };
        }
        stepHasThinking = true;
        thinking += delta.reasoning_content;
        yield { type: "thinking", text: delta.reasoning_content };
      } else if ((delta as { reasoning?: string }).reasoning) {
        const r = (delta as { reasoning?: string }).reasoning!;
        if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !r.startsWith("\n")) {
          const sep = "\n\n";
          finalThinking += sep;
          yield { type: "thinking", text: sep };
        }
        stepHasThinking = true;
        thinking += r;
        yield { type: "thinking", text: r };
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
    } finally {
      detachRequestAbort();
    }
    // The SDK ends the iteration silently on abort: without this, a cancelled response would
    // count as finished and the tool calls received so far would still run.
    throwIfAborted(signal);

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
    history.push(assistantMsg);
    turn.push(assistantMsg);

    void log("info", `LLM step ${step}: executando ${pendingCalls.length} tool(s): ${pendingCalls.map(c => c.name).join(", ")}`);

    const stepMedia: MediaAttachment[] = [];
    for (const call of pendingCalls) {
      throwIfAborted(signal);
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
          result = r.result;
          isError = r.isError;
          if (r.media) stepMedia.push(...r.media);
        } catch (err) {
          result = String(err);
          isError = true;
        }
      }
      void log(isError ? "warn" : "info", `LLM step ${step}: <- ${call.name} isError=${isError} result=${result.slice(0, 200)}`);
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      const toolMsg: ChatMessage = { role: "tool", toolCallId: call.id, toolName: call.name, content: result };
      history.push(toolMsg);
      turn.push(toolMsg);
    }
    // After every result of the step: the API requires them right after the tool calls.
    if (stepMedia.length) {
      const mediaMsg: ChatMessage = { role: "user", content: mediaNote(stepMedia), media: stepMedia };
      history.push(mediaMsg);
      turn.push(mediaMsg);
    }
    void log("info", `LLM step ${step}: histórico agora: ${history.length} mensagens`);
    // loop continues: model sees tool results and may respond or call again.
  }

  // Step budget exhausted: tell the user instead of ending silently.
  const notice = `[Limite de ${MAX_STEPS} passos de ferramentas atingido nesta mensagem. Envie "continue" para prosseguir.]`;
  finalContent += (finalContent ? "\n\n" : "") + notice;
  yield { type: "text", text: notice };
  yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
}
