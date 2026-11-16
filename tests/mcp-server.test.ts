import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRunArgs, createMcpServer, formatAsk, parseAsk, selfCommand, ToolInputError } from "../src/mcp-server.js";
import { ConversationStore, newRevision } from "../src/services/conversations.js";
import { getWorkspaceDataDir } from "../src/fs-util.js";

const work = await mkdtemp(join(tmpdir(), "sf-mcp-"));
afterAll(() => rm(work, { recursive: true, force: true }));

/**
 * Stands in for `siliconflower run --json`: what it does depends on the message it reads from
 * stdin. It echoes its arguments and folder so the tests can check what the server passed.
 */
const fakeRun = join(work, "fake-run.ts");
await writeFile(
  fakeRun,
  `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const message = Buffer.concat(chunks).toString("utf8");
const args = process.argv.slice(2);
const result = (text, extra = {}) => process.stdout.write(JSON.stringify({ ok: true, cancelled: false, text, error: null, conversationId: "c-1", tools: [], tokens: 10, ...extra }) + "\\n");
if (message === "falha") {
  process.stderr.write("Erro: falta configurar o provedor\\n");
  process.exit(1);
} else if (message.startsWith("trava:")) {
  // A command started by the agent: a cancel must kill it too.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(message.slice(6), String(child.pid));
  setTimeout(() => {}, 60000);
} else if (message === "ferramentas") {
  process.stderr.write("🔨 read_file {\\"path\\":\\"a\\"}\\n🔨 run_command {\\"command\\":\\"ls\\"}\\n   ✗ falhou\\n");
  result("feito", { tools: [{ name: "read_file", args: "{}", isError: false }, { name: "run_command", args: "{}", isError: true }] });
} else if (message === "erro-do-modelo") {
  result("parcial", { ok: false, error: "HTTP 429" });
} else {
  result(JSON.stringify({ message, args, cwd: process.cwd() }));
}
`
);

