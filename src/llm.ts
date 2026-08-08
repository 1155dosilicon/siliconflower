import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.js";
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
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content });
    else if (m.role === "tool") {
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

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal } = opts;
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const apiTools = buildOpenAITools(tools);
  const effort = reasoning !== "none" ? reasoning : undefined;

  let working = buildOpenAIMessages(config, messages);
  let finalContent = "";
  let finalThinking = "";

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  for (let step = 0; step < 8; step++) {
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
          ...(withEffort && effort ? { reasoning_effort: effort } : {}),
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        },
        { signal }
      );

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      stream = await makeRequest(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (effort && /reasoning/i.test(msg)) {
        stream = await makeRequest(false); // retry without reasoning_effort
      } else {
        throw err;
      }
    }

    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      const delta = chunk.choices?.[0]?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            reasoning_content?: string;
            reasoning?: string;
          })
        | undefined;
      if (!delta) continue;
      if (delta.reasoning_content) {
        thinking += delta.reasoning_content;
        yield { type: "thinking", text: delta.reasoning_content };
      } else if ((delta as { reasoning?: string }).reasoning) {
        thinking += (delta as { reasoning?: string }).reasoning!;
        yield { type: "thinking", text: (delta as { reasoning?: string }).reasoning! };
      }
      if (delta.content) {
        content += delta.content;
        yield { type: "text", text: delta.content };
      }
      if (delta.tool_calls) {
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

    for (const [, buf] of argBuffers) {
      if (buf.name) pendingCalls.push({ id: buf.id ?? `call_${Math.random().toString(36).slice(2)}`, name: buf.name, args: buf.args });
    }

    finalContent = content;
    finalThinking = thinking;

    if (pendingCalls.length === 0) {
      yield { type: "done", content, reasoning: thinking };
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

    for (const call of pendingCalls) {
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
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      working.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
    }
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
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content });
    else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolName ?? "call",
            content: m.content,
          },
        ] as Anthropic.ToolResultBlockParam[],
      });
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

  let working = buildAnthropicMessages(messages);
  let finalContent = "";
  let finalThinking = "";

  for (let step = 0; step < 8; step++) {
    let content = "";
    let thinking = "";
    const pending: { id: string; name: string; input: Record<string, unknown> }[] = [];

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

    for await (const event of stream) {
      switch (event.type) {
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
            content += d.text;
            yield { type: "text", text: d.text };
          } else if (d.type === "thinking_delta" && "thinking" in d) {
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

    finalContent = content;
    finalThinking = thinking;

    if (pending.length === 0) {
      yield { type: "done", content, reasoning: thinking };
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
