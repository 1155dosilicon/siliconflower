import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import type { ChatMessage } from "./types.js";
import { log } from "./logger.js";

function outputDir(): string {
  return join(getGlobalDataDir(), "outputs");
}

/**
 * Formats a token count nicely (e.g. 850 -> "850", 1250 -> "1.3K", 35200 -> "35.2K").
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1000000).toFixed(2)}M`;
}

/** Measured on the Portuguese prompts: about 3.4 with cl100k_base, 3.9 with o200k_base. */
const CHARS_PER_TOKEN = 3.5;

/** Everything sent in one request should fit here: system prompt, tool schemas and history. */
export const CONTEXT_TOKEN_BUDGET = 90_000;

/**
 * Estimates token count for text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Rough value per file: the real cost depends on resolution and duration, which are not read here.
const MEDIA_TOKEN_ESTIMATE = 2000;

/**
 * Estimates token count for a message list.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.reasoning) total += estimateTokens(msg.reasoning);
    if (msg.media) total += msg.media.filter((a) => a.data).length * MEDIA_TOKEN_ESTIMATE;
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.function.name + tc.function.arguments);
      }
    }
  }
  return total;
}

/** Every tool result passes through processToolOutput in llm.ts, also MCP and subagents. */
export const MAX_TOOL_OUTPUT_CHARS = 32_000;
const TRUNCATED_HEADER = "[SAÍDA GRANDE TRUNCADA:";

/**
 * Handles large outputs from tools/commands.
 * If output exceeds maxChars (default 32000), saves the full output to a temp file
 * and returns a truncated version with a clear reference and total lines/size.
 * An output it already truncated is returned as is, so applying it twice is harmless.
 */
