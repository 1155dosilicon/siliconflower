import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import xterm from "@xterm/headless";
import { App } from "../src/App.js";

// Types into the real TUI, against a fake provider: the conversation lives in AgentSession,
// so this checks that the terminal front end still drives it like a user would.
const encoder = new TextEncoder();
const chunk = (delta: unknown, finish: string | null = null) =>
  encoder.encode(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
const DONE = encoder.encode("data: [DONE]\n\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const lastUser = body.messages.findLastIndex((m) => m.role === "user");
    const prompt = body.messages[lastUser].content;
    const lastTool = body.messages.slice(lastUser).findLast((m) => m.role === "tool");
    return new Response(
      new ReadableStream({
        start(c) {
          if (prompt === "lento") {
            c.enqueue(chunk({ content: "resposta parcial" }));
            return; // stays open until cancelled
          }
          if (prompt === "pergunte" && !lastTool) {
            const args = JSON.stringify({ question: "Qual cor?", options: ["azul", "verde"] });
            c.enqueue(chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "ask_question", arguments: args } }] }));
            c.enqueue(chunk({}, "tool_calls"));
          } else {
            c.enqueue(chunk({ content: lastTool ? `Ferramenta disse: ${lastTool.content}` : `Recebi: ${prompt}` }));
            c.enqueue(chunk({}, "stop"));
          }
          c.enqueue(DONE);
          c.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  },
});

afterAll(() => {
  provider.stop(true);
});

function mountTui() {
  const term = new xterm.Terminal({ cols: 120, rows: 45, scrollback: 1000, convertEol: true, allowProposedApi: true });
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 45,
    isTTY: true,
    write(data: string) {
      term.write(data);
      return true;
    },
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const config = { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "k", model: "teste", reasoning: "none" as const, mcpServers: {} };
  const app = render(React.createElement(App, { config, overrides: {} }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const screen = async () => {
    await new Promise<void>((resolve) => term.write("", resolve));
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true));
    return lines.join("\n");
  };
  const waitForScreen = async (text: string, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((await screen()).includes(text)) return;
      await sleep(25);
    }
    throw new Error(`"${text}" não apareceu na tela:\n${await screen()}`);
  };
  const type = async (text: string) => {
    stdin.write(text);
    await sleep(60);
  };
  return { app, screen, waitForScreen, type };
}

describe("TUI over AgentSession", () => {
  test("sends a message, shows the answer and clears the input", async () => {
    const t = mountTui();
    try {
      await t.waitForScreen("pronto");
      await t.type("ola mundo");
      await t.waitForScreen("> ola mundo");
      await t.type("\r");
      await t.waitForScreen("Recebi: ola mundo");
      await t.waitForScreen("digite para a LLM...");
    } finally {
      t.app.unmount();
    }
  }, 15000);

  test("Ctrl+O and Ctrl+E change the mode and the reasoning", async () => {
    const t = mountTui();
    try {
      await t.waitForScreen("pronto");
      await t.waitForScreen("Mode: PROG");
      await t.type("\x0f");
      await t.waitForScreen("Mode: SISTEMA");
      await t.type("\x05");
      await t.waitForScreen("Reasoning: low");
    } finally {
      t.app.unmount();
    }
  }, 15000);

  test("Ctrl+C cancels a running response without closing the app", async () => {
    const t = mountTui();
    try {
      await t.waitForScreen("pronto");
      await t.type("lento");
      await t.type("\r");
      await t.waitForScreen("resposta parcial");
      await t.waitForScreen("gerando resposta");
      await t.type("\x03");
      await t.waitForScreen("cancelado");
      await t.waitForScreen("digite para a LLM...");
      await t.type("depois");
      await t.type("\r");
      await t.waitForScreen("Recebi: depois");
    } finally {
      t.app.unmount();
    }
  }, 15000);

  test("answers ask_question by the option number", async () => {
    const t = mountTui();
    try {
      await t.waitForScreen("pronto");
      await t.type("pergunte");
      await t.type("\r");
      await t.waitForScreen("Qual cor?");
      await t.waitForScreen("2. verde");
      await t.type("2");
      await t.type("\r");
      await t.waitForScreen("Ferramenta disse: Resposta do usuário: verde");
    } finally {
      t.app.unmount();
    }
  }, 15000);
});
