import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeHistory, conversationTitle, ConversationStore, type ConversationBody } from "../src/services/conversations.js";
import { AgentSession } from "../src/session.js";
import { getTodos, setTodos } from "../src/todo.js";
import type { AppConfig, ChatMessage, StreamEvent } from "../src/types.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-conv-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONFIG: AppConfig = { baseURL: "http://127.0.0.1:9/v1", apiKey: "chave-que-nao-pode-ir-para-o-disco", model: "teste", reasoning: "none", mcpServers: {} };
const emptyBody = (): ConversationBody => ({ history: [{ role: "user", content: "oi" }], messages: [{ role: "user", content: "oi" }], activities: [], todos: [] });
const summary = (id: string, updatedAt = "2026-01-01T00:00:00.000Z") => ({ id, title: `t-${id}`, updatedAt, messageCount: 1 });

function echoStream(): any {
  return async function* (opts: { messages: ChatMessage[] }): AsyncGenerator<StreamEvent> {
    const text = String(opts.messages.at(-1)?.content);
    yield { type: "text", text: `eco: ${text}` };
    yield { type: "done", content: `eco: ${text}`, reasoning: "", messages: [{ role: "assistant", content: `eco: ${text}` }] };
  };
}

describe("conversation history on disk", () => {
  test("cuts the history at a turn left without its tool results", () => {
    const call = (id: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, type: "function", function: { name: "x", arguments: "{}" } }] });
    const ok: ChatMessage[] = [{ role: "user", content: "a" }, call("1"), { role: "tool", content: "r", toolCallId: "1" }, { role: "assistant", content: "b" }];
    expect(completeHistory(ok)).toEqual(ok);
    expect(completeHistory([...ok, { role: "user", content: "c" }, call("2")])).toEqual([...ok, { role: "user", content: "c" }]);
    expect(completeHistory([{ role: "tool", content: "r", toolCallId: "9" }])).toEqual([]);
  });

  test("title is the first line, clipped", () => {
    expect(conversationTitle("\n  corrige o bug\nsegunda linha")).toBe("corrige o bug");
    expect(conversationTitle("x".repeat(200))).toHaveLength(80);
    expect(conversationTitle("")).toBe("Conversa");
  });

  test("lists the latest first and leaves no temporary file", async () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    await store.save(summary("a", "2026-01-01T00:00:00.000Z"), emptyBody());
    await store.save(summary("b", "2026-02-01T00:00:00.000Z"), emptyBody());
    expect((await store.list()).items.map((c) => c.id)).toEqual(["b", "a"]);
    expect(readdirSync(dir).sort()).toEqual(["a.jsonl", "b.jsonl"]);
    expect((await store.load("a")).messages).toHaveLength(1);
  });

  test("simultaneous saves of one conversation do not corrupt it", async () => {
    const store = new ConversationStore(tempDir());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(summary("a"), { ...emptyBody(), messages: [{ role: "user", content: String(i) }] })));
    expect((await store.load("a")).messages[0]!.content).toBe("19");
  });

  test("a folder that does not exist yet is an empty list", async () => {
    expect(await new ConversationStore(join(tempDir(), "nada")).list()).toEqual({ items: [], damaged: 0 });
  });

  test("the page cannot reach files outside the folder", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "fora.jsonl"), "{}\n{}\n");
    const store = new ConversationStore(join(dir, "sessions"));
    for (const id of ["../fora", "..\\fora", "C:\\Windows\\win", "A", ""]) {
      expect(store.load(id)).rejects.toThrow();
      expect(store.remove(id)).rejects.toThrow();
    }
    expect(existsSync(join(dir, "fora.jsonl"))).toBe(true);
  });
});

describe("damaged files", () => {
  const damaged = ["lixo sem quebra de linha", "lixo\ncom quebra", `{"id":"outro","title":"t","updatedAt":"x","messageCount":1}\n{}\n`, ""];

  test("are counted and ignored in the list", async () => {
    const dir = tempDir();
    damaged.forEach((content, i) => writeFileSync(join(dir, `ruim${i}.jsonl`), content));
    const store = new ConversationStore(dir);
    await store.save(summary("boa"), emptyBody());
    const { items, damaged: count } = await store.list();
    expect(items.map((c) => c.id)).toEqual(["boa"]);
    expect(count).toBe(damaged.length);
  });

  test("the session warns and goes on, and a good header with a bad body does not stop it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ruim.jsonl"), "lixo");
    writeFileSync(join(dir, "corpo.jsonl"), `${JSON.stringify(summary("corpo"))}\n{ corpo quebrado`);
    const session = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream: echoStream() });
    await session.loadConversations();
    expect(session.getState().error).toContain("1 conversa(s) danificada(s)");
    expect(await session.resumeConversation("corpo")).toBe(false);
    expect(session.getState().error).toContain("danificado");
    await session.send("ainda funciono");
    expect(session.getState().messages.at(-1)?.content).toBe("eco: ainda funciono");
  });
});

