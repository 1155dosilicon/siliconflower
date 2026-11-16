import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/session.js";
import { buildPrompt, readUploads, runTurn, type RunIO } from "../src/run.js";
import type { ChatOptions } from "../src/llm.js";
import type { AppConfig, StreamEvent } from "../src/types.js";

const config: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "teste", reasoning: "none", mcpServers: {} };

type FakeTurn = (opts: ChatOptions) => AsyncGenerator<StreamEvent>;

function makeSession(turn: FakeTurn, interactive = false) {
  const seen: ChatOptions[] = [];
  const session = new AgentSession(config, {}, {
    interactive,
    stream: (opts) => {
      seen.push(opts);
      return turn(opts);
    },
  });
  return { session, seen };
}

function capture(ask?: RunIO["ask"]) {
  const io = { out: "", err: "" };
  const runIO: RunIO = { out: (t) => { io.out += t; }, err: (t) => { io.err += t; }, ask };
  return { io, runIO };
}

const toolTurn: FakeTurn = async function* () {
  yield { type: "text", text: "Vou ler." };
  yield { type: "tool_call", id: "c1", name: "read_file", args: '{"path":"a.txt"}' };
  yield { type: "tool_result", id: "c1", name: "read_file", result: "não existe", isError: true };
  yield { type: "text", text: "Pronto" };
  yield { type: "done", content: "Pronto", reasoning: "", messages: [{ role: "assistant", content: "Pronto" }] };
};

describe("siliconflower run", () => {
  test("prints only the final answer when not streaming, and the tools on stderr", async () => {
    const { session } = makeSession(toolTurn);
    const { io, runIO } = capture();
    const result = await runTurn(session, { prompt: "oi" }, runIO);
    expect(result.ok).toBe(true);
    expect(io.out).toBe("Pronto\n");
    expect(io.err).toContain('🔨 read_file {"path":"a.txt"}');
    expect(io.err).toContain("✗ não existe");
    expect(result.tools).toEqual([{ name: "read_file", args: '{"path":"a.txt"}', isError: true }]);
  });

  test("streams the text as it arrives and breaks the line before a tool", async () => {
    const { session } = makeSession(toolTurn);
    const { io, runIO } = capture();
    await runTurn(session, { prompt: "oi", stream: true }, runIO);
    expect(io.out).toBe("Vou ler.\nPronto\n");
  });

  test("--json prints one line and nothing else on stdout; --quiet hides the tools", async () => {
    const { session } = makeSession(toolTurn);
    const { io, runIO } = capture();
    await runTurn(session, { prompt: "oi", json: true, stream: true, quiet: true }, runIO);
    const lines = io.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, text: "Pronto", error: null });
    expect(io.err).toBe("");
  });

  test("a provider error fails the run with the message on stderr", async () => {
    const { session } = makeSession(async function* () {
      yield { type: "error", message: "HTTP 401" };
    });
    const { io, runIO } = capture();
    const result = await runTurn(session, { prompt: "oi" }, runIO);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 401");
    expect(io.out).toBe("");
    expect(io.err).toContain("Erro: HTTP 401");
  });

  test("without anyone to answer, the session offers no question and no 'continue?'", async () => {
    const { session, seen } = makeSession(async function* (opts) {
      const res = await opts.executeTool("ask_question", { question: "Qual cor?", options: ["azul", "verde"] });
      yield { type: "done", content: res.result, reasoning: "", messages: [{ role: "assistant", content: res.result }] };
    });
    const { runIO } = capture();
    const result = await runTurn(session, { prompt: "oi" }, runIO);
    expect(seen[0]!.confirmContinue).toBeUndefined();
    expect(result.text).toContain("[SEM INTERFACE INTERATIVA]");
    expect(result.text).toContain("Qual cor?");
  });

  test("in a terminal, a question goes to the person and a number picks the option", async () => {
    const { session, seen } = makeSession(async function* (opts) {
      const res = await opts.executeTool("ask_question", { question: "Qual cor?", options: ["azul", "verde"] });
      yield { type: "done", content: res.result, reasoning: "", messages: [{ role: "assistant", content: res.result }] };
    }, true);
    const questions: string[] = [];
    const { runIO } = capture(async (q) => {
      questions.push(q.question);
      return "2";
    });
    const result = await runTurn(session, { prompt: "oi" }, runIO);
    expect(seen[0]!.confirmContinue).toBeDefined();
    expect(questions).toEqual(["Qual cor?"]);
    expect(result.text).toBe("Resposta do usuário: verde");
  });

  test("Ctrl+C on a question cancels the turn", async () => {
    const { session } = makeSession(async function* (opts) {
      await opts.executeTool("ask_question", { question: "Qual cor?" });
      opts.signal?.throwIfAborted();
      yield { type: "done", content: "não devia chegar", reasoning: "" };
    }, true);
    const { io, runIO } = capture(() => Promise.reject(new Error("abort")));
    const result = await runTurn(session, { prompt: "oi" }, runIO);
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(io.err).toContain("[cancelado]");
  });

  test("the message joins the typed words and what came through the pipe", () => {
    expect(buildPrompt(["explique", "isto"], "linha 1\r\nlinha 2\n")).toBe("explique isto\n\nlinha 1\nlinha 2");
    expect(buildPrompt([], " só o pipe \n")).toBe("só o pipe");
    expect(buildPrompt(["só", "texto"], undefined)).toBe("só texto");
  });

  test("attachments keep the file name and refuse more than the interface allows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-run-"));
    const file = join(dir, "foto.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    expect(await readUploads([file])).toEqual([{ name: "foto.png", data: "AQID" }]);
    await expect(readUploads([file, file, file, file, file])).rejects.toThrow("no máximo 4");
    await expect(readUploads([join(dir, "nao-existe.png")])).rejects.toThrow("não consegui ler o anexo");
  });
});

describe("siliconflower run and the API key", () => {
  test("the answer, the error and the tool lines leave without the key", async () => {
    const key = "sk-segredo-muito-longo-123";
    const session = new AgentSession({ ...config, apiKey: key }, {}, {
      interactive: false,
      stream: async function* () {
        yield { type: "tool_call", id: "c1", name: "execute_command", args: `{"command":"echo ${key}"}` };
        yield { type: "tool_result", id: "c1", name: "execute_command", result: "***", isError: false };
        yield { type: "done", content: `a chave é ${key}`, reasoning: "", messages: [{ role: "assistant", content: `a chave é ${key}` }] };
      },
    });
    const io = { out: "", err: "" };
    const result = await runTurn(session, { prompt: "oi", json: true }, { out: (t) => { io.out += t; }, err: (t) => { io.err += t; } });
    expect(result.text).toBe("a chave é ***");
    expect(io.out + io.err).not.toContain(key);
  });
});
