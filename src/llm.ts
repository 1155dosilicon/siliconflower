import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.js";
import { compressHistory } from "./context.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent } from "./types.js";

export interface ChatOptions {
  config: AppConfig;
  messages: ChatMessage[];
  tools: McpTool[];
  reasoning: ReasoningLevel;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>;
  signal?: AbortSignal;
}

export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  try {
    if (opts.config.provider === "anthropic") {
      yield* streamAnthropic(opts);
    } else {
      yield* streamOpenAI(opts);
    }
  } catch (err) {
    void log("error", `streamChat: ${err instanceof Error ? err.message : String(err)}`);
    yield { type: "error", message: enrichError(err, opts.config) };
  }
}

function enrichError(err: unknown, config: AppConfig): string {
  const e = err as { message?: string; status?: number; status_code?: number; error?: { message?: string } };
  const status = e?.status ?? e?.status_code;
  const inner = e?.error?.message ?? e?.message ?? String(err);
  const hint =
    status === 404
      ? ` - 404: check PROVIDER (openai vs anthropic), the baseURL, and the model ID. SiliconFlow uses the "openai" variant and a baseURL ending in "/v1".`
      : status === 401
        ? " - 401: API key is invalid."
        : "";
  return `[${config.provider}] ${inner}${status ? ` (HTTP ${status})` : ""}${hint}`;
}

function anthropicBaseURL(baseURL: string): string {
  let u = baseURL.trim().replace(/\/+$/, "");
  u = u.replace(/\/v1$/, "");
  return u;
}

/* ----------------------------- OpenAI-compatible ----------------------------- */

function buildOpenAIMessages(
  config: AppConfig,
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (config.system) out.push({ role: "system", content: config.system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: m.content || "",
          tool_calls: m.toolCalls,
        });
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolName ?? "call",
      });
    }
  }
  return out;
}

function buildOpenAITools(tools: McpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? `MCP tool from "${t.server}"`,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

const STREAM_CONNECT_TIMEOUT_MS = 90_000;

async function withConnectTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
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

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal } = opts;
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const apiTools = buildOpenAITools(tools);
  const effort = reasoning !== "none" ? reasoning : undefined;
  let supportsEffort = true;

  const compressed = compressHistory(messages);
  let working = buildOpenAIMessages(config, compressed);
  let finalContent = "";
  let finalThinking = "";

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  for (let step = 0; step < 25; step++) {
    let content = "";
    let thinking = "";
    const pendingCalls: {
      id: string;
      name: string;
      args: string;
    }[] = [];
    const argBuffers = new Map<number, { id?: string; name?: string; args: string }>();

    const makeRequest = (withEffort: boolean) =>
      client.chat.completions.create(
        {
          model: config.model,
          messages: working,
          stream: true,
          stream_options: { include_usage: true },
          ...(withEffort && effort ? { reasoning_effort: effort } : {}),
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        },
        { signal }
      );

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      void log("info", `LLM step ${step}: conectando (timeout=${STREAM_CONNECT_TIMEOUT_MS / 1000}s)`);
      stream = await withConnectTimeout(makeRequest(supportsEffort), signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (supportsEffort && effort && /reasoning/i.test(msg)) {
        supportsEffort = false;
        stream = await withConnectTimeout(makeRequest(false), signal); // retry without reasoning_effort
      } else {
        throw err;
      }
    }
    void log("info", `LLM step ${step}: stream conectado`);

    let finishReason: string | null = null;
    let stepHasText = false;
    let stepHasThinking = false;

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
        void log("info", `LLM step ${step}: tool_call chunk recebido (${delta.tool_calls.length} parciais)`);
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

    void log("info", `LLM step ${step}: finish_reason=${finishReason}, argBuffers=${argBuffers.size}`);

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
      yield { type: "done", content: finalContent, reasoning: finalThinking };
      return;
    }

    // Record the assistant tool-call message and execute.
    working.push({
      role: "assistant",
      content: content || "",
      tool_calls: pendingCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);

    void log("info", `LLM step ${step}: executando ${pendingCalls.length} tool(s): ${pendingCalls.map(c => c.name).join(", ")}`);

    for (const call of pendingCalls) {
      void log("info", `LLM step ${step}: -> ${call.name}(${call.args.slice(0, 200)})`);
      yield { type: "tool_call", id: call.id, name: call.name, args: call.args };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        parsed = { _raw: call.args };
      }
      let result = "";
      let isError = false;
      try {
        const r = await executeTool(call.name, parsed);
        result = r.result;
        isError = r.isError;
      } catch (err) {
        result = String(err);
        isError = true;
      }
      void log(isError ? "warn" : "info", `LLM step ${step}: <- ${call.name} isError=${isError} result=${result.slice(0, 200)}`);
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      working.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
    }
    void log("info", `LLM step ${step}: working messages agora: ${working.length}`);
    // loop continues: model sees tool results and may respond or call again.
  }

  // If we exhausted all steps without a done event, yield one with accumulated content
  yield { type: "done", content: finalContent || "", reasoning: finalThinking || "" };
}

/* -------------------------------- Anthropic -------------------------------- */

