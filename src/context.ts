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

/**
 * Estimates token count for text (~3.8 chars per token for code/Portuguese text mix).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

/**
 * Estimates token count for a message list.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.reasoning) total += estimateTokens(msg.reasoning);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.function.name + tc.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Handles large outputs from tools/commands.
 * If output exceeds maxChars (default 32000), saves the full output to a temp file
 * and returns a truncated version with a clear reference and total lines/size.
 */
export async function processToolOutput(output: string, maxChars = 32000): Promise<string> {
  if (output.length <= maxChars) {
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
    header: `[SAÍDA GRANDE TRUNCADA: ${lines} linhas, ${output.length} caracteres]`,
    body: `--- INÍCIO DA SAÍDA ---\n${head}${separator}${tail}\n--- FIM DA SAÍDA ---`,
  };
}

/**
 * Compresses chat history when token threshold is reached or message count is high.
 * Keeps system/recent messages intact, compresses old tool outputs.
 */
export function compressHistory(messages: ChatMessage[], maxTokens = 90000): ChatMessage[] {
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= maxTokens && messages.length <= 40) {
    return messages;
  }

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
        reasoning: undefined,
      };
    }
    return msg;
  });

  const result = [...compressedOld, ...recentMessages].map((message) => ({ ...message }));
  if (estimateMessagesTokens(result) <= maxTokens) return result;

  // Remove reasoning first; it is useful for display but not required for protocol continuity.
  for (const message of result) message.reasoning = undefined;

  // Shrink oldest content first, but keep every message so tool-call role ordering remains valid.
  for (let i = 0; i < result.length && estimateMessagesTokens(result) > maxTokens; i++) {
    const message = result[i];
    if (message.content.length > 160) {
      message.content = `${message.content.slice(0, 120)}\n... [conteúdo reduzido por limite de contexto]`;
    }
    if (message.toolCalls) {
      message.toolCalls = message.toolCalls.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: call.function.arguments.length > 160
            ? `${call.function.arguments.slice(0, 120)}...`
            : call.function.arguments,
        },
      }));
    }
  }

  // If metadata and many small messages still exceed the budget, discard the oldest turns.
  // Discard whole turns at once: dropping only the leading "assistant" message of a
  // tool-call turn would leave an orphan "tool" message at the front, which breaks the
  // assistant(tool_calls) -> tool(result) pairing the OpenAI-compatible APIs require.
  while (estimateMessagesTokens(result) > maxTokens && result.length > 1) {
    result.shift();
    while (result.length > 1 && result[0].role === "tool") {
      result.shift();
    }
  }

  // A single recent message can exceed the whole context budget; bound it as a last resort.
  if (estimateMessagesTokens(result) > maxTokens && result.length === 1) {
    const last = result[0];
    last.reasoning = undefined;
    last.toolCalls = undefined;
    const charBudget = Math.max(0, Math.floor(maxTokens * 3.8));
    last.content = last.content.slice(0, charBudget);
  }

  return result;
}
