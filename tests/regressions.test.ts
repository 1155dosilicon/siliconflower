import { describe, expect, test, afterAll } from "bun:test";
import { writeFile, readFile, rm, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runShell, decodeClixml, withoutSecrets } from "../src/shell.js";
import { htmlToMarkdown, isPrivateAddress, webFetch } from "../src/services/web.js";
import { buildOpenAIMessages, isConnectionDrop, isOfficialOpenAIEndpoint, NOT_RUN_AFTER_CANCEL, streamChat } from "../src/llm.js";
import { McpManager, qualifyMcpToolName, resolveMcpToolName, toolNotFoundMessage } from "../src/mcp.js";
import { AgentSession } from "../src/session.js";
import { ConversationStore, newRevision } from "../src/services/conversations.js";
import { askAfterSteps, DEFAULT_ASK_AFTER_STEPS, knownSecrets, normalize, redactKnownSecrets } from "../src/config.js";
import { getGlobalDataDir } from "../src/fs-util.js";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact, getArtifactsDir } from "../src/services/artifact.js";
import { smartEditFile } from "../src/services/smart-edit.js";
import { runBuiltin } from "../src/tools.js";
import { extractSymbols, generateRepoMap } from "../src/services/repomap.js";
import { GREP_MAX_MATCHES, searchContent } from "../src/grep.js";
import { getBackgroundTask, killAllBackgroundTasks, startBackgroundCommand } from "../src/services/background-tasks.js";
import type { AppConfig, ChatMessage, McpTool, StreamEvent } from "../src/types.js";

const tmp = join(tmpdir(), `sf_regressions_${Date.now()}`);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const isWin = process.platform === "win32";

describe("shell runner", () => {
  test("returns UTF-8 output (accents are not corrupted)", async () => {
    const res = await runShell(isWin ? `Write-Output 'ação ç "aspas"'` : `printf '%s\\n' 'ação ç "aspas"'`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('ação ç "aspas"');
  });

  test("returns stderr as plain text and the real exit code", async () => {
    const res = await runShell(isWin ? `Write-Error 'falhou é'; exit 3` : `echo 'falhou é' >&2; exit 3`);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("falhou é");
    expect(res.stderr).not.toContain("CLIXML");
    expect(res.stderr).not.toContain("OutputEncoding");
  });

  test("timeout kills the command", async () => {
    const started = Date.now();
    const res = await runShell(isWin ? "Start-Sleep -Seconds 20" : "sleep 20", { timeout: 1000 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  test.skipIf(isWin)("timeout kills child processes too (no orphans)", async () => {
    const marker = `29.${Date.now() % 100000}`; // unique sleep argument to find the child in ps
    // The subshell keeps the pipes open, so the runner only returns once the whole group dies.
    const started = Date.now();
    const res = await runShell(`sleep ${marker} & wait`, { timeout: 800 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10000);
    const ps = await runShell(`ps -eo args | grep -v grep | grep -c "sleep ${marker}" || true`);
    expect(ps.stdout.trim()).toBe("0");
  });

  test("decodes CLIXML error records", () => {
    const xml = `#< CLIXML\r\n<Objs><S S="Error">linha 1_x000D__x000A_</S><S S="Error">a &lt;b&gt; &amp; c</S></Objs>`;
    expect(decodeClixml(xml)).toBe("linha 1\r\na <b> & c");
  });
});

describe("a response cut off at the output limit", () => {
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    id: "x",
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta, finish_reason }],
  });

  async function run(responses: Response[]) {
    const requests: { messages: { role: string; content?: string; tool_calls?: { function: { arguments: string } }[] }[] }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        requests.push((await req.json()) as (typeof requests)[number]);
        return responses[requests.length - 1]!;
      },
    });
    const executed: string[] = [];
    const events: { type: string; text?: string; content?: string; isError?: boolean; result?: string }[] = [];
    try {
      const stream = streamChat({
        config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", reasoning: "none", mcpServers: {} },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        executeTool: async (name) => {
          executed.push(name);
          return { result: "ok", isError: false };
        },
      });
      for await (const event of stream) events.push(event as (typeof events)[number]);
    } finally {
      server.stop(true);
    }
    return { requests, executed, events };
  }

  test("does not run a tool with truncated arguments and tells the model", async () => {
    const { requests, executed, events } = await run([
      sse([
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a.html","content":"<html' } }] }),
        chunk({}, "length"),
      ]),
      sse([chunk({ content: "refeito" }, "stop")]),
    ]);
    expect(executed).toEqual([]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.isError).toBe(true);
    expect(result.result).toContain("limite de 32768 tokens");
    // The next request must carry valid JSON, followed by the tool result.
    const sent = requests[1]!.messages;
    const assistant = sent.find((m) => m.tool_calls)!;
    expect(assistant.tool_calls![0]!.function.arguments).toBe("{}");
    expect(sent[sent.indexOf(assistant) + 1]!.role).toBe("tool");
  });

  test("warns when the text of the answer is cut off", async () => {
    const { events } = await run([sse([chunk({ content: "metade" }, "length")])]);
    const done = events.find((e) => e.type === "done")!;
    expect(done.content).toContain("metade");
    expect(done.content).toContain("Resposta cortada");
    expect(events.some((e) => e.type === "text" && e.text?.includes("Resposta cortada"))).toBe(true);
  });

  test("a stream that ends without finish_reason does not run a partial tool call and says why", async () => {
    const { executed, events } = await run([
      sse([chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a.html","content":"<ht' } }] })]),
      sse([chunk({ content: "refeito" }, "stop")]),
    ]);
    expect(executed).toEqual([]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.isError).toBe(true);
    expect(result.result).toContain("interrompida");
    expect(result.result).not.toContain("Corrija");
  });

  test("warns when the text of the answer is interrupted, but not when it finished", async () => {
    const cut = await run([sse([chunk({ content: "metade" })])]);
    expect(cut.events.find((e) => e.type === "done")!.content).toContain("Resposta interrompida");
    const whole = await run([sse([chunk({ content: "inteira" }, "stop")])]);
    expect(whole.events.find((e) => e.type === "done")!.content).toBe("inteira");
  });

  test("write_file reports bytes, not characters", async () => {
    const res = await runBuiltin("write_file", { path: join(tmp, "bytes.txt"), content: "ação" });
    expect(res.result).toContain("(6 bytes)");
  });

  test("a model with a smaller output cap falls back once and keeps the lower limit", async () => {
    const tooLarge = () =>
      new Response(`{"error":{"message":"max_tokens is too large: 32768. This model's maximum for this value is 16384."}}`, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const { requests, events } = await run([
      tooLarge(),
      sse([
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todowrite", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
      ]),
      sse([chunk({ content: "pronto" }, "stop")]),
    ]);
    const limits = (requests as unknown as { max_tokens: number }[]).map((r) => r.max_tokens);
    expect(limits).toEqual([32768, 16384, 16384]);
    expect(events.find((e) => e.type === "done")!.content).toContain("pronto");
  });

  test("write_file without path or content changes nothing", async () => {
    const path = join(tmp, "write-file-args.txt");
    await runBuiltin("write_file", { path, content: "original" });
    expect((await runBuiltin("write_file", { content: "x" })).isError).toBe(true);
    expect((await runBuiltin("write_file", { path })).isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("original");
  });
});

describe("a provider that refuses a valid request without explaining", () => {
  const config: AppConfig = { baseURL: "", apiKey: "k", model: "m", reasoning: "none", mcpServers: {} };
  const chunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

  async function run(responses: (() => Response)[]) {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => (responses[calls++] ?? responses.at(-1)!)(),
    });
    const events: { type: string; content?: string; message?: string }[] = [];
    try {
      const stream = streamChat({
        config: { ...config, baseURL: `http://127.0.0.1:${server.port}/v1` },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: "", isError: false }),
      });
      for await (const event of stream) events.push(event);
    } finally {
      server.stop(true);
    }
    return { calls, events };
  }
  const refuse = (message: string) => () => Response.json({ error: { message } }, { status: 400 });
  const ok = () => new Response(chunk, { headers: { "Content-Type": "text/event-stream" } });

  test("repeats the request once, and the conversation never sees the error", async () => {
    const { calls, events } = await run([refuse("Request failed"), ok]);
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "done")?.content).toBe("ok");
  });

  test("does not insist if it happens again", async () => {
    const { calls, events } = await run([refuse("Request failed")]);
    expect(calls).toBe(2);
    expect(events.find((e) => e.type === "error")?.message).toContain("Request failed");
  });

  test("a 400 that explains itself is a real error, shown at once", async () => {
    const { calls, events } = await run([refuse("model not found")]);
    expect(calls).toBe(1);
    expect(events.find((e) => e.type === "error")?.message).toContain("model not found");
  });
});

