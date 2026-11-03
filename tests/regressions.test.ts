import { describe, expect, test, afterAll } from "bun:test";
import { writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPowerShell, decodeClixml } from "../src/shell.js";
import { htmlToMarkdown, isPrivateAddress, webFetch } from "../src/services/web.js";
import { buildOpenAIMessages, isOfficialOpenAIEndpoint, streamChat } from "../src/llm.js";
import { normalize } from "../src/config.js";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact, getArtifactsDir } from "../src/services/artifact.js";
import { smartEditFile } from "../src/services/smart-edit.js";
import { runBuiltin } from "../src/tools.js";
import { extractSymbols, generateRepoMap } from "../src/services/repomap.js";
import { GREP_MAX_MATCHES, searchContent } from "../src/grep.js";
import { renderLogo } from "../src/ascii.js";
import { getBackgroundTask, killAllBackgroundTasks, startBackgroundCommand } from "../src/services/background-tasks.js";
import type { AppConfig, ChatMessage } from "../src/types.js";

const tmp = join(tmpdir(), `sf_regressions_${Date.now()}`);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("PowerShell runner", () => {
  test("returns UTF-8 output (accents are not corrupted by the OEM codepage)", async () => {
    const res = await runPowerShell(`Write-Output 'ação ç "aspas"'`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('ação ç "aspas"');
  });

  test("returns stderr as plain text and the real exit code", async () => {
    const res = await runPowerShell(`Write-Error 'falhou é'; exit 3`);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("falhou é");
    expect(res.stderr).not.toContain("CLIXML");
    expect(res.stderr).not.toContain("OutputEncoding");
  });

  test("timeout kills the command", async () => {
    const started = Date.now();
    const res = await runPowerShell("Start-Sleep -Seconds 20", { timeout: 1000 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
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

describe("closing the app", () => {
  test("background commands and what they started do not survive as orphans", async () => {
    const marker = `sf-orphan-${process.pid}-${Date.now()}`;
    const countSleepers = async () => {
      const res = await runPowerShell(
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
  test("waits for the interactive answer when the TUI provides askUser", async () => {
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

describe("logo", () => {
  test("never wider than the terminal (wrapping breaks the block art)", () => {
    for (const cols of [200, 101, 100, 80, 60, 52, 51, 40, 20]) {
      const { art } = renderLogo(cols);
      const widest = Math.max(...art.split("\n").map((l) => [...l].length));
      expect(widest).toBeLessThan(cols);
    }
  });

  test("uses the full logo, then SILICON/FLOWER stacked, then plain text", () => {
    expect(renderLogo(120).art.split("\n").length).toBe(6);
    expect(renderLogo(80).art.split("\n").length).toBe(12);
    expect(renderLogo(30).art).toBe("SILICONFLOWER");
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
