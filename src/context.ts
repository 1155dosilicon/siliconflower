import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import type { ChatMessage, TodoItem } from "./types.js";
import { log } from "./logger.js";
import { isToolMediaMessage } from "./services/media.js";

function outputDir(): string {
  return join(getGlobalDataDir(), "outputs");
}

const OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let outputsPruned = false;

/** Full outputs are only useful for the conversation that produced them: old ones are deleted. */
export async function pruneOldOutputs(now = Date.now(), maxAgeMs = OUTPUT_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  try {
    const dir = outputDir();
    for (const name of await readdir(dir)) {
      if (!/^output_.*\.txt$/.test(name)) continue;
      const file = join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await rm(file, { force: true });
        removed++;
      }
    }
  } catch {
    // No folder yet, or no permission: nothing to clean.
  }
  return removed;
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
// Accented Latin letters (Portuguese included) cost more than plain ASCII but far less than CJK.
const LATIN_CHARS_PER_TOKEN = 2;
// Cyrillic, Greek, Arabic, Hebrew, CJK, emoji: these can cost a full token per character.
const WIDE_CHAR_START = 0x250;

/** Everything sent in one request should fit here: system prompt, tool schemas and history. */
export const CONTEXT_TOKEN_BUDGET = 90_000;
export const MIN_CONTEXT_TOKENS = 8_000;
export const MAX_CONTEXT_TOKENS = 2_000_000;

/** `contextTokens` of config.json, bounded; the default when absent or not a number. */
export function contextBudget(value: unknown): number {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n)
    ? Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.floor(n)))
    : CONTEXT_TOKEN_BUDGET;
}

/**
 * Estimates token count for text.
 *
 * A single ratio over `text.length` silently undercounts anything that is not ASCII: a file
 * full of CJK or emoji costs about one token per character, not one per 3.5, so a 90K budget
 * could turn into a request the provider refuses. Non-Latin text is counted heavier on
 * purpose: an estimate below the real size overflows the window, one above only compacts early.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let latin = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < WIDE_CHAR_START) latin++;
    // Surrogate halves of an emoji count as two, which errs on the safe side again.
    else wide++;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + Math.ceil(latin / LATIN_CHARS_PER_TOKEN) + wide;
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
    if (!outputsPruned) {
      outputsPruned = true; // once per process, before the first new file
      await pruneOldOutputs();
    }
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
// The plan in the compaction note stays short: a note longer than the history it replaces is useless.
const MAX_PLAN_LINES_IN_NOTE = 12;
// Enough for the provider to accept the message; the full text only matters for display.
const KEPT_REASONING_CHARS = 400;
const MAX_SHRUNK_ITEMS = 20;
const MAX_SHRUNK_DEPTH = 3;

export interface CompressOptions {
  /** Xiaomi MiMo requires reasoning_content on the assistant message that precedes tool results. */
  keepToolCallReasoning?: boolean;
  /** Current plan (`todowrite`): it is the one thing the model cannot rebuild from the files. */
  plan?: TodoItem[];
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
    // Only results of earlier steps get here: the model saw them, so it should not ask again.
    const note = message.role === "tool"
      ? "[resultado já visto num passo anterior, reduzido por limite de contexto]"
      : "[conteúdo reduzido por limite de contexto]";
    message.content = `${message.content.slice(0, SHRUNK_CHARS)}\n... ${note}`;
  }
  if (message.toolCalls) {
    message.toolCalls = message.toolCalls.map((call) => ({
      ...call,
      function: { ...call.function, arguments: shrinkToolArguments(call.function.arguments) },
    }));
  }
}

/** The user's request being worked on: the last user message that is not a read_media attachment. */
function currentRequestIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user" && !isToolMediaMessage(messages[i]!)) return i;
  }
  return -1;
}

/**
 * The results of the step that just ran, at the end of the history (only the step's media note
 * may come after them). The model has not seen them yet: cutting them to a few characters made
 * it read the same files again and again.
 */
function unseenResultIndexes(messages: ChatMessage[]): number[] {
  let i = messages.length - 1;
  while (i >= 0 && isToolMediaMessage(messages[i]!)) i--;
  const indexes: number[] = [];
  for (; i >= 0 && messages[i]!.role === "tool"; i--) indexes.unshift(i);
  return indexes.length && messages[i]?.role === "assistant" && messages[i]!.toolCalls?.length ? indexes : [];
}

