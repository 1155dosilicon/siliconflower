import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/session.js";
import type { ChatOptions } from "../src/llm.js";
import type { AppConfig, ChatMessage, StreamEvent } from "../src/types.js";

const config: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "teste", reasoning: "none", mcpServers: {} };

type FakeTurn = (opts: ChatOptions) => AsyncGenerator<StreamEvent>;

/** Session whose turns are scripted, recording the history handed to each one. */
function makeSession(turns: FakeTurn[], overrides = {}) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const session = new AgentSession(config, overrides, {
    stream: (opts) => {
      seen.push(opts.messages);
      return turns[index++](opts);
    },
  });
  return { session, seen };
}

function waitFor(session: AgentSession, check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (check()) return resolve();
    const stop = session.subscribe(() => {
      if (check()) {
        stop();
        resolve();
      }
    });
  });
}

const answerTurn = (text: string): FakeTurn =>
  async function* () {
    yield { type: "text", text };
    yield { type: "done", content: text, reasoning: "", messages: [{ role: "assistant", content: text }] };
  };

describe("AgentSession", () => {
  test("keeps tool calls and results of a finished turn in the next request", async () => {
    const toolTurn: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c1", toolName: "read_file", content: "conteudo" },
      { role: "assistant", content: "fim" },
    ];
    const { session, seen } = makeSession([
      async function* () {
        yield { type: "done", content: "fim", reasoning: "", messages: toolTurn };
      },
      answerTurn("ok"),
    ]);

    await session.send("primeira");
    await session.send("segunda");

    expect(seen[1]).toEqual([{ role: "user", content: "primeira" }, ...toolTurn, { role: "user", content: "segunda" }]);
    expect(session.getState().messages.map((m) => m.content)).toEqual(["primeira", "fim", "segunda", "ok"]);
    expect(session.getState().streaming).toBe(false);
    expect(session.getState().status).toBe("pronto");
  });

  test("keeps line breaks of a message and removes other control characters", async () => {
    const { session, seen } = makeSession([answerTurn("ok")]);

    await session.send("  linha 1\r\nlinha\x07 2\n\tfim\x1b ");

    expect(seen[0]).toEqual([{ role: "user", content: "linha 1\nlinha 2\n\tfim" }]);
  });

  test("a cancelled turn keeps only the visible text in the history", async () => {
    const { session, seen } = makeSession([
      async function* (opts) {
        yield { type: "text", text: "parcial" };
        yield { type: "tool_call", id: "c1", name: "read_file", args: "{}" };
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")));
        });
      },
      answerTurn("ok"),
    ]);

    const turn = session.send("oi");
    await waitFor(session, () => session.getState().status.includes("read_file"));
    expect(session.cancel()).toBe(true);
    await turn;

    expect(session.getState().status).toBe("cancelado");
    expect(session.getState().error).toBeNull();
    expect(session.cancel()).toBe(false);

    await session.send("de novo");
    expect(seen[1]).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "parcial\n\n[interrompido pelo usuário]" },
      { role: "user", content: "de novo" },
    ]);
  });

  test("ignores a message sent while a turn is running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session, seen } = makeSession([
      async function* () {
        await gate;
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);

    const turn = session.send("primeira");
    await session.send("segunda");
    release();
    await turn;

    expect(seen.length).toBe(1);
    expect(session.getState().messages.map((m) => m.content)).toEqual(["primeira", "fim"]);
  });

  test("ask_question waits for the answer and a bare number selects an option", async () => {
    let toolResult = "";
    const { session } = makeSession([
      async function* (opts) {
        const r = await opts.executeTool("ask_question", { question: "Qual?", options: ["azul", "verde"] });
        toolResult = r.result;
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);

    const turn = session.send("oi");
    await waitFor(session, () => session.getState().question !== null);
    expect(session.getState().question).toEqual({ question: "Qual?", options: ["azul", "verde"] });
    expect(session.answer("   ")).toBe(false);
    expect(session.getState().question).not.toBeNull();
    expect(session.answer("2")).toBe(true);
    await turn;

    expect(toolResult).toContain("verde");
    expect(session.getState().question).toBeNull();
  });

  test("cancelling removes a pending question and tells the tool", async () => {
    let result = { result: "", isError: false };
    const { session } = makeSession([
      async function* (opts) {
        result = await opts.executeTool("ask_question", { question: "Qual?" });
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);

    const turn = session.send("oi");
    await waitFor(session, () => session.getState().question !== null);
    session.cancel();
    await turn;

    expect(result.isError).toBe(true);
    expect(session.getState().question).toBeNull();
    expect(session.getState().streaming).toBe(false);
  });

  test("plan mode blocks tools outside the allowlist", async () => {
    let result = { result: "", isError: false };
    const { session } = makeSession(
      [
        async function* (opts) {
          result = await opts.executeTool("write_file", { path: "x.txt", content: "y" });
          yield { type: "done", content: "fim", reasoning: "", messages: [] };
        },
      ],
      { mode: "plano" }
    );

    await session.send("oi");

    expect(result.isError).toBe(true);
    expect(result.result).toContain("MODO PLANO");
  });

  test("a stream error is shown and committed once", async () => {
    const { session, seen } = makeSession([
      async function* () {
        yield { type: "text", text: "parte" };
        yield { type: "error", message: "falhou" };
      },
      answerTurn("ok"),
    ]);

    await session.send("oi");
    expect(session.getState().error).toBe("falhou");
    expect(session.getState().status).toBe("erro");

    await session.send("de novo");
    expect(seen[1]).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "parte\n\n[Erro: falhou]" },
      { role: "user", content: "de novo" },
    ]);
    expect(session.getState().error).toBeNull();
  });

  test("forwards raw stream events to listeners", async () => {
    const events: string[] = [];
    const { session } = makeSession([
      async function* () {
        yield { type: "tool_call", id: "c1", name: "read_file", args: "{}" };
        yield { type: "tool_result", id: "c1", name: "read_file", result: "r", isError: false };
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);
    session.onStreamEvent((ev) => events.push(ev.type));

    await session.send("oi");

    expect(events).toEqual(["tool_call", "tool_result", "done"]);
  });

  test("mode and reasoning cycle only while idle", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session } = makeSession([
      async function* () {
        await gate;
        yield { type: "done", content: "fim", reasoning: "", messages: [] };
      },
    ]);

    session.cycleMode();
    expect(session.getState().mode).toBe("sistema");
    session.setReasoning("high");
    expect(session.getState().reasoning).toBe("high");

    const turn = session.send("oi");
    session.cycleMode();
    expect(session.getState().mode).toBe("sistema");
    release();
    await turn;
    await session.close();
  });

  test("close aborts the running turn and refuses new messages", async () => {
    const { session, seen } = makeSession([
      async function* (opts) {
        yield { type: "text", text: "parcial" };
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")));
        });
      },
    ]);

    const turn = session.send("oi");
    await waitFor(session, () => session.getState().liveText === "parcial");
    await session.close();
    await turn;
    await session.send("depois");

    expect(session.getState().streaming).toBe(false);
    expect(seen.length).toBe(1);
  });
});
