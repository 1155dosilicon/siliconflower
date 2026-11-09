import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, cleanTitle, type ConversationBody } from "../src/services/conversations.js";
import { AgentSession } from "../src/session.js";
import { MAX_MESSAGE_BYTES, parseUploads, startGuiServer } from "../src/gui/server.js";
import { highlightTokens } from "../src/gui/client/markdown.js";
import { McpManager } from "../src/mcp.js";
import { parseMcp } from "../desktop/src/settings.js";
import { killAllBackgroundTasks, startBackgroundCommand } from "../src/services/background-tasks.js";
import type { ChatOptions } from "../src/llm.js";
import type { AppConfig, ChatMessage, StreamEvent } from "../src/types.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-feat-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const isWin = process.platform === "win32";
const CONFIG: AppConfig = { baseURL: "http://127.0.0.1:9/v1", apiKey: "k", model: "teste", reasoning: "none", mcpServers: {} };
const body = (text = "oi"): ConversationBody => ({ history: [{ role: "user", content: text }], messages: [{ role: "user", content: text }], activities: [], todos: [] });
const echo = async function* (opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const text = `eco: ${String(opts.messages.at(-1)?.content)}`;
  yield { type: "text", text };
  yield { type: "done", content: text, reasoning: "", messages: [{ role: "assistant", content: text }] };
};
// The smallest valid PNG (1x1).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("conversations: rename and two windows", () => {
  test("rename changes only the title, and the next turn keeps it", async () => {
    const store = new ConversationStore(tempDir());
    const session = new AgentSession(CONFIG, {}, { stream: echo, store });
    await session.send("primeira mensagem");
    const id = session.getState().conversationId!;
    const before = session.getState().conversations[0]!;

    expect(await session.renameConversation(id, "  Meu\ttítulo \n novo  ")).toBe(true);
    expect(session.getState().conversations[0]).toMatchObject({ id, title: "Meu título novo", updatedAt: before.updatedAt });
    expect((await store.load(id)).messages.length).toBe(2);

    await session.send("segunda");
    expect(session.getState().conversations[0]!.title).toBe("Meu título novo");
    expect(session.getState().conversationId).toBe(id);
    expect(await session.renameConversation(id, "   ")).toBe(false);
    expect(cleanTitle("x".repeat(200)).length).toBe(80);
  });

  test("a conversation changed by another window is saved as a copy, not over it", async () => {
    const dir = tempDir();
    const first = new AgentSession(CONFIG, {}, { stream: echo, store: new ConversationStore(dir) });
    await first.send("começo");
    const id = first.getState().conversationId!;

    // The second window (another process in real life) reopens it and adds a turn.
    const second = new AgentSession(CONFIG, {}, { stream: echo, store: new ConversationStore(dir) });
    await second.loadConversations({ resumeLatest: true });
    await second.send("da outra janela");
    expect(second.getState().conversationId).toBe(id);

    await first.send("da primeira janela");
    const copy = first.getState().conversationId!;
    expect(copy).not.toBe(id);
    expect(first.getState().error).toContain("Outra janela");
    const store = new ConversationStore(dir);
    expect((await store.load(id)).messages.map((m) => m.content)).toContain("da outra janela");
    expect((await store.load(copy)).messages.map((m) => m.content)).toContain("da primeira janela");
    // From here on the copy is its own conversation: no new copy at every turn.
    await first.send("mais uma");
    expect(first.getState().conversationId).toBe(copy);
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length).toBe(2);
  });

  test("without an expected stamp, save writes over the file as before", async () => {
    const store = new ConversationStore(tempDir());
    const meta = { id: "abc", title: "t", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 1 };
    expect(await store.save(meta, body())).toBe("abc");
    expect(await store.save({ ...meta, updatedAt: "2026-01-02T00:00:00.000Z" }, body("dois"))).toBe("abc");
    expect(await store.stamp("abc")).toBe("2026-01-02T00:00:00.000Z");
    expect(await store.stamp("nao-existe")).toBeUndefined();
  });
});