describe("session with saved conversations", () => {
  test("a turn is saved and a new session gets it back, with the API history", async () => {
    const dir = tempDir();
    const first = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream: echoStream() });
    await first.send("primeira");
    const id = first.getState().conversationId!;
    expect(id).toBeTruthy();
    expect(first.getState().conversations.map((c) => c.title)).toEqual(["primeira"]);

    let seen: ChatMessage[] = [];
    const stream: any = async function* (opts: { messages: ChatMessage[] }) {
      seen = opts.messages;
      yield { type: "done", content: "ok", reasoning: "", messages: [{ role: "assistant", content: "ok" }] };
    };
    const second = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream });
    await second.loadConversations({ resumeLatest: true });
    expect(second.getState().conversationId).toBe(id);
    expect(second.getState().messages.map((m) => m.content)).toEqual(["primeira", "eco: primeira"]);
    await second.send("segunda");
    expect(seen.map((m) => m.content)).toEqual(["primeira", "eco: primeira", "segunda"]);
    expect(second.getState().conversations).toHaveLength(1); // same conversation, same file
  });

  test("the API key never goes to the file", async () => {
    const dir = tempDir();
    const session = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream: echoStream() });
    await session.send("oi");
    const file = join(dir, `${session.getState().conversationId}.jsonl`);
    expect(await Bun.file(file).text()).not.toContain(CONFIG.apiKey);
  });

  test("an empty conversation is not saved, and starting one clears the screen and the tasks", async () => {
    const dir = tempDir();
    const session = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream: echoStream() });
    session.newConversation();
    expect(readdirSync(dir)).toEqual([]);

    await session.send("oi");
    setTodos([{ id: "1", content: "t", status: "pending", priority: "low" }]);
    session.newConversation();
    expect(session.getState().messages).toEqual([]);
    expect(session.getState().conversationId).toBeNull();
    expect(getTodos()).toEqual([]);
    expect(session.getState().conversations).toHaveLength(1);
  });

  test("a turn in progress blocks switching conversations", async () => {
    const dir = tempDir();
    let release = () => {};
    const stream: any = async function* () {
      await new Promise<void>((resolve) => { release = resolve; });
      yield { type: "done", content: "fim", reasoning: "", messages: [{ role: "assistant", content: "fim" }] };
    };
    const session = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream });
    const turn = session.send("demorado");
    await Bun.sleep(10);
    session.newConversation();
    expect(await session.resumeConversation("x")).toBe(false);
    await session.deleteConversation("x");
    expect(session.getState().messages[0]?.content).toBe("demorado");
    release();
    await turn;
  });

  test("closing in the middle of a turn saves it complete, without unanswered tool calls", async () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const stream: any = async function* (opts: { signal: AbortSignal }) {
      yield { type: "text", text: "parcial" };
      await new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" }))));
    };
    const session = new AgentSession(CONFIG, {}, { store, stream });
    const turn = session.send("fechando");
    await Bun.sleep(10);
    await session.close();
    await turn;
    const [saved] = (await store.list()).items;
    const body = await store.load(saved!.id);
    expect(body.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(body.history[1]!.content).toContain("parcial");
  });

  test("tool cards come back with the conversation, and new ones do not repeat their key", async () => {
    const dir = tempDir();
    const stream: any = async function* () {
      yield { type: "tool_call", id: "c", name: "read_file", args: "{}" };
      yield { type: "tool_result", id: "c", name: "read_file", result: "conteudo", isError: false };
      yield { type: "done", content: "fim", reasoning: "", messages: [{ role: "assistant", content: "fim" }] };
    };
    const first = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream });
    await first.send("usa a ferramenta");
    const second = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream });
    await second.loadConversations({ resumeLatest: true });
    expect(second.getActivities()).toMatchObject([{ name: "read_file", result: "conteudo", afterMessage: 1 }]);
    await second.send("de novo");
    const keys = second.getActivities().map((a) => a.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("without a store nothing is saved", async () => {
    const session = new AgentSession(CONFIG, {}, { stream: echoStream() });
    await session.send("oi");
    expect(session.getState().conversationId).toBeNull();
    expect(session.getState().messages).toHaveLength(2);
  });

  test("deleting the open conversation starts an empty one", async () => {
    const dir = tempDir();
    const session = new AgentSession(CONFIG, {}, { store: new ConversationStore(dir), stream: echoStream() });
    await session.send("oi");
    await session.deleteConversation(session.getState().conversationId!);
    expect(session.getState().messages).toEqual([]);
    expect(session.getState().conversations).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