export async function processToolOutput(output: string, maxChars = MAX_TOOL_OUTPUT_CHARS): Promise<string> {
  if (output.length <= maxChars || output.startsWith(TRUNCATED_HEADER)) {
    return output;
  }

  const safeMaxChars = Number.isFinite(maxChars) ? Math.max(100, Math.floor(maxChars)) : 32000;
  const preview = buildBoundedPreview(output, safeMaxChars);

  try {
    const dir = outputDir();
    await ensureDir(dir);
    const filename = `output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    const fullPath = join(dir, filename);
    await writeFile(fullPath, output, "utf8");

    await log("info", `Output de ferramenta salvo em ${fullPath} (${output.length} chars)`);
    return `${preview.header}\n[Saída completa salva em: ${fullPath}]\n${preview.body}`;
  } catch (err) {
    await log("warn", `Erro ao salvar output longo: ${String(err)}`);
    return `${preview.header}\n[Não foi possível salvar a saída completa]\n${preview.body}`;
  }
}

function buildBoundedPreview(output: string, maxChars: number): { header: string; body: string } {
  const lines = output.split(/\r?\n/).length;
  const separator = `\n... (${output.length - maxChars} caracteres omitidos) ...\n`;
  const available = Math.max(0, maxChars - separator.length);
  const headSize = Math.ceil(available * 0.65);
  const tailSize = Math.max(0, available - headSize);
  const head = output.slice(0, headSize);
  const tail = tailSize > 0 ? output.slice(-tailSize) : "";
  return {
    header: `${TRUNCATED_HEADER} ${lines} linhas, ${output.length} caracteres]`,
    body: `--- INÍCIO DA SAÍDA ---\n${head}${separator}${tail}\n--- FIM DA SAÍDA ---`,
  };
}

const SHRINK_ABOVE_CHARS = 160;
const SHRUNK_CHARS = 120;
// Enough for the provider to accept the message; the full text only matters for display.
const KEPT_REASONING_CHARS = 400;
const MAX_SHRUNK_ITEMS = 20;
const MAX_SHRUNK_DEPTH = 3;

export interface CompressOptions {
  /** Xiaomi MiMo requires reasoning_content on the assistant message that precedes tool results. */
  keepToolCallReasoning?: boolean;
}

function shorten(text: string, max: number, note: string): string {
  return text.length > max ? `${text.slice(0, max)}${note}` : text;
}

/**
 * Shortens the long values of a tool call's arguments. The result is always a JSON object:
 * cutting the text itself leaves broken JSON, which makes providers refuse every later request.
 */
export function shrinkToolArguments(raw: string): string {
  if (raw.length <= SHRINK_ABOVE_CHARS) return raw;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "{}";
  }
  const shrink = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return shorten(v, SHRUNK_CHARS, "... [reduzido]");
    if (Array.isArray(v)) return depth >= MAX_SHRUNK_DEPTH ? [] : v.slice(0, MAX_SHRUNK_ITEMS).map((x) => shrink(x, depth + 1));
    if (v && typeof v === "object") {
      if (depth >= MAX_SHRUNK_DEPTH) return {};
      return Object.fromEntries(Object.entries(v).slice(0, MAX_SHRUNK_ITEMS).map(([k, x]) => [k, shrink(x, depth + 1)]));
    }
    return v;
  };
  const shrunk = shrink(value, 0);
  return shrunk && typeof shrunk === "object" && !Array.isArray(shrunk) ? JSON.stringify(shrunk) : "{}";
}

function shrinkMessage(message: ChatMessage): void {
  if (message.content.length > SHRINK_ABOVE_CHARS) {
    message.content = `${message.content.slice(0, SHRUNK_CHARS)}\n... [conteúdo reduzido por limite de contexto]`;
  }
  if (message.toolCalls) {
    message.toolCalls = message.toolCalls.map((call) => ({
      ...call,
      function: { ...call.function, arguments: shrinkToolArguments(call.function.arguments) },
    }));
  }
}

/** The user's request being worked on: the last user message that is not a media attachment. */
function currentRequestIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user" && !messages[i]!.media) return i;
  }
  return -1;
}

/**
 * Compresses chat history when token threshold is reached or message count is high.
 * Keeps system/recent messages intact, compresses old tool outputs.
 */
export function compressHistory(messages: ChatMessage[], maxTokens = CONTEXT_TOKEN_BUDGET, opts: CompressOptions = {}): ChatMessage[] {
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= maxTokens && messages.length <= 40) {
    return messages;
  }
  const keepsReasoning = (message: ChatMessage) => Boolean(opts.keepToolCallReasoning && message.toolCalls?.length);

  // Preserve message ordering/protocol while progressively reducing oversized content.
  const KEEP_RECENT = 20;
  const splitAt = Math.max(0, messages.length - KEEP_RECENT);
  const oldMessages = messages.slice(0, splitAt);
  const recentMessages = messages.slice(splitAt);

  const compressedOld: ChatMessage[] = oldMessages.map((msg) => {
    if (msg.role === "tool" && msg.content.length > 500) {
      return {
        ...msg,
        content: msg.content.slice(0, 300) + `\n... [Resultado antigo de ferramenta reduzido (${msg.content.length} chars)]`,
      };
    }
    if (msg.role === "assistant" && msg.content.length > 1500) {
      return {
        ...msg,
        content: msg.content.slice(0, 1000) + `\n... [Resposta antiga reduzida]`,
        reasoning: keepsReasoning(msg) ? msg.reasoning : undefined,
      };
    }
    return msg;
  });

  const result = [...compressedOld, ...recentMessages].map((message) => ({ ...message }));
  if (estimateMessagesTokens(result) <= maxTokens) return result;

  // Remove reasoning first; it is useful for display but not required for protocol continuity
  // (except on MiMo tool calls, where it stays, shortened).
  for (const message of result) {
    message.reasoning = keepsReasoning(message) && message.reasoning !== undefined
      ? shorten(message.reasoning, KEPT_REASONING_CHARS, "... [reduzido]")
      : undefined;
  }

  // Keep every message so tool-call role ordering remains valid, and shrink what the model
  // needs least first: tool results, then its own messages, then the user's. The request
  // being worked on goes last: without it the model loses the task.
  const request = currentRequestIndex(result);
  const indexes = (keep: (m: ChatMessage, i: number) => boolean) => result.flatMap((m, i) => (keep(m, i) ? [i] : []));
  const order = [
    ...indexes((m) => m.role === "tool"),
    ...indexes((m) => m.role === "assistant"),
    ...indexes((m, i) => m.role === "user" && i !== request),
    ...(request >= 0 ? [request] : []),
  ];
  let total = estimateMessagesTokens(result);
  for (const i of order) {
    if (total <= maxTokens) break;
    const message = result[i]!;
    const before = estimateMessagesTokens([message]);
    shrinkMessage(message);
    total += estimateMessagesTokens([message]) - before;
  }

  // If metadata and many small messages still exceed the budget, discard the oldest turns.
  // Discard whole turns at once: dropping only the leading "assistant" message of a
  // tool-call turn would leave an orphan "tool" message at the front, which breaks the
  // assistant(tool_calls) -> tool(result) pairing the OpenAI-compatible APIs require.
  while (total > maxTokens && result.length > 1) {
    total -= estimateMessagesTokens([result.shift()!]);
    while (result.length > 1 && result[0]!.role === "tool") {
      total -= estimateMessagesTokens([result.shift()!]);
    }
  }

  // A single recent message can exceed the whole context budget; bound it as a last resort.
  if (total > maxTokens && result.length === 1) {
    const last = result[0];
    last.reasoning = undefined;
    last.toolCalls = undefined;
    const charBudget = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
    last.content = last.content.slice(0, charBudget);
  }

  return result;
}