function buildAnthropicMessages(
  messages: ChatMessage[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content += "\n\n" + m.content;
        } else if (Array.isArray(last.content)) {
          last.content.push({ type: "text", text: m.content });
        }
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        if (typeof last.content === "string") {
          last.content += "\n\n" + m.content;
        }
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      const toolBlock: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolName ?? "call",
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        if (Array.isArray(last.content)) {
          (last.content as Anthropic.ContentBlock[]).push(toolBlock as unknown as Anthropic.ContentBlock);
        } else if (typeof last.content === "string") {
          last.content = [
            ...(last.content ? [{ type: "text" as const, text: last.content }] : []),
            toolBlock as unknown as Anthropic.ContentBlock,
          ];
        }
      } else {
        out.push({
          role: "user",
          content: [toolBlock as unknown as Anthropic.ContentBlock],
        });
      }
    }
  }
  return out;
}

function buildAnthropicTools(tools: McpTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? `MCP tool from "${t.server}"`,
    input_schema: (t.inputSchema as Anthropic.Tool.InputSchema) ?? {
      type: "object" as const,
      properties: {},
    },
  }));
}

async function* streamAnthropic(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal } = opts;
  const client = new Anthropic({ baseURL: anthropicBaseURL(config.baseURL), apiKey: config.apiKey });
  const apiTools = buildAnthropicTools(tools);
  const ANTHROPIC_REASONING_BUDGET: Record<Exclude<ReasoningLevel, "none">, number> = {
    low: 2048,
    medium: 6000,
    high: 12000,
  };
  const effort = reasoning !== "none" ? ANTHROPIC_REASONING_BUDGET[reasoning] : undefined;

  const compressed = compressHistory(messages);
  let working = buildAnthropicMessages(compressed);
  let finalContent = "";
  let finalThinking = "";

  for (let step = 0; step < 25; step++) {
    let content = "";
    let thinking = "";
    const pending: { id: string; name: string; input: Record<string, unknown> }[] = [];

    void log("info", `LLM step ${step}: conectando Anthropic (timeout=${STREAM_CONNECT_TIMEOUT_MS / 1000}s)`);
    const stream = client.messages.stream(
      {
        model: config.model,
        max_tokens: effort ? effort + 8192 : 8192,
        system: config.system,
        messages: working,
        ...(apiTools.length ? { tools: apiTools } : {}),
        ...(effort ? { thinking: { type: "enabled", budget_tokens: effort } } : {}),
      },
      { signal }
    );
    // Wait for first connection event with timeout
    const connectPromise = new Promise<void>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        stream.off("streamEvent", onDone);
        stream.off("connect", onDone);
        stream.off("message", onDone);
        stream.off("end", onDone);
        stream.off("error", onError);
        stream.off("abort", onError);
      };
      const onDone = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      stream.on("streamEvent", onDone);
      stream.on("connect", onDone);
      stream.on("message", onDone);
      stream.on("end", onDone);
      stream.on("error", onError);
      stream.on("abort", onError);
    });
    await withConnectTimeout(connectPromise, signal).catch((err) => {
      stream.abort();
      throw err;
    });
    void log("info", `LLM step ${step}: stream Anthropic conectado`);

    let stepHasText = false;
    let stepHasThinking = false;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const msg = (event as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message;
          if (msg?.usage) {
            yield {
              type: "usage",
              promptTokens: msg.usage.input_tokens,
              completionTokens: msg.usage.output_tokens,
              totalTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
            };
          }
          break;
        }
        case "message_delta": {
          const usage = (event as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            yield {
              type: "usage",
              completionTokens: usage.output_tokens,
            };
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            pending.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta as Anthropic.RawContentBlockDeltaEvent["delta"];
          if (d.type === "text_delta" && "text" in d) {
            if (!stepHasText && finalContent && !finalContent.endsWith("\n") && !d.text.startsWith("\n")) {
              const sep = "\n\n";
              finalContent += sep;
              yield { type: "text", text: sep };
            }
            stepHasText = true;
            content += d.text;
            yield { type: "text", text: d.text };
          } else if (d.type === "thinking_delta" && "thinking" in d) {
            if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !d.thinking.startsWith("\n")) {
              const sep = "\n\n";
              finalThinking += sep;
              yield { type: "thinking", text: sep };
            }
            stepHasThinking = true;
            thinking += d.thinking;
            yield { type: "thinking", text: d.thinking };
          }
          break;
        }
        default:
          break;
      }
    }

    await stream.finalMessage();

    finalContent += content;
    finalThinking += thinking;

    if (pending.length === 0) {
      yield { type: "done", content: finalContent, reasoning: finalThinking };
      return;
    }

    working.push({
      role: "assistant",
      content: [
        ...(content ? [{ type: "text" as const, text: content }] : []),
        ...pending.map((p) => ({
          type: "tool_use" as const,
          id: p.id,
          name: p.name,
          input: p.input,
        })),
      ],
    });

    for (const call of pending) {
      yield { type: "tool_call", id: call.id, name: call.name, args: JSON.stringify(call.input) };
      let result = "";
      let isError = false;
      try {
        const r = await executeTool(call.name, call.input);
        result = r.result;
        isError = r.isError;
      } catch (err) {
        result = String(err);
        isError = true;
      }
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      working.push({
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: result,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }

  // If we exhausted all steps without a done event, yield one with accumulated content
  yield { type: "done", content: finalContent || "", reasoning: finalThinking || "" };
}
