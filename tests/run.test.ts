import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/session.js";
import { HEADLESS_ANSWER, closeHeadless, runHeadless } from "../src/run.js";
import type { ChatOptions } from "../src/llm.js";
import type { AppConfig, StreamEvent } from "../src/types.js";

const config: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "teste", reasoning: "none", mcpServers: {} };

type FakeTurn = (opts: ChatOptions) => AsyncGenerator<StreamEvent>;

async function run(turn: FakeTurn, prompt = "faça") {
  const session = new AgentSession(config, {}, { stream: (opts) => turn(opts) });
  const progress: string[] = [];
  try {
    return { result: await runHeadless(session, prompt, { onProgress: (line) => progress.push(line) }), progress, session };
  } finally {
    await closeHeadless(session);
  }
}

describe("runHeadless (siliconflower run)", () => {
  test("returns the final answer and reports each tool call", async () => {
    const { result, progress } = await run(async function* () {
      yield { type: "tool_call", id: "c1", name: "read_file", args: "{}" };
      yield { type: "tool_result", id: "c1", name: "read_file", result: "x", isError: false };
      yield { type: "text", text: "pronto" };
      yield { type: "done", content: "pronto", reasoning: "", messages: [{ role: "assistant", content: "pronto" }] };
    });

    expect(result).toEqual({ ok: true, text: "pronto", error: null, cancelled: false });
    expect(progress).toEqual(["[ferramenta] read_file"]);
  });

  test("ask_question is answered at once, with nobody there", async () => {
    let answer = "";
    const { result } = await run(async function* (opts) {
      answer = (await opts.executeTool("ask_question", { question: "Qual?", options: ["azul", "verde"] })).result;
      yield { type: "done", content: "fim", reasoning: "", messages: [{ role: "assistant", content: "fim" }] };
    });

    expect(answer).toContain(HEADLESS_ANSWER);
    expect(result.ok).toBe(true);
  });

  test("a provider error fails the run", async () => {
    const { result } = await run(async function* () {
      yield { type: "text", text: "parcial" };
      yield { type: "error", message: "401 chave inválida" };
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("401 chave inválida");
  });

  test("an empty response fails the run instead of printing the note", async () => {
    const { result } = await run(async function* () {
      yield { type: "done", content: "", reasoning: "", messages: [] };
    });

    expect(result).toEqual({ ok: false, text: "", error: "o modelo encerrou a resposta sem escrever nada", cancelled: false });
  });

  test("a cancelled turn fails the run as cancelled", async () => {
    const session = new AgentSession(config, {}, {
      stream: async function* (opts) {
        yield { type: "text", text: "parcial" };
        queueMicrotask(() => session.cancel());
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")));
        });
      },
    });
    try {
      const result = await runHeadless(session, "faça");
      expect(result.ok).toBe(false);
      expect(result.cancelled).toBe(true);
    } finally {
      await closeHeadless(session);
    }
  });
});