describe("files attached in the interface", () => {
  test("an image goes to the model with the message and its data stays out of the saved file", async () => {
    const seen: ChatMessage[][] = [];
    const dir = tempDir();
    const session = new AgentSession(CONFIG, {}, {
      store: new ConversationStore(dir),
      stream: (opts) => {
        seen.push(opts.messages);
        return echo(opts);
      },
    });
    await session.send("o que é isto?", [{ name: "print da tela.png", data: PNG }]);
    const sent = seen[0]!.at(-1)!;
    expect(sent.content).toBe("o que é isto?");
    expect(sent.media?.[0]).toMatchObject({ kind: "image", mime: "image/png", data: PNG });
    expect(sent.media![0]!.path).toMatch(/uploads.*print_da_tela\.png$/);
    expect(session.getState().messages[0]!.content).toContain("[anexo: print da tela.png]");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    expect(await Bun.file(join(dir, file)).text()).not.toContain(PNG);
  });

  test("only attachments, no text, is a valid message", async () => {
    const session = new AgentSession(CONFIG, {}, { stream: echo });
    await session.send("", [{ name: "a.png", data: PNG }]);
    expect(session.getState().messages.length).toBe(2);
  });

  test("a file that cannot be sent stops the message and says why", async () => {
    let turns = 0;
    const session = new AgentSession(CONFIG, {}, {
      stream: (opts) => {
        turns++;
        return echo(opts);
      },
    });
    await session.send("veja", [{ name: "planilha.xlsx", data: PNG }]);
    expect(turns).toBe(0);
    expect(session.getState().messages.length).toBe(0);
    expect(session.getState().error).toContain("planilha.xlsx");
    // Audio and video only on Xiaomi MiMo.
    await session.send("ouça", [{ name: "voz.mp3", data: PNG }]);
    expect(session.getState().error).toContain("MiMo");
    await session.send("muitos", Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, data: PNG })));
    expect(session.getState().error).toContain("no máximo 4");
    expect(turns).toBe(0);
  });

  test("the page cannot send anything else in place of the files", () => {
    expect(parseUploads(undefined)).toEqual([]);
    expect(parseUploads([{ name: "a.png", data: PNG }])).toEqual([{ name: "a.png", data: PNG }]);
    expect(parseUploads("x")).toBeNull();
    expect(parseUploads([{ name: "a.png", data: "não é base64!" }])).toBeNull();
    expect(parseUploads([{ name: "", data: PNG }])).toBeNull();
    expect(parseUploads([{ name: "a".repeat(300), data: PNG }])).toBeNull();
    expect(parseUploads(Array.from({ length: 5 }, () => ({ name: "a.png", data: PNG })))).toBeNull();
    expect(MAX_MESSAGE_BYTES).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe("background tasks in the interface", () => {
  test.skipIf(isWin)("a running command is in the state and can be ended from there", async () => {
    const session = new AgentSession(CONFIG, {}, { stream: echo });
    await session.start();
    try {
      const id = startBackgroundCommand("sleep 30", process.cwd(), 60_000);
      // The task list belongs to the process: other tests may have left theirs there.
      const mine = () => session.getState().backgroundTasks.find((t) => t.id === id);
      expect(mine()).toMatchObject({ type: "command", description: "Comando: sleep 30" });
      expect(session.killBackgroundTask(id)).toBe(true);
      expect(mine()).toBeUndefined();
      expect(session.killBackgroundTask(id)).toBe(false);
    } finally {
      await killAllBackgroundTasks();
      await session.close();
    }
  });
});

describe("GUI protocol", () => {
  test("a growing answer is sent in pieces, and rename and attachments arrive", async () => {
    let release = () => {};
    const seen: ChatMessage[][] = [];
    const session = new AgentSession(CONFIG, {}, {
      store: new ConversationStore(tempDir()),
      stream: async function* (opts) {
        seen.push(opts.messages);
        yield { type: "text", text: "Olá" };
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: "text", text: ", mundo" };
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: "done", content: "Olá, mundo", reasoning: "", messages: [{ role: "assistant", content: "Olá, mundo" }] };
      },
    });
    const server = startGuiServer(session);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const login = await fetch(server.url, { redirect: "manual" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const messages: any[] = [];
      const waiters: (() => void)[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: cookie, Origin: base } } as any);
      ws.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
        for (const wake of waiters.splice(0)) wake();
      });
      const waitFor = async (check: (m: any) => boolean) => {
        while (!messages.some(check)) await new Promise<void>((resolve) => waiters.push(resolve));
        return messages.find(check);
      };
      await waitFor((m) => m.type === "hello");

      ws.send(JSON.stringify({ type: "send", text: "veja", attachments: [{ name: "a.png", data: PNG }] }));
      await waitFor((m) => m.type === "state" && m.changes.liveText === "Olá");
      release();
      const piece = await waitFor((m) => m.type === "state" && m.liveAppend);
      expect(piece.liveAppend).toBe(", mundo");
      expect("liveText" in piece.changes).toBe(false);
      release();
      await waitFor((m) => m.type === "state" && m.changes.conversations?.length === 1);
      expect(seen[0]!.at(-1)!.media?.length).toBe(1);

      const id = session.getState().conversationId!;
      ws.send(JSON.stringify({ type: "rename", id, title: "Novo nome" }));
      await waitFor((m) => m.type === "state" && m.changes.conversations?.[0]?.title === "Novo nome");
      // Invalid attachments: the message is dropped, not sent without them.
      ws.send(JSON.stringify({ type: "send", text: "x", attachments: "nada" }));
      ws.send(JSON.stringify({ type: "rename", id: "../fora", title: "x" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(session.getState().messages.length).toBe(2);
      ws.close();
    } finally {
      server.stop();
      await session.close();
    }
  });

  test("code is split into tokens, never HTML", () => {
    const tokens = highlightTokens('const a = "<b>"; // nota\nreturn 42;', "ts");
    expect(tokens.map((t) => t.text).join("")).toBe('const a = "<b>"; // nota\nreturn 42;');
    expect(tokens.filter((t) => t.type).map((t) => `${t.type}:${t.text}`)).toEqual(["keyword:const", 'string:"<b>"', "comment:// nota", "keyword:return", "number:42"]);
    expect(highlightTokens("# comentário\nx = 1", "python")[0]).toEqual({ type: "comment", text: "# comentário" });
    expect(highlightTokens("# título", "markdown")).toEqual([{ type: "", text: "# título" }]);
    expect(highlightTokens("/* aberto", "js").at(-1)?.type).toBe("comment");
  });
});

