import { afterEach, describe, expect, test } from "bun:test";
import { startGuiServer, type GuiServer, type GuiServerOptions } from "../src/gui/server.js";
import type { DoctorOptions, DoctorReport } from "../src/doctor.js";
import { parseInline, parseMarkdown, safeHref } from "../src/gui/client/markdown.js";
import { AgentSession } from "../src/session.js";
import type { ChatOptions } from "../src/llm.js";
import type { AppConfig, StreamEvent } from "../src/types.js";

const API_KEY = "chave-secreta-de-teste";
const config: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: API_KEY, model: "teste", reasoning: "none", mcpServers: {} };

type FakeTurn = (opts: ChatOptions) => AsyncGenerator<StreamEvent>;

const running: GuiServer[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.stop();
});

function setup(turns: FakeTurn[] = [], options: GuiServerOptions = {}) {
  let index = 0;
  const session = new AgentSession(config, {}, { stream: (opts) => turns[index++](opts) });
  const server = startGuiServer(session, options);
  running.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { session, server, base, cookieName: `sf_gui_${server.port}`, token: new URL(server.url).searchParams.get("token")! };
}

async function login(server: GuiServer): Promise<string> {
  const res = await fetch(server.url, { redirect: "manual" });
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0];
}

interface Client {
  ws: WebSocket;
  received: any[];
  waitFor: (check: (m: any) => boolean) => Promise<any>;
}

function connect(base: string, cookie: string, origin = base): Promise<Client> {
  const received: any[] = [];
  const waiters: { check: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: origin } } as any);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    received.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.check(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (check: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const found = received.find(check);
      if (found) resolve(found);
      else waiters.push({ check, resolve });
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, received, waitFor }));
    ws.addEventListener("error", () => reject(new Error("websocket recusado")));
  });
}