describe("a provider that does not know the deeper reasoning levels", () => {
  const chunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

  /** `accepted` are the reasoning_effort values the fake provider takes. */
  async function run(reasoning: "high" | "max" | "ultra", accepted: string[]) {
    const efforts: (string | undefined)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const effort = ((await req.json()) as { reasoning_effort?: string }).reasoning_effort;
        efforts.push(effort);
        if (effort !== undefined && !accepted.includes(effort)) {
          return Response.json({ error: { message: `'reasoning_effort' must be one of: ${accepted.join(", ")}` } }, { status: 400 });
        }
        return new Response(chunk, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const events: { type: string; content?: string; message?: string }[] = [];
    try {
      const stream = streamChat({
        config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", reasoning, mcpServers: {} },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning,
        executeTool: async () => ({ result: "", isError: false }),
      });
      for await (const event of stream) events.push(event);
    } finally {
      server.stop(true);
    }
    return { efforts, events };
  }

  test("max and ultra are sent as they are when the provider takes them", async () => {
    expect((await run("max", ["high", "max", "ultra"])).efforts).toEqual(["max"]);
    expect((await run("ultra", ["high", "max", "ultra"])).efforts).toEqual(["ultra"]);
  });

  test("a refused max falls back to high, keeping the thinking on", async () => {
    const { efforts, events } = await run("max", ["low", "medium", "high"]);
    expect(efforts).toEqual(["max", "high"]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "done")?.content).toBe("ok");
  });

  test("a provider with no reasoning_effort at all still answers", async () => {
    const { efforts, events } = await run("ultra", []);
    expect(efforts).toEqual(["ultra", "high", undefined]);
    expect(events.find((e) => e.type === "done")?.content).toBe("ok");
  });

  test("a refused high is still dropped, as before", async () => {
    expect((await run("high", [])).efforts).toEqual(["high", undefined]);
  });
});

describe.skipIf(isWin)("closing the app", () => {
  const start = async (build: (marker: string) => string) => {
    const marker = `29.${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`; // unique sleep argument, to find it in ps
    const count = async () => Number((await runShell(`ps -eo args | grep -v grep | grep -c "sleep ${marker}" || true`)).stdout.trim());
    const id = startBackgroundCommand(build(marker), process.cwd(), 120_000);
    for (let i = 0; i < 50 && (await count()) === 0; i++) await Bun.sleep(50);
    expect(await count()).toBeGreaterThan(0);
    return { id, count };
  };

  test("background commands and what they started do not survive as orphans", async () => {
    const { id, count } = await start((m) => `sleep ${m} & wait`);
    await killAllBackgroundTasks();
    expect(await count()).toBe(0);
    expect(getBackgroundTask(id)?.status).toBe("killed");
  }, 30_000);

  test("reaches a child that outlived the shell", async () => {
    const { count } = await start((m) => `sleep ${m} &`);
    await killAllBackgroundTasks();
    expect(await count()).toBe(0);
  }, 30_000);

  test("a command that ignores SIGTERM gets SIGKILL", async () => {
    const { count } = await start((m) => `trap '' TERM; sleep ${m} & wait`);
    await killAllBackgroundTasks();
    await Bun.sleep(100);
    expect(await count()).toBe(0);
  }, 30_000);
});