// Room kept in a cut result for the note that says how to get the rest.
const CUT_NOTE_CHARS = 320;
// Below this share per unseen result, the request is shortened first (it is usually short, but
// it can be a huge paste).
const MIN_UNSEEN_TOKENS = 300;

const lineNumberOf = (line: string): number | undefined => {
  const match = /^(\d+): /.exec(line);
  return match ? Number(match[1]) : undefined;
};

/** Where to go on in a read_file result ("N: text" lines) cut after `kept`. */
function readFileCutNote(content: string, kept: string): string | undefined {
  const first = lineNumberOf(content);
  if (first === undefined) return undefined; // an error message, not lines of the file
  const keptLines = kept ? kept.split("\n") : [];
  const lastLineWhole = content[kept.length] === "\n";
  let next = first;
  for (let i = keptLines.length - 1; i >= 0; i--) {
    const n = lineNumberOf(keptLines[i]!);
    if (n === undefined) continue;
    next = i === keptLines.length - 1 && !lastLineWhole ? n : n + 1;
    break;
  }
  const allLines = content.split("\n");
  let lastRead = first;
  for (let i = allLines.length - 1; i >= 0; i--) {
    const n = lineNumberOf(allLines[i]!);
    if (n !== undefined) {
      lastRead = n;
      break;
    }
  }
  const shown = next > first
    ? `só couberam as linhas ${first}–${next - 1} das ${first}–${lastRead} lidas`
    : kept ? `só coube o começo da linha ${first}` : "não coube nenhuma linha";
  return `[resultado cortado para caber no contexto: ${shown}. Para o resto, chame read_file com offset=${next} e um limit menor, ou leia um arquivo por vez.]`;
}

/**
 * The start of a result the model has not seen, in at most about `maxChars`, ending at a line
 * break when there is one, and a note that says how to get the rest.
 */
export function cutUnseenResult(content: string, toolName: string | undefined, maxChars: number): string {
  if (content.length <= maxChars) return content;
  let kept = content.slice(0, Math.max(0, maxChars - CUT_NOTE_CHARS));
  const lastBreak = kept.lastIndexOf("\n");
  if (lastBreak > 0 && lastBreak >= kept.length / 2) kept = kept.slice(0, lastBreak);
  const note = (toolName === "read_file" ? readFileCutNote(content, kept) : undefined)
    ?? `[resultado cortado para caber no contexto: mostrados ${kept.length} de ${content.length} caracteres. Para ver o resto, peça uma parte menor (filtre a saída ou use offset e limit, se a ferramenta tiver) ou faça uma chamada por vez.]`;
  return kept ? `${kept}\n... ${note}` : note;
}

/**
 * Fits the unseen results in `roomTokens`: the small ones stay whole and the large ones share
 * the rest equally, instead of each becoming a few characters.
 */
function fitUnseenResults(messages: ChatMessage[], indexes: number[], roomTokens: number): void {
  // estimateTokens rounds each message up.
  let room = Math.max(0, Math.floor((roomTokens - indexes.length) * CHARS_PER_TOKEN));
  const bySize = [...indexes].sort((a, b) => messages[a]!.content.length - messages[b]!.content.length);
  for (const [k, i] of bySize.entries()) {
    const message = messages[i]!;
    const share = Math.floor(room / (bySize.length - k));
    message.content = cutUnseenResult(message.content, message.toolName, share);
    room = Math.max(0, room - message.content.length);
  }
}

/**
 * What was dropped from the start of the history, said to the model. It cannot tell that the
 * conversation was cut, and "I do not have that" reads as "it was never asked" instead of
 * "read it again" — which is what made old turns get redone step by step.
 */
function compactionNote(dropped: number, plan: TodoItem[] = []): ChatMessage {
  const open = plan.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  // The plan can be long, but it is the cheapest summary of a turn there is: one line each.
  const planText = open.length
    ? `\nPlano em andamento (a lista de tarefas da sessão, mantida fora do histórico):\n${open
        .slice(0, MAX_PLAN_LINES_IN_NOTE)
        .map((item) => `- [${item.status === "in_progress" ? "em andamento" : "pendente"}] ${item.content.slice(0, 160)}`)
        .join("\n")}${open.length > MAX_PLAN_LINES_IN_NOTE ? `\n- ... e mais ${open.length - MAX_PLAN_LINES_IN_NOTE}` : ""}\n`
    : "";
  return {
    role: "user",
    content:
      `[compactação] O começo desta conversa (${dropped} mensagens) foi descartado para caber no contexto. ` +
      "O que já foi feito continua valendo: não refaça o que está pronto. Se precisar de algo que foi " +
      "descartado, use as ferramentas de novo (ler o arquivo, rodar o comando) em vez de supor." +
      planText,
  };
}