describe("MCP servers", () => {
  const serverScript = (dir: string) => {
    const file = join(dir, "server.ts");
    const sdk = join(import.meta.dir, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    writeFileSync(file, `
import { McpServer } from ${JSON.stringify(join(sdk, "server", "mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(sdk, "server", "stdio.js"))};
import { WebStandardStreamableHTTPServerTransport } from ${JSON.stringify(join(sdk, "server", "webStandardStreamableHttp.js"))};
const make = () => {
  const server = new McpServer({ name: "teste", version: "1.0.0" });
  server.registerTool("pid", { description: "pid do servidor" }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
  return server;
};
if (process.argv[2] === "http") {
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.headers.get("x-chave") !== "segredo") return new Response("nao", { status: 401 });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await make().connect(transport);
    return transport.handleRequest(req);
  } });
  console.log(http.port);
} else {
  await make().connect(new StdioServerTransport());
}
`);
    return file;
  };

  test("a server that died is started again before the next call", async () => {
    const mcp = new McpManager();
    const tools = await mcp.connectAll({ local: { command: process.execPath, args: ["run", serverScript(tempDir())] } });
    try {
      expect(mcp.connectFailures()).toEqual([]);
      expect(tools.length).toBe(1);
      const first = Number((await mcp.callTool(tools[0]!.name, {})).result);
      expect(first).toBeGreaterThan(0);
      process.kill(first, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = Number((await mcp.callTool(tools[0]!.name, {})).result);
      expect(second).toBeGreaterThan(0);
      expect(second).not.toBe(first);
    } finally {
      await mcp.close();
    }
  }, 30_000);

  test("a remote server is reached by HTTP, with its headers", async () => {
    const child = Bun.spawn([process.execPath, "run", serverScript(tempDir()), "http"], { stdout: "pipe", stderr: "ignore" });
    const mcp = new McpManager();
    try {
      const reader = child.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();
      const url = `http://127.0.0.1:${port}/mcp`;
      const tools = await mcp.connectAll({ remoto: { url, headers: { "x-chave": "segredo" } }, semChave: { url } });
      expect(mcp.connectFailures().map((f) => f.server)).toEqual(["semChave"]);
      expect(tools.map((t) => t.originalName)).toEqual(["pid"]);
      expect(Number((await mcp.callTool(tools[0]!.name, {})).result)).toBe(child.pid);
    } finally {
      await mcp.close();
      child.kill();
    }
  }, 30_000);

  test("a server needs a command or an http(s) url", async () => {
    const mcp = new McpManager();
    await mcp.connectAll({ vazio: {}, arquivo: { url: "file:///etc/passwd" } });
    expect(mcp.connectFailures().map((f) => f.server).sort()).toEqual(["arquivo", "vazio"]);
    expect(parseMcp(JSON.stringify({ r: { url: "https://exemplo.com/mcp", headers: { Authorization: "Bearer x" } } })).servers)
      .toEqual({ r: { url: "https://exemplo.com/mcp", headers: { Authorization: "Bearer x" } } });
    expect(parseMcp(JSON.stringify({ r: { url: "ftp://x" } })).error).toContain("http");
    expect(parseMcp(JSON.stringify({ r: { args: [] } })).error).toContain('"command" ou de uma "url"');
  });
});

describe("editing the last message", () => {
  const toolTurn = (id: string, answer: string) =>
    async function* (opts: ChatOptions): AsyncGenerator<StreamEvent> {
      const step: ChatMessage[] = [
        { role: "assistant", content: "", toolCalls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", toolCallId: id, toolName: "read_file", content: "r" },
      ];
      yield { type: "tool_call", id, name: "read_file", args: "{}" };
      yield { type: "tool_result", id, name: "read_file", result: "r", isError: false };
      yield { type: "step", messages: step };
      const text = `${answer}: ${String(opts.messages.at(-1)?.content)}`;
      yield { type: "done", content: text, reasoning: "", messages: [...step, { role: "assistant", content: text }] };
    };

  test("the old turn leaves the screen, the cards and the history; earlier turns stay", async () => {
    const seen: ChatMessage[][] = [];
    const turns = [toolTurn("c1", "r1"), toolTurn("c2", "r2"), toolTurn("c3", "r3")];
    const dir = tempDir();
    const session = new AgentSession(CONFIG, {}, {
      store: new ConversationStore(dir),
      stream: (opts) => {
        seen.push(opts.messages);
        return turns[seen.length - 1]!(opts);
      },
    });
    await session.send("primeira");
    await session.send("segunda errada", [{ name: "a.png", data: PNG }]);
    expect(session.getActivities().map((a) => a.id)).toEqual(["c1", "c2"]);

    const turn = session.editLastMessage("segunda certa");
    expect(turn).not.toBe(false);
    // Dropped before anything is awaited: the server redraws right after the call.
    expect(session.getState().messages.map((m) => m.content)).toEqual(["primeira", "r1: primeira", "segunda certa\n\n[anexo: " + session.getState().messages[2]!.content.split("[anexo: ")[1]]);
    expect(session.getActivities().map((a) => a.id)).toEqual(["c1"]);
    await turn;

    expect(seen[2]!.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(seen[2]!.at(-1)).toMatchObject({ content: "segunda certa" });
    expect(seen[2]!.at(-1)!.media?.length).toBe(1); // the attachment goes along again
    expect(JSON.stringify(seen[2])).not.toContain("segunda errada");
    expect(session.getState().messages.map((m) => m.content.split("\n")[0])).toEqual(["primeira", "r1: primeira", "segunda certa", "r3: segunda certa"]);
    expect(session.getActivities().map((a) => a.id)).toEqual(["c1", "c3"]);
    const saved = await new ConversationStore(dir).load(session.getState().conversationId!);
    expect(JSON.stringify(saved)).not.toContain("segunda errada");
  });

  test("nothing to edit, an empty text or a running turn change nothing", async () => {
    const session = new AgentSession(CONFIG, {}, { stream: echo });
    expect(session.editLastMessage("x")).toBe(false);
    await session.send("oi");
    expect(session.editLastMessage("   ")).toBe(false);
    expect(session.getState().messages.length).toBe(2);
    await session.editLastMessage("olá");
    expect(session.getState().messages.map((m) => m.content)).toEqual(["olá", "eco: olá"]);
  });
});
