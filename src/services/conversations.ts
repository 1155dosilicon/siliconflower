import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, TodoItem } from "../types.js";

const VALID_ID = /^[a-z0-9-]{1,64}$/;
const HEADER_MAX_BYTES = 16 * 1024;
const RENAME_ATTEMPTS = 5;
const TITLE_MAX_CHARS = 80;

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface ToolActivity {
  /** Unique in this session, unlike `id`, which comes from the provider. */
  key: number;
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  /** Number of messages already shown when the tool ran: places the card in the timeline. */
  afterMessage: number;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

export interface ConversationBody {
  /** API history, always made of complete turns. */
  history: ChatMessage[];
  messages: StoredMessage[];
  activities: ToolActivity[];
  todos: TodoItem[];
}

export function conversationTitle(firstMessage: string): string {
  const line = firstMessage.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return "Conversa";
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 3)}...` : line;
}

/**
 * Every assistant message with tool calls must be followed by their results, or the API
 * rejects the whole conversation. Cuts the history at the first turn that breaks this.
 */
export function completeHistory(history: ChatMessage[]): ChatMessage[] {
  let end = 0;
  let i = 0;
  while (i < history.length) {
    const message = history[i]!;
    if (message.role === "tool") break; // a result without its call
    i++;
    if (message.toolCalls?.length) {
      const wanted = new Set(message.toolCalls.map((call) => call.id));
      while (i < history.length && history[i]!.role === "tool") {
        wanted.delete(history[i]!.toolCallId ?? "");
        i++;
      }
      if (wanted.size) break;
    }
    end = i;
  }
  return history.slice(0, end);
}

function isSummary(value: any): value is ConversationSummary {
  return (
    typeof value?.id === "string" &&
    VALID_ID.test(value.id) &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.messageCount === "number"
  );
}

/**
 * The conversations of one project, one `<id>.jsonl` file each: a line with the summary, so
 * listing does not read whole histories, and a line with the content. Files are replaced
 * atomically, so a crash in the middle of a save keeps the previous version.
 */
export class ConversationStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    // The id comes from the page: it must never leave this folder.
    if (!VALID_ID.test(id)) throw new Error(`id de conversa inválido: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  private async readHeader(name: string): Promise<ConversationSummary | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(this.dir, name), "r");
      const buffer = Buffer.alloc(HEADER_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_MAX_BYTES, 0);
      const text = buffer.toString("utf8", 0, bytesRead);
      const end = text.indexOf("\n");
      if (end === -1) return null;
      const header: unknown = JSON.parse(text.slice(0, end));
      return isSummary(header) && `${header.id}.jsonl` === name ? header : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Most recent first. Damaged files are counted and left alone. */
  async list(): Promise<{ items: ConversationSummary[]; damaged: number }> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return { items: [], damaged: 0 }; // no conversation saved yet
    }
    const headers = await Promise.all(names.map((name) => this.readHeader(name)));
    const items = headers.filter((h): h is ConversationSummary => h !== null);
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items, damaged: headers.length - items.length };
  }

  /** Throws when the conversation does not exist or is damaged. */
  async load(id: string): Promise<ConversationBody> {
    const text = await readFile(this.file(id), "utf8");
    const end = text.indexOf("\n");
    if (end === -1) throw new Error("arquivo de conversa incompleto");
    const body = JSON.parse(text.slice(end + 1));
    if (!Array.isArray(body?.history) || !Array.isArray(body?.messages)) {
      throw new Error("arquivo de conversa em formato inválido");
    }
    return {
      history: completeHistory(body.history),
      messages: body.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string"),
      activities: Array.isArray(body.activities) ? body.activities : [],
      todos: Array.isArray(body.todos) ? body.todos : [],
    };
  }

  /** Saves run one at a time: two renames of the same file could otherwise cross. */
  save(summary: ConversationSummary, body: ConversationBody): Promise<void> {
    const write = async () => {
      const target = this.file(summary.id);
      await mkdir(this.dir, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(summary)}\n${JSON.stringify(body)}\n`, "utf8");
      await this.replace(temp, target);
    };
    const run = this.queue.then(write, write);
    this.queue = run.catch(() => {});
    return run;
  }

  /** An antivirus or indexer holding the old file makes the rename fail for a moment. */
  private async replace(temp: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