/**
 * Compresses chat history when the token budget is exceeded.
 * Keeps system/recent messages intact, compresses old tool outputs.
 */
export function compressHistory(messages: ChatMessage[], maxTokens = CONTEXT_TOKEN_BUDGET, opts: CompressOptions = {}): ChatMessage[] {
  // Only the token budget decides: a count of messages says nothing about their size, and
  // cutting old tool results in a small conversation makes the model forget what it read.
  if (estimateMessagesTokens(messages) <= maxTokens) {
    return messages;
  }
  const keepsReasoning = (message: ChatMessage) => Boolean(opts.keepToolCallReasoning && message.toolCalls?.length);

  // Preserve message ordering/protocol while progressively reducing oversized content.
  const KEEP_RECENT = 20;
  const unseen = unseenResultIndexes(messages);
  // The step being answered is never old, however many calls it made.
  const stepStart = unseen.length ? unseen[0]! - 1 : messages.length;
  const splitAt = Math.max(0, Math.min(messages.length - KEEP_RECENT, stepStart));
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
  // needs least first: tool results it already saw, then its own messages, then the user's.
  // The results of the step that just ran come next, cut to a share each instead of a few
  // characters, and the request being worked on goes last: without it the model loses the task.
  const request = currentRequestIndex(result);
  const isUnseen = new Set(unseen);
  const indexes = (keep: (m: ChatMessage, i: number) => boolean) => result.flatMap((m, i) => (keep(m, i) ? [i] : []));
  const order = [
    ...indexes((m, i) => m.role === "tool" && !isUnseen.has(i)),
    ...indexes((m) => m.role === "assistant"),
    ...indexes((m, i) => m.role === "user" && i !== request),
  ];
  let total = estimateMessagesTokens(result);
  let requestShrunk = false;
  const shrinkAt = (i: number) => {
    const message = result[i]!;
    const before = estimateMessagesTokens([message]);
    shrinkMessage(message);
    total += estimateMessagesTokens([message]) - before;
    if (i === request) requestShrunk = true;
  };
  for (const i of order) {
    if (total <= maxTokens) break;
    shrinkAt(i);
  }
  if (total > maxTokens && unseen.length) {
    const unseenTokens = () => estimateMessagesTokens(unseen.map((i) => result[i]!));
    if (request >= 0 && maxTokens - (total - unseenTokens()) < unseen.length * MIN_UNSEEN_TOKENS) shrinkAt(request);
    const others = total - unseenTokens();
    fitUnseenResults(result, unseen, maxTokens - others);
    total = others + unseenTokens();
  }
  if (total > maxTokens && request >= 0 && !requestShrunk) shrinkAt(request);

  let dropped = 0;
  // If metadata and many small messages still exceed the budget, discard the oldest turns.
  // Discard whole turns at once: dropping only the leading "assistant" message of a
  // tool-call turn would leave an orphan "tool" message at the front, which breaks the
  // assistant(tool_calls) -> tool(result) pairing the OpenAI-compatible APIs require.
  // Discarding costs a few tokens for the note that says so: count it from the first drop,
  // but never drop anything to make room for a note that would not exist otherwise.
  const noteSize = estimateMessagesTokens([compactionNote(messages.length, opts.plan)]);
  while (total > maxTokens && result.length > 1) {
    total -= estimateMessagesTokens([result.shift()!]);
    dropped++;
    while (result.length > 1 && result[0]!.role === "tool") {
      total -= estimateMessagesTokens([result.shift()!]);
      dropped++;
    }
    total += dropped === 1 ? noteSize : 0;
  }

  // Discarding is not silent: the model has to know what it lost to go and look again.
  if (dropped > 0) result.unshift(compactionNote(dropped, opts.plan));

  // A single recent message can exceed the whole context budget; bound it as a last resort.
  if (total > maxTokens && result.length <= 2) {
    const last = result[result.length - 1]!;
    last.reasoning = undefined;
    last.toolCalls = undefined;
    const charBudget = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
    last.content = last.content.slice(0, charBudget);
  }

  return result;
}