describe("GUI server access control", () => {
  test("listens on the loopback interface only", () => {
    const { server } = setup();
    expect(server.url).toStartWith("http://127.0.0.1:");
  });

  test("pages require the session cookie", async () => {
    const { base } = setup();
    for (const path of ["/", "/app.js", "/style.css", "/markdown.js", "/fonts/jetbrains-mono-extrabold.woff2"]) {
      expect((await fetch(base + path)).status).toBe(401);
    }
  });

  test("a wrong token gets no cookie", async () => {
    const { base } = setup();
    const res = await fetch(`${base}/?token=${"0".repeat(64)}`, { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("the right token gives a strict cookie and leaves the address bar clean", async () => {
    const { server, base } = setup();
    const res = await fetch(server.url, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const page = await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0] } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Siliconflower");
  });

  test("refuses another Host, which blocks DNS rebinding", async () => {
    const { server, base } = setup();
    const cookie = await login(server);
    const res = await fetch(`${base}/`, { headers: { Cookie: cookie, Host: "site-malicioso.example" } });
    expect(res.status).toBe(403);
  });

  test("responses carry a restrictive content security policy", async () => {
    const { server, base } = setup();
    const cookie = await login(server);
    const csp = (await fetch(`${base}/`, { headers: { Cookie: cookie } })).headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe");
    expect(csp).toContain("frame-ancestors 'none'");
    // Fonts only from the app itself: never from a third-party CDN.
    expect(csp).toContain("font-src 'self';");
  });

  test("serves the embedded font of the mode chip", async () => {
    const { server, base } = setup();
    const cookie = await login(server);
    const res = await fetch(`${base}/fonts/jetbrains-mono-extrabold.woff2`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
    // A second request must still get the whole file (the body is reused).
    const again = await fetch(`${base}/fonts/jetbrains-mono-extrabold.woff2`, { headers: { Cookie: cookie } });
    expect((await again.arrayBuffer()).byteLength).toBe(bytes.length);
  });

  test("the WebSocket refuses a missing cookie and a foreign Origin", async () => {
    const { server, base, cookieName } = setup();
    const cookie = await login(server);
    await expect(connect(base, `${cookieName}=errado`)).rejects.toThrow();
    await expect(connect(base, cookie, "https://site-malicioso.example")).rejects.toThrow();
    const ok = await connect(base, cookie);
    ok.ws.close();
  });

  test("other methods are refused", async () => {
    const { server, base } = setup();
    const cookie = await login(server);
    expect((await fetch(`${base}/ws`, { method: "POST", headers: { Cookie: cookie } })).status).toBe(405);
  });
});

describe("GUI protocol", () => {
  test("a new page receives the state, without the API key", async () => {
    const { server, base } = setup();
    const client = await connect(base, await login(server));
    const hello = await client.waitFor((m) => m.type === "hello");
    expect(hello.state.model).toBe("teste");
    expect(hello.meta.modes).toContain("plano");
    expect(client.received.length).toBeGreaterThan(0);
    expect(JSON.stringify(hello)).not.toContain(API_KEY);
    client.ws.close();
  });

  test("runs a turn and streams text, tool activity and the final message", async () => {
    const { server, base } = setup([
      async function* () {
        yield { type: "thinking", text: "hum" };
        yield { type: "tool_call", id: "c1", name: "read_file", args: '{"path":"a.txt"}' };
        yield { type: "tool_result", id: "c1", name: "read_file", result: "conteudo", isError: false };
        yield { type: "text", text: "pronto" };
        yield { type: "done", content: "pronto", reasoning: "hum", messages: [{ role: "assistant", content: "pronto" }] };
      },
    ]);
    const client = await connect(base, await login(server));
    await client.waitFor((m) => m.type === "hello");

    client.ws.send(JSON.stringify({ type: "send", text: "oi\nmundo" }));

    const tool = await client.waitFor((m) => m.type === "tool" && m.activity.result !== undefined);
    expect(tool.activity).toMatchObject({ id: "c1", name: "read_file", result: "conteudo", afterMessage: 1 });
    const end = await client.waitFor((m) => m.type === "state" && m.changes.streaming === false);
    expect(end.changes.messages.map((x: any) => x.content)).toEqual(["oi\nmundo", "pronto"]);
    client.ws.close();
  });

  test("the model's reasoning text never reaches the page", async () => {
    const secretThought = "pensamento-que-nao-aparece";
    const { server, base } = setup([
      async function* () {
        yield { type: "thinking", text: secretThought };
        yield { type: "text", text: "pronto" };
        yield { type: "done", content: "pronto", reasoning: secretThought, messages: [{ role: "assistant", content: "pronto" }] };
      },
    ]);
    const cookie = await login(server);
    const client = await connect(base, cookie);
    await client.waitFor((m) => m.type === "hello");
    client.ws.send(JSON.stringify({ type: "send", text: "oi" }));
    await client.waitFor((m) => m.type === "state" && m.changes.streaming === false);
    expect(JSON.stringify(client.received)).not.toContain(secretThought);
    client.ws.close();

    // A page opened afterwards gets the history through hello.
    const late = await connect(base, cookie);
    const hello = await late.waitFor((m) => m.type === "hello");
    expect(hello.state.messages).toHaveLength(2);
    expect(JSON.stringify(hello)).not.toContain(secretThought);
    late.ws.close();
  });

  test("calls with a repeated provider id stay separate", async () => {
    const { server, base } = setup([
      async function* () {
        yield { type: "tool_call", id: "call_0", name: "a", args: "{}" };
        yield { type: "tool_result", id: "call_0", name: "a", result: "primeiro", isError: false };
        yield { type: "tool_call", id: "call_0", name: "b", args: "{}" };
        yield { type: "tool_result", id: "call_0", name: "b", result: "segundo", isError: false };
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);
    const client = await connect(base, await login(server));
    await client.waitFor((m) => m.type === "hello");
    client.ws.send(JSON.stringify({ type: "send", text: "oi" }));
    await client.waitFor((m) => m.type === "state" && m.changes.streaming === false);

    const finished = client.received.filter((m) => m.type === "tool" && m.activity.result !== undefined).map((m) => m.activity);
    expect(finished.map((a) => [a.name, a.result])).toEqual([["a", "primeiro"], ["b", "segundo"]]);
    expect(finished[0].key).not.toBe(finished[1].key);
    client.ws.close();
  });

  test("a page opened mid-session receives past tool activity", async () => {
    const { server, base } = setup([
      async function* () {
        yield { type: "tool_call", id: "c1", name: "read_file", args: "{}" };
        yield { type: "tool_result", id: "c1", name: "read_file", result: "r", isError: true };
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);
    const cookie = await login(server);
    const first = await connect(base, cookie);
    await first.waitFor((m) => m.type === "hello");
    first.ws.send(JSON.stringify({ type: "send", text: "oi" }));
    await first.waitFor((m) => m.type === "state" && m.changes.streaming === false);

    const second = await connect(base, cookie);
    const hello = await second.waitFor((m) => m.type === "hello");
    expect(hello.activities[0]).toMatchObject({ id: "c1", isError: true, result: "r" });
    first.ws.close();
    second.ws.close();
  });

  test("answers questions, cancels and ignores invalid messages", async () => {
    let toolResult = "";
    const { session, server, base } = setup([
      async function* (opts) {
        toolResult = (await opts.executeTool("ask_question", { question: "Qual?", options: ["a", "b"] })).result;
        yield { type: "text", text: "continua" };
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")));
        });
      },
    ]);
    const client = await connect(base, await login(server));
    await client.waitFor((m) => m.type === "hello");

    client.ws.send("isto nao e json");
    client.ws.send(JSON.stringify(null));
    client.ws.send(JSON.stringify({ type: "mode", mode: "inexistente" }));
    client.ws.send(JSON.stringify({ type: "reasoning", level: 7 }));
    client.ws.send(JSON.stringify({ type: "send", text: 123 }));
    client.ws.send(JSON.stringify({ type: "desconhecido" }));
    client.ws.send(JSON.stringify({ type: "mode", mode: "plano" }));
    await client.waitFor((m) => m.type === "state" && m.changes.mode === "plano");
    expect(session.getState().messages.length).toBe(0);

    client.ws.send(JSON.stringify({ type: "send", text: "oi" }));
    await client.waitFor((m) => m.type === "state" && m.changes.question);
    client.ws.send(JSON.stringify({ type: "answer", text: "b" }));
    await client.waitFor((m) => m.type === "state" && m.changes.liveText === "continua");
    expect(toolResult).toContain("b");

    client.ws.send(JSON.stringify({ type: "cancel" }));
    await client.waitFor((m) => m.type === "state" && m.changes.streaming === false);
    expect(session.getState().status).toBe("cancelado");
    client.ws.close();
  });

  test("the diagnosis button checks what this session runs with and answers only the page that asked", async () => {
    const asked: DoctorOptions[] = [];
    const report: DoctorReport = {
      ok: true,
      checks: [
        { id: "shell", title: "Shell", status: "ok", detail: "funciona" },
        { id: "conversations", title: "Conversas salvas", status: "warn", detail: "1 arquivo danificado", fixable: true },
      ],
    };
    const { server, base } = setup([], {
      doctor: async (options = {}) => {
        asked.push(options);
        return report;
      },
    });
    const cookie = await login(server);
    const client = await connect(base, cookie);
    const other = await connect(base, cookie);
    await client.waitFor((m) => m.type === "hello");
    await other.waitFor((m) => m.type === "hello");

    client.ws.send(JSON.stringify({ type: "doctor" }));
    const first = await client.waitFor((m) => m.type === "doctor");
    expect(first.report).toEqual(report);
    expect(first.summary).toBe("0 problemas e 1 aviso.");
    // The session's own provider and model, and its MCP servers instead of a second connection.
    expect(asked[0]).toMatchObject({ fix: false, overrides: { baseURL: config.baseURL, apiKey: API_KEY, model: "teste" }, mcp: "connecting" });
    expect(JSON.stringify(first)).not.toContain(API_KEY);

    // Only an explicit `fix: true` changes anything.
    client.ws.send(JSON.stringify({ type: "doctor", fix: "sim" }));
    client.ws.send(JSON.stringify({ type: "doctor", fix: true }));
    await client.waitFor((m) => m.type === "doctor" && client.received.filter((x) => x.type === "doctor").length === 3);
    expect(asked.map((o) => o.fix)).toEqual([false, false, true]);

    expect(other.received.some((m) => m.type === "doctor")).toBe(false);
    client.ws.close();
    other.ws.close();
  });

  test("inside the app the page is told to hide its diagnosis button: the start screen has it", async () => {
    const browser = setup();
    const inBrowser = await connect(browser.base, await login(browser.server));
    expect((await inBrowser.waitFor((m) => m.type === "hello")).meta.managed).toBe(false);
    inBrowser.ws.close();

    const app = setup([], { managed: true });
    const inApp = await connect(app.base, await login(app.server));
    expect((await inApp.waitFor((m) => m.type === "hello")).meta.managed).toBe(true);
    inApp.ws.close();
  });

  test("a diagnosis that breaks answers with a message instead of leaving the page waiting", async () => {
    const { server, base } = setup([], { doctor: async () => { throw new Error("quebrou"); } });
    const client = await connect(base, await login(server));
    await client.waitFor((m) => m.type === "hello");
    client.ws.send(JSON.stringify({ type: "doctor" }));
    const reply = await client.waitFor((m) => m.type === "doctor");
    expect(reply.report).toBeUndefined();
    expect(reply.error).toContain("diagnóstico");
    client.ws.close();
  });

  test("shuts down after the last page closes, but survives a reload", async () => {
    let idle = 0;
    const { server, base } = setup([], { graceMs: 150, onIdle: () => { idle++; } });
    const cookie = await login(server);

    const first = await connect(base, cookie);
    first.ws.close();
    await Bun.sleep(40);
    const reloaded = await connect(base, cookie);
    await Bun.sleep(250);
    expect(idle).toBe(0);

    reloaded.ws.close();
    await Bun.sleep(300);
    expect(idle).toBe(1);
  });
});

describe("GUI markdown", () => {
  const flatten = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? []), ...flatten((n.items ?? []).flat())]);

  test("only allows safe link protocols", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///C:/x", "/relativo"]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  test("a dangerous link keeps its text but is not a link", () => {
    const nodes = flatten(parseInline("[clique](javascript:alert(1))"));
    expect(nodes.some((n) => n.type === "link")).toBe(false);
    expect(nodes.some((n) => n.text === "clique")).toBe(true);
  });

  test("HTML stays as plain text", () => {
    const html = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
    expect(parseMarkdown(html)).toEqual([{ type: "paragraph", children: [{ type: "text", text: html }] }]);
  });

  test("images become links and never load", () => {
    const nodes = flatten(parseInline("![foto](https://a.example/p.png)"));
    expect(nodes.find((n) => n.type === "link")?.href).toBe("https://a.example/p.png");
    expect(nodes.some((n) => n.type === "image")).toBe(false);
  });

  test("parses the common blocks", () => {
    const blocks = parseMarkdown("# Título\n\nTexto **forte** e `codigo`\n\n- um\n- dois\n  - interno\n\n1. a\n2. b\n\n> citação\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n---\n\n```ts\nconst a = 1;\n```");
    expect(blocks.map((b: any) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "table", "rule", "codeblock"]);
    expect(blocks[7]).toEqual({ type: "codeblock", lang: "ts", text: "const a = 1;" });
    const nested = (blocks[2] as any).items[1];
    expect(nested.map((b: any) => b.type)).toEqual(["paragraph", "list"]);
  });

  test("a code fence still open while streaming shows the code so far", () => {
    expect(parseMarkdown("antes\n```js\nlet a")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "antes" }] },
      { type: "codeblock", lang: "js", text: "let a" },
    ]);
  });

  test("does not treat arithmetic or identifiers as emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("snake__case__nome")).toEqual([{ type: "text", text: "snake__case__nome" }]);
  });

  test("deep nesting does not overflow", () => {
    expect(() => parseMarkdown(">".repeat(2000) + " x")).not.toThrow();
    expect(() => parseInline("[".repeat(2000) + "](").length).not.toThrow();
    expect(() => parseInline("**a ".repeat(2000))).not.toThrow();
  });
});