describe("web", () => {
  test("blocks IPv4-mapped IPv6 loopback in hex form (as serialized by URL)", () => {
    const host = new URL("http://[::ffff:127.0.0.1]/").hostname.replace(/^\[|\]$/g, "");
    expect(isPrivateAddress(host)).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  test("decodes entities once and supports astral code points", () => {
    expect(htmlToMarkdown("<p>&amp;lt;tag&amp;gt;</p>")).toBe("&lt;tag&gt;");
    expect(htmlToMarkdown("<p>&#128512; &#x1F600;</p>")).toBe("😀 😀");
  });

  test("maxChars limits the converted text, not the raw HTML", async () => {
    const head = `<head>${"<script>var x = 1;</script>".repeat(2000)}</head>`;
    const html = `<html>${head}<body><h1>Conteúdo real</h1><p>Texto do artigo.</p></body></html>`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    try {
      // A public IP literal skips DNS; fetch itself is mocked.
      const res = await webFetch("http://93.184.216.34/", { maxChars: 1000 });
      expect(res.isError).toBe(false);
      expect(res.content).toContain("# Conteúdo real");
      expect(res.content).toContain("Texto do artigo.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("cancelling a stream", () => {
  // The OpenAI SDK ends the iteration silently on abort, which used to look like a normal end
  // of response: the turn was stored as complete and buffered tool calls still ran.
  function serveChunks(deltas: unknown[], afterSent: () => void) {
    const encoder = new TextEncoder();
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(c) {
              for (const delta of deltas) {
                const chunk = { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] };
                c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              afterSent();
              // Never closes: the response is still running when it gets cancelled.
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });
  }

  const toolCall = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"x.txt"}' } }] };

  test("raises AbortError instead of finishing the turn or running buffered tools", async () => {
    const controller = new AbortController();
    const server = serveChunks([{ content: "parcial" }, toolCall], () => setTimeout(() => controller.abort(), 50));
    const executed: string[] = [];
    const events: string[] = [];
    let thrown: unknown;
    try {
      for await (const ev of streamChat({
        config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", reasoning: "none" },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        signal: controller.signal,
        executeTool: async (name) => {
          executed.push(name);
          return { result: "ok", isError: false };
        },
      })) {
        events.push(ev.type);
      }
    } catch (e) {
      thrown = e;
    } finally {
      server.stop(true);
    }
    expect((thrown as Error)?.name).toBe("AbortError");
    expect(executed).toEqual([]);
    expect(events).not.toContain("done");
  });

  test("does not start the remaining tools of a step after a cancel", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch() {
        const calls = ["a", "b"].map((name, index) => ({
          id: "x",
          object: "chat.completion.chunk",
          choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index, id: name, type: "function", function: { name, arguments: "{}" } }] } }],
        }));
        const body = [...calls.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
        return new Response(encoder.encode(body), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const controller = new AbortController();
    const executed: string[] = [];
    let thrown: unknown;
    try {
      for await (const _ of streamChat({
        config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", reasoning: "none" },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        signal: controller.signal,
        executeTool: async (name) => {
          executed.push(name);
          controller.abort();
          return { result: "cancelado", isError: true };
        },
      })) { /* consume */ }
    } catch (e) {
      thrown = e;
    } finally {
      server.stop(true);
    }
    expect((thrown as Error)?.name).toBe("AbortError");
    expect(executed).toEqual(["a"]);
  });
});

describe("llm adapter", () => {
  const config: AppConfig = { baseURL: "https://api.siliconflow.com/v1", apiKey: "k", model: "m", reasoning: "none" };

  test("detects the official OpenAI endpoint", () => {
    expect(isOfficialOpenAIEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://openrouter.ai/api/v1")).toBe(false);
  });

  test("skips tool results whose assistant tool call was compacted away", () => {
    const messages: ChatMessage[] = [
      { role: "tool", toolCallId: "gone", content: "orphan" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ];
    const out = buildOpenAIMessages(config, messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("config", () => {
  test("stored config ignores environment overrides", () => {
    const previous = process.env.SILICONFLOWER_API_KEY;
    process.env.SILICONFLOWER_API_KEY = "from-env";
    try {
      expect(normalize({ apiKey: "from-file" }).apiKey).toBe("from-env");
      expect(normalize({ apiKey: "from-file" }, { applyEnv: false }).apiKey).toBe("from-file");
    } finally {
      if (previous === undefined) delete process.env.SILICONFLOWER_API_KEY;
      else process.env.SILICONFLOWER_API_KEY = previous;
    }
  });
});

describe("artifacts", () => {
  const cwd = join(tmp, "art_ws");

  test("titles and summaries with quotes round-trip", async () => {
    const id = `quotes_${Date.now()}`;
    await createArtifact({ id, title: 'Plano "A"', type: "markdown", content: "x", summary: 'Diz "oi"', cwd });
    const item = (await listArtifacts(cwd)).find((a) => a.id === id);
    expect(item?.title).toBe('Plano "A"');
    expect(item?.summary).toBe('Diz "oi"');
    await deleteArtifact(id, cwd);
  });

  test("changing the type replaces the previous file and keeps metadata for html", async () => {
    const id = `retype_${Date.now()}`;
    await createArtifact({ id, title: "Doc", type: "markdown", content: "# md", summary: "s", cwd });
    await createArtifact({ id, title: "Página", type: "html", content: "<p>html</p>", summary: "resumo html", cwd });
    const files = (await readdir(getArtifactsDir(cwd))).filter((f) => f.startsWith(id));
    expect(files.sort()).toEqual([`${id}.html`, `${id}.meta`]);
    expect((await readArtifact(id, cwd))?.content).toBe("<p>html</p>");
    const item = (await listArtifacts(cwd)).find((a) => a.id === id);
    expect(item?.title).toBe("Página");
    expect(item?.summary).toBe("resumo html");
    expect((await deleteArtifact(id, cwd)).success).toBe(true);
    expect((await readdir(getArtifactsDir(cwd))).filter((f) => f.startsWith(id))).toEqual([]);
  });
});

describe("file edits keep CRLF line endings", () => {
  test("edit_file exact match converts newText to CRLF", async () => {
    const file = join(tmpdir(), `crlf_edit_${Date.now()}.txt`);
    await writeFile(file, "a\r\nb\r\nc\r\n", "utf8");
    const res = await smartEditFile({ path: file, oldText: "b", newText: "b1\nb2" });
    expect(res.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("a\r\nb1\r\nb2\r\nc\r\n");
    await rm(file, { force: true });
  });

  test("apply_patch matches LF oldText in a CRLF file", async () => {
    const file = join(tmpdir(), `crlf_patch_${Date.now()}.txt`);
    await writeFile(file, "x\r\ny\r\nz\r\n", "utf8");
    const res = await runBuiltin("apply_patch", { path: file, changes: [{ oldText: "x\ny", newText: "x\nnovo\ny" }] });
    expect(res.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("x\r\nnovo\r\ny\r\nz\r\n");
    await rm(file, { force: true });
  });
});

describe("ask_question", () => {
  test("waits for the interactive answer when the interface provides askUser", async () => {
    const res = await runBuiltin(
      "ask_question",
      { question: "Qual?", options: ["A", "B"] },
      { askUser: async (_q, opts) => opts![1] }
    );
    expect(res.isError).toBe(false);
    expect(res.result).toBe("Resposta do usuário: B");
  });

  test("tells the model to relay the question when there is no UI", async () => {
    const res = await runBuiltin("ask_question", { question: "Qual?" });
    expect(res.result).toContain("SEM INTERFACE INTERATIVA");
  });
});

describe("repo map and grep", () => {
  test("extracts Rust symbols and TS enums", () => {
    const rs = extractSymbols("pub fn run(x: i32) {}\npub struct Cfg {}\nenum Mode {}\n", ".rs");
    expect(rs.map((s) => s.name)).toEqual(["run", "Cfg", "Mode"]);
    const ts = extractSymbols("export enum Color { Red }\n", ".ts");
    expect(ts[0]).toMatchObject({ name: "Color", kind: "enum" });
  });

  test("maxFiles counts only files that contribute symbols", async () => {
    const dir = join(tmp, "repomap_max");
    await rm(dir, { recursive: true, force: true });
    await Bun.write(join(dir, "a_empty.ts"), "const x = 1;\n");
    await Bun.write(join(dir, "b_empty.ts"), "const y = 2;\n");
    await Bun.write(join(dir, "c_real.ts"), "export function real() {}\n");
    const res = await generateRepoMap(dir, { maxFiles: 1 });
    expect(res.fileCount).toBe(1);
    expect(res.mapText).toContain("real");
  });

  test("grep searches inside bin/ folders", async () => {
    const dir = join(tmp, "grep_bin");
    await Bun.write(join(dir, "bin", "tool.js"), "const marker = 'agulha';\n");
    const matches = await searchContent({ basePath: dir, pattern: "agulha" });
    expect(matches.length).toBe(1);
  });

  test("grep_content says when it stopped at the match limit", async () => {
    const dir = join(tmp, "grep_limit");
    await Bun.write(join(dir, "many.txt"), "agulha\n".repeat(GREP_MAX_MATCHES + 5));
    const cut = await runBuiltin("grep_content", { path: dir, pattern: "agulha" });
    expect(cut.result).toContain("busca interrompida");

    await Bun.write(join(dir, "many.txt"), "agulha\n".repeat(3));
    const whole = await runBuiltin("grep_content", { path: dir, pattern: "agulha" });
    expect(whole.result).not.toContain("busca interrompida");
  });

  test("edit_file refuses a whitespace-flexible match that is ambiguous", async () => {
    const path = join(tmp, "ambiguous.ts");
    const original = "  if (x) {\n  }\n    if (x) {\n    }\n";
    await Bun.write(path, original);
    const res = await smartEditFile({ path, oldText: "if  (x)  {", newText: "if (y) {" });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("ambíguo");
    expect(await readFile(path, "utf8")).toBe(original);

    const all = await smartEditFile({ path, oldText: "if  (x)  {", newText: "if (y) {", replaceAll: true });
    expect(all.isError).toBe(false);
    expect((await readFile(path, "utf8")).match(/if \(y\)/g)?.length).toBe(2);
  });
});

// Windows: the Unix tests above count `sleep` with ps; here the tree is counted with CIM.
describe.skipIf(!isWin)("closing the app (Windows)", () => {
  test("background commands and what they started do not survive as orphans", async () => {
    const marker = `sf-orphan-${process.pid}-${Date.now()}`;
    const countSleepers = async () => {
      const res = await runShell(
        `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '${marker}' }).Count`
      );
      return Number(res.stdout.trim());
    };
    // The grandchild is another PowerShell: only killing the whole tree reaches it.
    const id = startBackgroundCommand(
      `powershell.exe -NoProfile -Command "Start-Sleep 60 # ${marker}"`,
      process.cwd(),
      120_000
    );
    for (let i = 0; i < 50 && (await countSleepers()) === 0; i++) await Bun.sleep(100);
    expect(await countSleepers()).toBeGreaterThan(0);

    await killAllBackgroundTasks();

    expect(await countSleepers()).toBe(0);
    expect(getBackgroundTask(id)?.status).toBe("killed");
  }, 30_000);
});

/** Scripted OpenAI-compatible provider: `reply` decides each response from the request body. */
type Reply = { text: string } | { tools: { name: string; args: Record<string, unknown> }[] } | { status: number; message: string };
type SentMessage = { role: string; content?: string; tool_calls?: { function: { name: string } }[] };
type SentBody = { messages: SentMessage[] };

function fakeProvider(reply: (body: SentBody) => Reply) {
  const requests: SentBody[] = [];
  let ids = 0;
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    id: "x",
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta, finish_reason }],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as SentBody;
      requests.push(body);
      const r = reply(body);
      if ("status" in r) return Response.json({ error: { message: r.message } }, { status: r.status });
      const chunks = "text" in r
        ? [chunk({ content: r.text }), chunk({}, "stop")]
        : [
            chunk({ tool_calls: r.tools.map((t, index) => ({ index, id: `c${++ids}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) }),
            chunk({}, "tool_calls"),
          ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const config: AppConfig = { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", reasoning: "none", mcpServers: {} };
  return { config, requests, stop: () => server.stop(true) };
}

/** What a request carried besides the system prompt. */
const conversation = (body: SentBody | undefined) => (body?.messages ?? []).filter((m) => m.role !== "system");
const toolResults = (body: SentBody | undefined) => conversation(body).filter((m) => m.role === "tool");

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error("condition not reached");
  }
}

describe("an interrupted turn keeps what its tools did", () => {
  // The model used to get only "[Erro: ...]": it redid edits and commands it did not know about.
  test("a provider error after a tool step keeps that step for the next turn", async () => {
    const target = join(tmp, `passo-${Date.now()}.txt`);
    let n = 0;
    const provider = fakeProvider(() => {
      n++;
      if (n === 1) return { tools: [{ name: "write_file", args: { path: target, content: "conteudo" } }] };
      if (n === 2) return { status: 400, message: "falha do provedor" };
      return { text: "ok" };
    });
    try {
      const session = new AgentSession(provider.config);
      await session.send("crie o arquivo");
      expect(await readFile(target, "utf8")).toBe("conteudo");
      await session.send("continue");
      const sent = conversation(provider.requests[2]);
      expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
      expect(sent[1]!.tool_calls![0]!.function.name).toBe("write_file");
      expect(sent[3]!.content).toContain("[Erro:");
    } finally {
      provider.stop();
    }
  });

  test("cancelling in the middle of a step keeps what ran and answers the calls that did not", async () => {
    const target = join(tmp, `nao-roda-${Date.now()}.txt`);
    let n = 0;
    const provider = fakeProvider(() =>
      ++n === 1
        ? {
            tools: [
              { name: "execute_command", args: { command: isWin ? "Start-Sleep -Seconds 30" : "sleep 30" } },
              { name: "write_file", args: { path: target, content: "x" } },
            ],
          }
        : { text: "ok" }
    );
    try {
      const session = new AgentSession(provider.config);
      const turn = session.send("rode");
      await until(() => session.getState().status.includes("execute_command"));
      session.cancel();
      await turn;
      expect(existsSync(target)).toBe(false);
      await session.send("e agora?");
      const sent = conversation(provider.requests[1]);
      expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "user"]);
      expect(sent[3]!.content).toBe(NOT_RUN_AFTER_CANCEL);
      expect(sent[4]!.content).toContain("interrompido pelo usuário");
    } finally {
      provider.stop();
    }
  }, 30_000);
});

describe("a long task is not cut by a step limit", () => {
  // The loop used to stop after 50 tool steps and ask the user to send "continue".
  test("a turn with more than 50 tool steps runs until the model answers", async () => {
    const steps = 60;
    let n = 0;
    const provider = fakeProvider(() => (++n <= steps ? { tools: [{ name: "passo", args: { n } }] } : { text: "terminei" }));
    try {
      let ran = 0;
      let answer: string | undefined;
      for await (const ev of streamChat({
        config: provider.config,
        messages: [{ role: "user", content: "tarefa longa" }],
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: `ok ${++ran}`, isError: false }),
      })) {
        if (ev.type === "done") answer = ev.content;
      }
      expect(ran).toBe(steps);
      expect(provider.requests).toHaveLength(steps + 1);
      expect(answer).toBe("terminei");
    } finally {
      provider.stop();
    }
  }, 30_000);
});

describe("tool results are bounded wherever they come from", () => {
  // MCP servers, background task status and subagents skipped processToolOutput: one big
  // result made the compaction cut the user's request and every other message.
  test("a 3 MB result reaches the model truncated, with the full text saved", async () => {
    let n = 0;
    const provider = fakeProvider(() => (++n === 1 ? { tools: [{ name: "mcp_x", args: {} }] } : { text: "ok" }));
    try {
      const events: { type: string; result?: string }[] = [];
      for await (const ev of streamChat({
        config: provider.config,
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: "x".repeat(3_000_000), isError: false }),
      })) {
        events.push(ev as (typeof events)[number]);
      }
      const result = events.find((e) => e.type === "tool_result")!.result!;
      expect(result).toContain("SAÍDA GRANDE TRUNCADA");
      expect(result.length).toBeLessThan(40_000);
      expect(toolResults(provider.requests[1])[0]!.content!.length).toBeLessThan(40_000);
    } finally {
      provider.stop();
    }
  });
});

describe("subagents", () => {
  const isSubagent = (body: SentBody) => String(body.messages[0]?.content ?? "").startsWith("# Papel");

  test("cannot replace the user's checklist nor run tools they were not offered", async () => {
    const provider = fakeProvider((body) => {
      const done = toolResults(body).length;
      if (isSubagent(body)) {
        return done === 0
          ? {
              tools: [
                { name: "todowrite", args: { todos: [{ content: "do subagente", status: "pending", priority: "low" }] } },
                { name: "run_task", args: { description: "outro", prompt: "recursão" } },
              ],
            }
          : { text: "pesquisa pronta" };
      }
      if (done === 0) return { tools: [{ name: "todowrite", args: { todos: [{ content: "do usuário", status: "pending", priority: "high" }] } }] };
      if (done === 1) return { tools: [{ name: "run_task", args: { description: "pesquisa", prompt: "investigue", role: "research" } }] };
      return { text: "fim" };
    });
    const session = new AgentSession(provider.config);
    try {
      await session.start();
      await session.send("planeje e pesquise");
      expect(session.getState().todos.map((t) => t.content)).toEqual(["do usuário"]);
      const answered = provider.requests.find((b) => isSubagent(b) && toolResults(b).length > 0);
      expect(toolResults(answered).map((m) => m.content)).toEqual([
        "Ferramenta todowrite não disponível no subagente",
        "Ferramenta run_task não disponível no subagente",
      ]);
    } finally {
      await session.close();
      provider.stop();
    }
  });
});

describe("long searches and cancel", () => {
  test("grep, search, find_symbol and repo_map stop when the turn is cancelled", async () => {
    const dir = join(tmp, `busca-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 30; i++) await writeFile(join(dir, `f${i}.ts`), `export function alvo${i}() {}\n`);
    const signal = AbortSignal.abort();
    const calls: [string, Record<string, unknown>][] = [
      ["grep_content", { path: dir, pattern: "alvo" }],
      ["search_files", { path: dir, pattern: "**/*.ts" }],
      ["find_symbol", { symbolName: "alvo" }],
      ["repo_map", {}],
    ];
    for (const [name, args] of calls) {
      const res = await runBuiltin(name, args, { signal });
      expect(res).toMatchObject({ isError: true });
      expect(res.result).toContain("cancelada");
    }
  });

  test("find_symbol refuses an empty name, which matched every symbol", async () => {
    expect((await runBuiltin("find_symbol", { symbolName: "  " })).isError).toBe(true);
  });

  test("search_files skips .ssh and .aws even with includeHidden", async () => {
    const dir = join(tmp, `ocultos-${Date.now()}`);
    await mkdir(join(dir, ".ssh"), { recursive: true });
    await mkdir(join(dir, ".config"), { recursive: true });
    await writeFile(join(dir, ".ssh", "id_rsa"), "segredo");
    await writeFile(join(dir, ".config", "app.ini"), "ok");
    const res = await runBuiltin("search_files", { path: dir, pattern: "**/*", includeHidden: true });
    expect(res.result).toContain("app.ini");
    expect(res.result).not.toContain("id_rsa");
  });
});

describe("hooks", () => {
  const config: AppConfig = { baseURL: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", reasoning: "none", mcpServers: {} };

  // Any command the agent ran in a cloned repository (even `git status`) ran the repo's hook.
  test("a hooks.json inside a cloned repository never runs", async () => {
    const repo = join(tmp, `repo-${Date.now()}`);
    const marker = join(repo, "EXECUTOU");
    await mkdir(join(repo, ".siliconflower"), { recursive: true });
    const touch = isWin ? `New-Item -ItemType File -Path '${marker}' -Force | Out-Null` : `touch '${marker}'`;
    await writeFile(join(repo, ".siliconflower", "hooks.json"), JSON.stringify({ onCommand: touch, preTool: touch }));
    const res = await runBuiltin("execute_command", { command: "echo ok", cwd: repo }, { config });
    expect(res.result).toContain("ok");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  // The whole content went to SILICONFLOWER_TOOL_ARGS: E2BIG on Linux at 128 KB, sooner on Windows.
  test("still run when the tool's arguments are too big for an environment variable", async () => {
    const path = join(tmp, `grande-${Date.now()}.txt`);
    const res = await runBuiltin(
      "write_file",
      { path, content: "x".repeat(200_000) },
      { config: { ...config, hooks: { onEdit: "echo formatado" } }, mode: "programação" }
    );
    expect(res.result).toContain("formatado");
    expect(res.result).not.toContain("falhou");
  }, 30_000);
});

describe("background task list", () => {
  test("shows only the start of each output, so one big task does not hide the others", async () => {
    const id = startBackgroundCommand(isWin ? "'x' * 50000" : "head -c 50000 /dev/zero | tr '\\0' 'x'", process.cwd(), 30_000);
    await until(() => getBackgroundTask(id)?.status !== "running");
    const list = await runBuiltin("manage_background_task", { action: "list" });
    expect(list.result).toContain(id);
    expect(list.result).toContain("action='status'");
    expect(list.result.length).toBeLessThan(20_000);
    const status = await runBuiltin("manage_background_task", { action: "status", taskId: id });
    expect(status.result.length).toBeGreaterThan(50_000);
  }, 30_000);
});

// ---- Found by the 0.8.1 review (relatorio.md) -------------------------------------------

describe("hooks.json supplies every event", () => {
  const cfg: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "m", reasoning: "none" };

  test.skipIf(isWin)("preTool, onEdit, postTool and onCommand run from the workspace hooks.json", async () => {
    const { getWorkspaceDataDir } = await import("../src/fs-util.js");
    const { resolveHooks } = await import("../src/core/hooks.js");
    const dir = getWorkspaceDataDir(process.cwd());
    const mark = join(tmp, "hooks-ran.txt");
    await mkdir(dir, { recursive: true });
    await mkdir(tmp, { recursive: true });
    const hook = (name: string) => `echo ${name} >> '${mark}'`;
    const file = join(dir, "hooks.json");
    await writeFile(file, JSON.stringify({ preTool: hook("preTool"), postTool: hook("postTool"), onEdit: hook("onEdit"), onCommand: hook("onCommand") }));
    try {
      await runBuiltin("write_file", { path: join(tmp, "hooked.txt"), content: "x" }, { config: cfg });
      await runBuiltin("execute_command", { command: "true" }, { config: cfg });
      const ran = (await readFile(mark, "utf8")).trim().split("\n");
      expect(ran).toEqual(["preTool", "onEdit", "postTool", "preTool", "onCommand", "postTool"]);
      // config.json wins event by event; an empty value there does not hide the file's.
      expect(await resolveHooks({ onEdit: "inline", preTool: "  " })).toMatchObject({ onEdit: "inline", preTool: hook("preTool") });
      // Tool hooks stay off in the "plano" mode.
      await rm(mark);
      await runBuiltin("read_file", { path: join(tmp, "hooked.txt") }, { config: cfg, mode: "plano" });
      expect(existsSync(mark)).toBe(false);
    } finally {
      await rm(file, { force: true });
    }
  });
});

describe("history compaction", () => {
  test("a long but small conversation keeps its old tool results", async () => {
    const { compressHistory } = await import("../src/context.js");
    const messages: ChatMessage[] = [{ role: "user", content: "tarefa" }];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      messages.push({ role: "tool", toolCallId: `c${i}`, content: "x".repeat(2000) });
    }
    expect(compressHistory(messages)).toBe(messages);
  });

  test("contextTokens of config.json is bounded and optional", async () => {
    const { contextBudget, CONTEXT_TOKEN_BUDGET } = await import("../src/context.js");
    expect(contextBudget(undefined)).toBe(CONTEXT_TOKEN_BUDGET);
    expect(contextBudget("abc")).toBe(CONTEXT_TOKEN_BUDGET);
    expect(contextBudget(200_000)).toBe(200_000);
    expect(contextBudget(5)).toBe(8_000);
    expect(normalize({ contextTokens: 300_000 } as Partial<AppConfig>).contextTokens).toBe(300_000);
    expect("contextTokens" in normalize({})).toBe(false);
  });
});

describe("errors that looked like something else", () => {
  const cfg: AppConfig = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "m", reasoning: "none" };

  test("a network error with 'aborted' in its text is shown as an error, not as a cancel", async () => {
    const session = new AgentSession(cfg, {}, {
      stream: async function* () {
        throw new Error("socket hang up: connection aborted by peer");
      },
    });
    await session.send("oi");
    const state = session.getState();
    expect(state.status).toBe("erro");
    expect(state.error).toContain("aborted by peer");
    expect(state.messages.at(-1)?.content).not.toContain("cancelada");
  });

  test("isCancellation follows the turn's signal", async () => {
    const { isCancellation } = await import("../src/llm.js");
    const controller = new AbortController();
    expect(isCancellation(new Error("Request was aborted."), controller.signal)).toBe(false);
    controller.abort();
    expect(isCancellation(new Error("qualquer"), controller.signal)).toBe(true);
  });

  test("an empty response leaves a note instead of silence", async () => {
    const seen: ChatMessage[][] = [];
    let turn = 0;
    const session = new AgentSession(cfg, {}, {
      stream: async function* (opts) {
        seen.push(opts.messages);
        yield { type: "done", content: turn++ ? "ok" : "", reasoning: "", messages: [] };
      },
    });
    await session.send("oi");
    expect(session.getState().messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(session.getState().messages.at(-1)?.content).toContain("sem escrever nada");
    await session.send("de novo");
    expect(seen[1]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("a stream that stops sending data fails instead of hanging", async () => {
    const { withIdleTimeout } = await import("../src/llm.js");
    let aborted = false;
    async function* stalled() {
      yield 1;
      await new Promise(() => {});
    }
    const got: number[] = [];
    let error = "";
    try {
      for await (const value of withIdleTimeout(stalled(), undefined, () => { aborted = true; }, 50)) got.push(value);
    } catch (e) {
      error = String(e);
    }
    expect(got).toEqual([1]);
    expect(error).toContain("parou de enviar dados");
    expect(aborted).toBe(true);
  });
});

describe("glob and grep patterns", () => {
  test("wildcards inside braces work and dots there are literal", async () => {
    const { globToRegex } = await import("../src/glob-util.js");
    expect(globToRegex("{*.ts,*.js}").test("a.ts")).toBe(true);
    expect(globToRegex("{*.ts,*.js}").test("a.md")).toBe(false);
    expect(globToRegex("{a.b,c}").test("axb")).toBe(false);
    expect(globToRegex("src/{a,b{1,2}}/*.md").test("src/b2/x.md")).toBe(true);
    expect(globToRegex("**/*.{ts,tsx}").test("src/gui/a.tsx")).toBe(true);
    expect(globToRegex("a{b").test("a{b")).toBe(true);
  });

  test("search_files accepts a pattern with wildcards inside braces", async () => {
    const dir = join(tmp, "glob");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.ts"), "");
    await writeFile(join(dir, "b.md"), "");
    const res = await runBuiltin("search_files", { path: dir, pattern: "{*.ts,*.js}" });
    expect(res.isError).toBe(false);
    expect(res.result).toContain("a.ts");
    expect(res.result).not.toContain("b.md");
  });

  test("grep_content refuses a pattern that could freeze the agent", async () => {
    const { hasNestedRepetition } = await import("../src/grep.js");
    expect(hasNestedRepetition("(a+)+$")).toBe(true);
    expect(hasNestedRepetition("(\\w*)*x")).toBe(true);
    expect(hasNestedRepetition("(ab|cd)+")).toBe(false);
    expect(hasNestedRepetition("\\(a+\\)+")).toBe(false);
    const res = await runBuiltin("grep_content", { path: tmp, pattern: "(a+)+$" });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("repetição aninhada");
  });
});

describe("read_file and saved outputs", () => {
  test("a big file comes as a page of whole lines that says where to continue", async () => {
    await mkdir(tmp, { recursive: true });
    const file = join(tmp, "grande.txt");
    await writeFile(file, Array.from({ length: 20000 }, (_, i) => `linha ${i + 1}`).join("\n"));
    const first = await runBuiltin("read_file", { path: file, limit: 10000 });
    expect(first.result).not.toContain("SAÍDA GRANDE TRUNCADA");
    expect(first.result.startsWith("1: linha 1\n")).toBe(true);
    const next = Number(/offset=(\d+)/.exec(first.result)?.[1]);
    expect(next).toBeGreaterThan(100);
    const second = await runBuiltin("read_file", { path: file, offset: next, limit: 3 });
    expect(second.result).toBe(`${next}: linha ${next}\n${next + 1}: linha ${next + 1}\n${next + 2}: linha ${next + 2}`);
  });

  test("a huge single line is cut instead of filling the context", async () => {
    const file = join(tmp, "minificado.js");
    await writeFile(file, "x".repeat(100_000));
    const res = await runBuiltin("read_file", { path: file });
    expect(res.result.length).toBeLessThan(5000);
    expect(res.result).toContain("linha com 100000 caracteres");
  });

  test("old full outputs are deleted, recent ones stay", async () => {
    const { pruneOldOutputs, processToolOutput } = await import("../src/context.js");
    const saved = await processToolOutput("y".repeat(40_000));
    const path = /salva em: (.+)\]/.exec(saved)![1]!;
    expect(await pruneOldOutputs()).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await pruneOldOutputs(Date.now() + 8 * 24 * 3600 * 1000)).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe("edit_file keeps the line endings it does not touch", () => {
  test("a file with mixed endings is not rewritten as CRLF", async () => {
    await mkdir(tmp, { recursive: true });
    const file = join(tmp, "misto.txt");
    await writeFile(file, "um\r\ndois\ntres\nquatro\n");
    // Exact match fails (oldText has CRLF where the file has LF): newline-normalized strategy.
    const res = await smartEditFile({ path: file, oldText: "dois\r\ntres", newText: "2\n3" });
    expect(res.matchType).toBe("normalized_newlines");
    expect(await readFile(file, "utf8")).toBe("um\r\n2\n3\nquatro\n");
  });

  test("the whitespace-tolerant strategy also leaves the other lines alone", async () => {
    const file = join(tmp, "misto2.txt");
    await writeFile(file, "a\r\n  if (x) {\n    y();\n  }\nfim");
    const res = await smartEditFile({ path: file, oldText: "if (x) {\ny();\n}", newText: "if (z) {\n  w();\n}" });
    expect(res.matchType).toBe("fuzzy_whitespace");
    expect(await readFile(file, "utf8")).toBe("a\r\nif (z) {\n  w();\n}\nfim");
  });

  test("a CRLF file gets CRLF in the new text", async () => {
    const file = join(tmp, "crlf.txt");
    await writeFile(file, "a\r\nb\r\nc\r\n");
    await smartEditFile({ path: file, oldText: "b", newText: "b1\nb2" });
    expect(await readFile(file, "utf8")).toBe("a\r\nb1\r\nb2\r\nc\r\n");
  });
});

describe("memory and log details", () => {
  test("Windows: a memory named 'memory' does not take the index file's name", async () => {
    const { fileNameFor } = await import("../src/services/memory.js");
    expect(fileNameFor("Memory", true)).toBe("memory_.md");
    expect(fileNameFor("Memory", false)).toBe("memory.md");
    expect(fileNameFor("outra coisa", true)).toBe("outra_coisa.md");
  });

  test("credentials are masked before reaching the log", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const line = redactSecrets('curl -H "Authorization: Bearer abcdef123456789" https://u:senha123@host/x?api_key=ZZZZZZZZ9 sk-proj-abcdefghijklmnop');
    for (const secret of ["abcdef123456789", "senha123", "ZZZZZZZZ9", "abcdefghijklmnop"]) expect(line).not.toContain(secret);
    expect(line).toContain("curl -H");
    expect(redactSecrets("execute_command: git status (cwd=/home/x)")).toBe("execute_command: git status (cwd=/home/x)");
  });
});

describe("background commands", () => {
  test.skipIf(isWin)("the output so far can be read while the command runs", async () => {
    const id = startBackgroundCommand("echo primeira; sleep 30", process.cwd(), 60_000);
    try {
      for (let i = 0; i < 100 && !getBackgroundTask(id)?.result; i++) await new Promise((r) => setTimeout(r, 50));
      const res = await runBuiltin("manage_background_task", { action: "status", taskId: id });
      const status = JSON.parse(res.result);
      expect(status.status).toBe("running");
      expect(status.partialOutput).toContain("primeira");
    } finally {
      await killAllBackgroundTasks();
    }
  });
});

describe("two windows saving in the same millisecond", () => {
  // The conflict check compared only `updatedAt`, which has millisecond resolution: on a fast
  // machine both windows saved with the same stamp and the second one wrote over the first.
  test("a save from another window is noticed even with the same updatedAt", async () => {
    const store = new ConversationStore(join(tmp, "same-ms"));
    const body = { history: [], messages: [], activities: [], todos: [] };
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const seen = newRevision();
    await store.save({ id: "c", title: "t", updatedAt, messageCount: 0, rev: seen }, body);
    // The other window saves within the same millisecond.
    await store.save({ id: "c", title: "t", updatedAt, messageCount: 1, rev: newRevision() }, body, seen);
    const savedAs = await store.save({ id: "c", title: "t", updatedAt, messageCount: 2, rev: newRevision() }, body, seen);
    expect(savedAs).not.toBe("c");
  });

  test("files without rev still compare by updatedAt", async () => {
    const store = new ConversationStore(join(tmp, "no-rev"));
    const body = { history: [], messages: [], activities: [], todos: [] };
    await store.save({ id: "c", title: "t", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 0 }, body);
    expect(await store.stamp("c")).toBe("2026-01-01T00:00:00.000Z");
    expect(await store.save({ id: "c", title: "t", updatedAt: "x", messageCount: 0, rev: "r" }, body, "2026-01-01T00:00:00.000Z")).toBe("c");
  });
});

describe("compaction keeps what the model has not seen yet", () => {
  // Six big read_file results of one step were cut to 120 characters each before the model saw
  // them: it read the same files again and again until the time ran out.
  const fileLines = (name: string, lines: number) =>
    Array.from({ length: lines }, (_, i) => `${i + 1}: ${name} ${"x".repeat(90)}`).join("\n");
  const readStep = (prefix: string, files: string[], content = (f: string) => fileLines(f, 300)): ChatMessage[] => [
    {
      role: "assistant",
      content: "",
      toolCalls: files.map((f, i) => ({ id: `${prefix}${i}`, type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: f }) } })),
    },
    ...files.map((f, i) => ({ role: "tool" as const, toolCallId: `${prefix}${i}`, toolName: "read_file", content: content(f) })),
  ];

  test("the results of the step that just ran share the budget and say where to go on", async () => {
    const { compressHistory, estimateMessagesTokens } = await import("../src/context.js");
    const request = "Leia as seis partes e diga qual é o fato escondido.";
    const files = [1, 2, 3, 4, 5, 6].map((n) => `parte${n}.md`);
    const out = compressHistory([{ role: "user", content: request }, ...readStep("old", ["antigo.md"]), ...readStep("c", files)], 20_000);
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(20_000);
    expect(out[0]!.content).toBe(request);
    // The earlier step was already seen: it goes first.
    expect(out[2]!.content).toContain("já visto");
    for (const message of out.slice(-6)) {
      expect(message.content.length).toBeGreaterThan(5_000);
      expect(message.content).toMatch(/só couberam as linhas 1–\d+ das 1–300 lidas/);
      // Whole lines, and the offset is the line right after the last one shown.
      const lines = message.content.split("\n");
      const lastShown = Number(lines.at(-2)!.split(":")[0]);
      expect(lines.at(-2)).toMatch(/^\d+: parte\d\.md x{90}$/);
      expect(message.content).toContain(`offset=${lastShown + 1}`);
    }
  });

  test("a step with more calls than the recent window keeps every result", async () => {
    const { compressHistory } = await import("../src/context.js");
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.md`);
    const out = compressHistory(
      [{ role: "user", content: "leia tudo" }, ...readStep("old", ["grande.md"], () => "y".repeat(200_000)), ...readStep("c", files, () => "z".repeat(1_000))],
      30_000
    );
    expect(out[2]!.content.length).toBeLessThan(1_000);
    expect(out.slice(-25).every((m) => m.content === "z".repeat(1_000))).toBe(true);
  });
});

describe("an MCP tool called without its hash suffix", () => {
  // Far from the tool list, models drop the suffix: "mcp_brave_brave_web_search" got "tool not found".
  const tool = (server: string, name: string): McpTool => ({ server, name: qualifyMcpToolName(server, name), originalName: name, inputSchema: {} });

  test("resolves when only one tool has that name", () => {
    const search = tool("brave", "brave_web_search");
    const tools = [search, tool("brave", "brave_local_search")];
    expect(resolveMcpToolName(search.name, tools)).toBe(search);
    expect(resolveMcpToolName("mcp_brave_brave_web_search", tools)).toBe(search);
    expect(resolveMcpToolName("mcp_brave_brave_web", tools)).toBeUndefined();
  });

  test("an ambiguous name is not guessed: the answer lists the right names", () => {
    // Both servers become "meu_servidor" in the qualified name; only the hash differs.
    const a = tool("meu servidor", "buscar");
    const b = tool("meu_servidor", "buscar");
    expect(resolveMcpToolName("mcp_meu_servidor_buscar", [a, b])).toBeUndefined();
    const message = toolNotFoundMessage("mcp_meu_servidor_buscar", [a.name, b.name]);
    expect(message).toContain(a.name);
    expect(message).toContain(b.name);
  });

  test("an unknown name gets the closest ones", () => {
    const search = tool("brave", "brave_web_search");
    const names = ["read_file", "write_file", search.name];
    expect(toolNotFoundMessage("brave_web_search", names)).toContain(search.name);
    expect(toolNotFoundMessage("read_files", names)).toContain("read_file");
    expect(toolNotFoundMessage("algo_sem_relacao", names)).not.toContain("parecidos");
  });

  test("the session runs the tool the model named without the suffix", async () => {
    const search = tool("brave", "brave_web_search");
    const called: string[] = [];
    const manager = new McpManager();
    (manager as unknown as { servers: Map<string, unknown> }).servers.set("brave", {
      name: "brave",
      config: {},
      closed: false,
      tools: [search],
      transport: { close: async () => {} },
      client: {
        callTool: async (params: { name: string }) => {
          called.push(params.name);
          return { content: [{ type: "text", text: "resultado da busca" }] };
        },
      },
    });
    let n = 0;
    const provider = fakeProvider(() => (++n === 1 ? { tools: [{ name: "mcp_brave_brave_web_search", args: { query: "x" } }] } : { text: "ok" }));
    try {
      const session = new AgentSession(provider.config);
      Object.assign(session, { mcp: manager });
      await session.send("busque");
      expect(called).toEqual(["brave_web_search"]);
      expect(toolResults(provider.requests[1])[0]!.content).toBe("resultado da busca");
    } finally {
      provider.stop();
    }
  });
});

describe("a turn that goes in circles", () => {
  // Nothing stopped a model repeating itself: 140 steps and 5.6 million tokens until the user
  // pressed "Parar".
  async function runTurn(provider: ReturnType<typeof fakeProvider>, executeTool: () => Promise<{ result: string; isError: boolean }>, config: Partial<AppConfig> = {}) {
    const events: StreamEvent[] = [];
    for await (const ev of streamChat({
      config: { ...provider.config, ...config },
      messages: [{ role: "user", content: "tarefa" }],
      tools: [],
      reasoning: "none",
      executeTool,
    })) {
      events.push(ev);
    }
    return events;
  }
  const results = (events: StreamEvent[]) => events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []));

  test("the third identical call with the same result carries a warning", async () => {
    let n = 0;
    // The same arguments in another order are the same call.
    const args = [{ path: "a.md", offset: 1 }, { offset: 1, path: "a.md" }];
    const provider = fakeProvider(() => (++n <= 4 ? { tools: [{ name: "ler", args: args[n % 2]! }] } : { text: "fim" }));
    try {
      const got = results(await runTurn(provider, async () => ({ result: "mesmo conteúdo", isError: false })));
      expect(got.slice(0, 2)).toEqual(["mesmo conteúdo", "mesmo conteúdo"]);
      expect(got[2]).toContain("3ª vez");
      expect(got[3]).toContain("4ª vez");
    } finally {
      provider.stop();
    }
  });

  test("a call whose result changes is not a loop", async () => {
    let n = 0;
    let run = 0;
    const provider = fakeProvider(() => (++n <= 4 ? { tools: [{ name: "testes", args: {} }] } : { text: "fim" }));
    try {
      const got = results(await runTurn(provider, async () => ({ result: `falhas: ${4 - ++run}`, isError: false })));
      expect(got).toHaveLength(4);
      expect(got.some((r) => r.includes("Aviso"))).toBe(false);
    } finally {
      provider.stop();
    }
  });

  test("every askAfterSteps steps the user decides whether the turn goes on", async () => {
    let n = 0;
    const provider = fakeProvider((body) =>
      body.messages.at(-1)?.content === "e agora?" ? { text: "ok" } : { tools: [{ name: "passo", args: { n: ++n } }] }
    );
    try {
      const session = new AgentSession({ ...provider.config, askAfterSteps: 2 });
      const turn = session.send("tarefa longa");
      await until(() => session.getState().question !== null);
      expect(session.getState().question!.question).toContain("2 passos");
      expect(session.getState().question!.options).toEqual(["Continuar", "Parar"]);
      expect(session.answer("1")).toBe(true);
      await until(() => session.getState().question !== null);
      expect(session.getState().question!.question).toContain("4 passos");
      session.answer("Parar");
      await turn;
      expect(provider.requests).toHaveLength(4);
      expect(session.getState().messages.at(-1)?.content).toContain("pausado");
      // The history stays valid: the next turn starts after an assistant message.
      await session.send("e agora?");
      expect(conversation(provider.requests[4]).slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
    } finally {
      provider.stop();
    }
  });

  test("without anyone to ask (subagents), the turn stops at the limit", async () => {
    const provider = fakeProvider(() => ({ tools: [{ name: "passo", args: {} }] }));
    try {
      const events = await runTurn(provider, async () => ({ result: `${Math.random()}`, isError: false }), { askAfterSteps: 3 });
      expect(provider.requests).toHaveLength(3);
      const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
      expect(done.content).toContain("Parado depois de 3 passos");
      expect(done.messages!.at(-1)).toEqual({ role: "assistant", content: expect.stringContaining("Parado") });
    } finally {
      provider.stop();
    }
  });

  test("askAfterSteps of config.json is bounded, optional and 0 turns it off", () => {
    expect(askAfterSteps(undefined)).toBe(DEFAULT_ASK_AFTER_STEPS);
    expect(askAfterSteps("abc")).toBe(DEFAULT_ASK_AFTER_STEPS);
    expect(askAfterSteps(-5)).toBe(0);
    expect(askAfterSteps(40.7)).toBe(40);
    expect(normalize({ askAfterSteps: 0 } as Partial<AppConfig>).askAfterSteps).toBe(0);
    expect("askAfterSteps" in normalize({})).toBe(false);
  });
});

/** An OpenAI-compatible provider that answers each request with the next of `responses`. */
function scriptedProvider(responses: (() => Response)[]) {
  const bodies: { reasoning_effort?: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as (typeof bodies)[number]);
      return (responses[bodies.length - 1] ?? responses.at(-1)!)();
    },
  });
  return { bodies, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const sseChunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const sseResponse = (chunks: string[]) => () =>
  new Response(chunks.join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

async function collect(url: string, reasoning: AppConfig["reasoning"]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of streamChat({
    config: { baseURL: url, apiKey: "k", model: "m", reasoning, mcpServers: {} },
    messages: [{ role: "user", content: "gere o CSV" }],
    tools: [],
    reasoning,
    executeTool: async () => ({ result: "", isError: false }),
  })) {
    events.push(ev);
  }
  return events;
}
const doneOf = (events: StreamEvent[]) => events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;

describe("a response that spent the output limit only thinking", () => {
  // DeepSeek thought for the whole 32k tokens and wrote nothing; the turn said "Resposta
  // cortada... envie continue", which only made it think the same again.
  const onlyThinking = sseResponse([sseChunk({ reasoning_content: "pensando ".repeat(50) }), sseChunk({}, "length")]);

  test("is requested again once with less thinking, and nothing is called cut", async () => {
    const provider = scriptedProvider([onlyThinking, sseResponse([sseChunk({ content: "ok" }, "stop")])]);
    try {
      const events = await collect(provider.url, "high");
      expect(provider.bodies.map((b) => b.reasoning_effort)).toEqual(["high", "low"]);
      expect(events.some((e) => e.type === "retry")).toBe(true);
      const done = doneOf(events);
      expect(done.content).toBe("ok");
      expect(done.messages).toEqual([{ role: "assistant", content: "ok" }]);
    } finally {
      provider.stop();
    }
  });

  test("if it happens again, says so plainly and keeps the thinking out of the history", async () => {
    const provider = scriptedProvider([onlyThinking]);
    try {
      const done = doneOf(await collect(provider.url, "high"));
      expect(provider.bodies).toHaveLength(2);
      expect(done.content).toContain("pensando e não escreveu nada");
      expect(done.content).not.toContain("Resposta cortada");
      expect(done.messages).toEqual([{ role: "assistant", content: done.content }]);
    } finally {
      provider.stop();
    }
  });

  test("with thinking already at low or off, there is nothing to lower", async () => {
    for (const level of ["low", "none"] as const) {
      const provider = scriptedProvider([onlyThinking]);
      try {
        const done = doneOf(await collect(provider.url, level));
        expect(provider.bodies).toHaveLength(1);
        expect(done.content).toContain("pensando e não escreveu nada");
      } finally {
        provider.stop();
      }
    }
  });
});

describe("a connection that drops in the middle of the response", () => {
  // Qwen lost the connection (ECONNRESET) during long answers and the whole turn ended in an error.
  /** Sends part of the answer and closes the socket on the first `drops` requests. */
  function flakyProvider(drops: number) {
    let requests = 0;
    const answered = new WeakSet<object>();
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          if (answered.has(socket)) return;
          answered.add(socket);
          if (++requests <= drops) {
            const part = sseChunk({ content: "parcial" });
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${part.length.toString(16)}\r\n${part}\r\n`);
            setTimeout(() => socket.terminate(), 20);
          } else {
            const body = sseChunk({ content: "resposta inteira" }) + sseChunk({}, "stop") + "data: [DONE]\n\n";
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
            socket.end();
          }
        },
      },
    });
    return { url: `http://127.0.0.1:${listener.port}/v1`, requests: () => requests, stop: () => listener.stop(true) };
  }

  test("the step is requested again and the turn ends with a single answer", async () => {
    const provider = flakyProvider(1);
    try {
      const events = await collect(provider.url, "none");
      expect(provider.requests()).toBe(2);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
      expect(doneOf(events).content).toBe("resposta inteira");
    } finally {
      provider.stop();
    }
  });

  test("the session drops the text of the attempt that failed", async () => {
    const provider = flakyProvider(1);
    try {
      const session = new AgentSession({ baseURL: provider.url, apiKey: "k", model: "m", reasoning: "none", mcpServers: {} });
      await session.send("oi");
      expect(session.getState().error).toBeNull();
      expect(session.getState().messages.at(-1)?.content).toBe("resposta inteira");
    } finally {
      provider.stop();
    }
  });

  test("gives up after two retries and shows the error", async () => {
    const provider = flakyProvider(10);
    try {
      const events = await collect(provider.url, "none");
      expect(provider.requests()).toBe(3);
      expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("ECONNRESET") });
    } finally {
      provider.stop();
    }
  }, 15_000);

  test("only a lost connection counts, never an HTTP error", () => {
    expect(isConnectionDrop(Object.assign(new TypeError("ECONNRESET: The socket connection was closed unexpectedly."), { code: "ECONNRESET" }))).toBe(true);
    expect(isConnectionDrop(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isConnectionDrop({ status: 500, message: "ECONNRESET upstream" })).toBe(false);
    expect(isConnectionDrop(new Error("A API parou de enviar dados por 300s"))).toBe(false);
  });
});

// The model could read the API key with read_file on ~/.siliconflower/config.json or with
// `echo $SILICONFLOWER_API_KEY` in the shell.
describe("API key out of the model's reach", () => {
  test("file tools refuse the global config.json and its temporary copies", async () => {
    const dir = getGlobalDataDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), '{"apiKey":"sk-segredo-de-teste"}');
    for (const path of [join(dir, "config.json"), join(dir, "config.json.123.tmp")]) {
      const res = await runBuiltin("read_file", { path });
      expect(res.isError).toBe(true);
      expect(res.result).not.toContain("sk-segredo-de-teste");
    }
    expect((await runBuiltin("write_file", { path: join(dir, "config.json"), content: "{}" })).isError).toBe(true);
    expect(await readFile(join(dir, "config.json"), "utf8")).toContain("sk-segredo-de-teste");
  });

  test("a config.json in any other folder stays readable and writable", async () => {
    const dir = join(tmp, `outro-projeto-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "config.json");
    expect((await runBuiltin("write_file", { path, content: '{"porta":3000}' })).isError).toBeFalsy();
    const res = await runBuiltin("read_file", { path });
    expect(res.isError).toBeFalsy();
    expect(res.result).toContain("3000");
    // Same name inside a subfolder of the data dir is not the config file either.
    const nested = join(getGlobalDataDir(), "skills", "minha-skill", "config.json");
    await mkdir(join(nested, ".."), { recursive: true });
    expect((await runBuiltin("write_file", { path: nested, content: "{}" })).isError).toBeFalsy();
  });

  test("shell commands do not see SILICONFLOWER_API_KEY, but see the other variables", async () => {
    const env = { ...process.env, SILICONFLOWER_API_KEY: "sk-segredo-de-teste", SF_TESTE_VISIVEL: "visivel" };
    const cmd = isWin
      ? 'Write-Output "[$env:SILICONFLOWER_API_KEY][$env:SF_TESTE_VISIVEL]"'
      : 'echo "[$SILICONFLOWER_API_KEY][$SF_TESTE_VISIVEL]"';
    const res = await runShell(cmd, { env, timeout: 30_000 });
    expect(res.stdout.trim()).toBe("[][visivel]");
  });

  test("withoutSecrets ignores the case of the name (Windows)", () => {
    const out = withoutSecrets({ siliconflower_api_key: "x", Path: "p", SILICONFLOWER_MODEL: "m" });
    expect(out).toEqual({ Path: "p", SILICONFLOWER_MODEL: "m" });
  });
});

// The model ran `cat ~/.siliconflower/config.json` in the shell and got the key: the file block
// only covers the file tools. Every tool result now leaves with the known secrets as ***.
describe("known secrets in tool results", () => {
  const KEY = "sk-chave-secreta-1234567890";

  test("the API key never reaches the model nor the interface, whatever tool printed it", async () => {
    const encoder = new TextEncoder();
    const bodies: string[] = [];
    const sse = (deltas: unknown[]) => {
      const lines = deltas.map((delta, i) => {
        const finish = i === deltas.length - 1 ? (("tool_calls" in (delta as object)) ? "tool_calls" : "stop") : null;
        return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      });
      return new Response(encoder.encode(lines.join("") + "data: [DONE]\n\n"), { headers: { "Content-Type": "text/event-stream" } });
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        bodies.push(await req.text());
        if (bodies.length === 1) {
          return sse([{ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "execute_command", arguments: '{"command":"cat config.json"}' } }] }]);
        }
        return sse([{ content: "pronto" }]);
      },
    });
    const results: string[] = [];
    try {
      for await (const ev of streamChat({
        config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: KEY, model: "m", reasoning: "none", mcpServers: {} },
        messages: [{ role: "user", content: "leia a config" }],
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: `{\n  "apiKey": "${KEY}",\n  "outro": "${KEY}"\n}`, isError: false }),
      })) {
        if (ev.type === "tool_result") results.push(ev.result);
      }
    } finally {
      server.stop(true);
    }
    expect(bodies.length).toBe(2);
    expect(results.join("")).not.toContain(KEY);
    expect(results.join("")).toContain('"apiKey": "***"');
    // The request after the tool carries its result: there, the key must be gone too
    // (the first request has it only in the Authorization header, never in the body).
    expect(bodies[1]).not.toContain(KEY);
  });

  test("knownSecrets takes the MCP keys and headers, and skips short values and plain env entries", async () => {
    const secrets = await knownSecrets({
      baseURL: "http://x/v1",
      apiKey: KEY,
      model: "m",
      reasoning: "none",
      mcpServers: {
        brave: { command: "npx", env: { BRAVE_API_KEY: "BSA-chave-do-brave-987", HOME_DIR: "/home/usuario/pasta" } },
        web: { url: "https://exemplo.com/mcp", headers: { Authorization: "Bearer token-do-header-555" } },
        curta: { command: "x", env: { TOKEN: "abc" } },
      },
    });
    expect(secrets).toContain(KEY);
    expect(secrets).toContain("BSA-chave-do-brave-987");
    expect(secrets).toContain("Bearer token-do-header-555");
    expect(secrets).not.toContain("/home/usuario/pasta");
    expect(secrets).not.toContain("abc");
  });

  test("redactKnownSecrets replaces the longest secret whole", () => {
    expect(redactKnownSecrets("a sk-1234567890-extra b sk-1234567890", ["sk-1234567890-extra", "sk-1234567890"])).toBe("a *** b ***");
    expect(redactKnownSecrets("nada aqui", [KEY])).toBe("nada aqui");
  });
});
