import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureDir } from "./fs-util.js";
import type { ChatMessage } from "./types.js";
import { log } from "./logger.js";

const OUTPUT_DIR = join(homedir(), ".siliconflower", "outputs");

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
 * If output exceeds maxChars (default 8000), saves the full output to a temp file
 * and returns a truncated version with a clear reference and total lines/size.
 */
export async function processToolOutput(output: string, maxChars = 32000): Promise<string> {
  if (output.length <= maxChars) {
    return output;
  }

  try {
    await ensureDir(OUTPUT_DIR);
    const filename = `output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    const fullPath = join(OUTPUT_DIR, filename);
    await writeFile(fullPath, output, "utf8");

    const lines = output.split("\n");
    const headLines = lines.slice(0, 100).join("\n");
    const tailLines = lines.slice(-50).join("\n");

    const msg = [
      `[SAÍDA GRANDE TRUNCADA: Mostrando ~150 linhas de ${lines.length} linhas (${output.length} caracteres)]`,
      `[Saída completa salva em: ${fullPath}]`,
      `--- INÍCIO DA SAÍDA ---`,
      headLines,
      `... (${lines.length - 150} linhas omitidas. Use read_file com offset e limit para ler partes intermediárias) ...`,
      tailLines,
      `--- FIM DA SAÍDA ---`,
    ].join("\n");

    await log("info", `Output de ferramenta salvo em ${fullPath} (${output.length} chars)`);
    return msg;
  } catch (err) {
    await log("warn", `Erro ao salvar output longo: ${String(err)}`);
    return output.slice(0, maxChars) + `\n... (truncado, ${output.length - maxChars} chars omitidos)`;
  }
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

  // Keep last 20 messages untouched
  const KEEP_RECENT = 20;
  if (messages.length <= KEEP_RECENT) {
    return messages;
  }

  const oldMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(messages.length - KEEP_RECENT);

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

  return [...compressedOld, ...recentMessages];
}