async function connect(options: Parameters<typeof createMcpServer>[0] = {}) {
  const server = createMcpServer({ cwd: work, command: [process.execPath, fakeRun], ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "teste", version: "1" });
  await client.connect(clientSide);
  return { client, server };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("siliconflower mcp", () => {
  test("lists the three tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask", "list_conversations", "read_conversation"]);
    expect(tools[0]!.inputSchema.required).toEqual(["message"]);
    await client.close();
  });

  test("ask runs `run --json` in the folder, with the message on stdin and the options as flags", async () => {
    const sub = await mkdtemp(join(work, "proj-"));
    const { client } = await connect({ defaults: { reasoning: "low" } });
    const r = await client.callTool({
      name: "ask",
      arguments: { message: "olá\nmundo", cwd: sub, conversation_id: "abc-1", mode: "plano", attachments: ["foto.png"] },
    });
    expect(r.isError).toBe(false);
    const echoed = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(echoed.message).toBe("olá\nmundo");
    expect(echoed.cwd).toBe(sub);
    expect(echoed.args).toEqual(["run", "--json", "--resume", "abc-1", "--mode", "plano", "--reasoning", "low", "--attach", join(sub, "foto.png")]);
    expect(text(r)).toContain("conversation_id: c-1");
    await client.close();
  });

  test("each tool the agent runs becomes a progress notification", async () => {
    const { client } = await connect();
    const progress: string[] = [];
    const r = await client.callTool({ name: "ask", arguments: { message: "ferramentas" } }, undefined, {
      onprogress: (p) => { progress.push(p.message ?? ""); },
    });
    expect(progress).toEqual(['read_file {"path":"a"}', 'run_command {"command":"ls"}']);
    expect(text(r)).toContain("ferramentas: 2 chamada(s) (read_file, run_command), 1 com erro");
    await client.close();
  });

  test("a run that fails before answering reports the reason from stderr", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "ask", arguments: { message: "falha" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Erro: falta configurar o provedor");
    await client.close();
  });

  test("a provider error is an error result that keeps the partial answer", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "ask", arguments: { message: "erro-do-modelo" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Erro: HTTP 429");
    expect(text(r)).toContain("Resposta parcial:\nparcial");
    await client.close();
  });

  test("a program that cannot start is an error, not a crash", async () => {
    const { client } = await connect({ command: [join(work, "nao-existe")] });
    const r = await client.callTool({ name: "ask", arguments: { message: "oi" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("não consegui iniciar o siliconflower");
    await client.close();
  });

  test.skipIf(process.platform === "win32")("cancelling the call kills the run and what it started", async () => {
    const pidFile = join(work, "pid-cancel");
    const { client } = await connect();
    const controller = new AbortController();
    const call = client.callTool({ name: "ask", arguments: { message: `trava:${pidFile}` } }, undefined, { signal: controller.signal });
    expect(await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "")).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(await waitFor(() => !alive(pid))).toBe(true);
    await client.close();
  });

  test.skipIf(process.platform === "win32")("closing the server kills the runs still going", async () => {
    const pidFile = join(work, "pid-close");
    const { client, server } = await connect();
    void client.callTool({ name: "ask", arguments: { message: `trava:${pidFile}` } }).catch(() => {});
    expect(await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "")).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    await server.stopRuns?.();
    expect(alive(pid)).toBe(false);
    await client.close();
  });

  test("bad arguments are refused before anything runs", () => {
    const bad = (args: Record<string, unknown>) => () => parseAsk(args, work);
    expect(bad({})).toThrow(ToolInputError);
    expect(bad({ message: "   " })).toThrow("message é obrigatório");
    expect(bad({ message: "x", cwd: join(work, "nao-existe") })).toThrow("a pasta não existe");
    expect(bad({ message: "x", conversation_id: "../../etc" })).toThrow("conversation_id inválido");
    expect(bad({ message: "x", mode: "root" })).toThrow("mode deve ser");
    expect(bad({ message: "x", reasoning: "infinito" })).toThrow("reasoning deve ser");
    expect(bad({ message: "x", model: "--api-key=roubada" })).toThrow("model inválido");
    expect(bad({ message: "x", attachments: ["a", "b", "c", "d", "e"] })).toThrow("no máximo 4");
    expect(bad({ message: "x", attachments: "a.png" })).toThrow("lista de caminhos");
    expect(bad({ message: 42 })).toThrow("message deve ser texto");
  });

  test("attachments become absolute paths, so none is read as an option", () => {
    const req = parseAsk({ message: "x", attachments: ["-rf", "sub/a.png"] }, work);
    expect(req.attachments).toEqual([join(work, "-rf"), join(work, "sub", "a.png")]);
  });

  test("continue only applies without a conversation id", () => {
    expect(buildRunArgs({ message: "x", cwd: work, continueLatest: true })).toEqual(["run", "--json", "--continue"]);
    expect(buildRunArgs({ message: "x", cwd: work, continueLatest: true, conversationId: "a" })).toEqual(["run", "--json", "--resume", "a"]);
  });

  test("a cancelled run reads as cancelled", () => {
    expect(formatAsk({ result: null, cancelled: true })).toMatchObject({ isError: true });
  });

  test("restarts itself as the compiled binary or as Bun with the script", () => {
    expect(selfCommand("/bin/siliconflower", "/$bunfs/root/siliconflower")).toEqual(["/bin/siliconflower"]);
    expect(selfCommand("/bin/bun", fakeRun)).toEqual(["/bin/bun", fakeRun]);
  });

  test("lists and reads the conversations saved in a project", async () => {
    const proj = await mkdtemp(join(work, "conversas-"));
    const store = new ConversationStore(join(getWorkspaceDataDir(proj), "sessions"));
    const messages = [
      { role: "user" as const, content: "primeiro pedido" },
      { role: "assistant" as const, content: "primeira resposta" },
      { role: "user" as const, content: "segundo pedido" },
      { role: "assistant" as const, content: "segunda resposta" },
    ];
    await store.save(
      { id: "conv-1", title: "Meu título", updatedAt: new Date().toISOString(), messageCount: 4, rev: newRevision() },
      { history: [], messages, activities: [], todos: [] }
    );
    const { client } = await connect();
    const list = text(await client.callTool({ name: "list_conversations", arguments: { cwd: proj } }));
    expect(list).toContain("conv-1");
    expect(list).toContain("4 mensagens · Meu título");
    const read = text(await client.callTool({ name: "read_conversation", arguments: { cwd: proj, conversation_id: "conv-1", last: 2 } }));
    expect(read).toBe("(2 mensagem(ns) anteriores omitidas)\n\n### Pedido\nsegundo pedido\n\n### Resposta\nsegunda resposta");
    const missing = await client.callTool({ name: "read_conversation", arguments: { cwd: proj, conversation_id: "nada" } });
    expect(missing.isError).toBe(true);
    const empty = text(await client.callTool({ name: "list_conversations", arguments: { cwd: work } }));
    expect(empty).toContain("Nenhuma conversa salva");
    await client.close();
  });
});
