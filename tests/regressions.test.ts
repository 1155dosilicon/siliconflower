import { describe, expect, test, afterAll } from "bun:test";
import { writeFile, readFile, rm, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runShell, decodeClixml } from "../src/shell.js";
import { htmlToMarkdown, isPrivateAddress, webFetch } from "../src/services/web.js";
import { buildOpenAIMessages, isOfficialOpenAIEndpoint, NOT_RUN_AFTER_CANCEL, streamChat } from "../src/llm.js";
import { AgentSession } from "../src/session.js";
import { normalize } from "../src/config.js";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact, getArtifactsDir } from "../src/services/artifact.js";
import { smartEditFile } from "../src/services/smart-edit.js";
import { runBuiltin } from "../src/tools.js";
import { extractSymbols, generateRepoMap } from "../src/services/repomap.js";
import { GREP_MAX_MATCHES, searchContent } from "../src/grep.js";
import { getBackgroundTask, killAllBackgroundTasks, startBackgroundCommand } from "../src/services/background-tasks.js";
import type { AppConfig, ChatMessage } from "../src/types.js";

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
