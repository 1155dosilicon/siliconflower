import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenAIMessages, streamChat } from "../src/llm.js";
import { AgentSession } from "../src/session.js";
import { ConversationStore } from "../src/services/conversations.js";
import { MAX_MEDIA_BYTES, pruneMedia } from "../src/services/media.js";
import { runBuiltin } from "../src/tools.js";
import type { AppConfig, ChatMessage, StreamEvent } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "sf-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string | Uint8Array = "conteudo"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const MIMO: AppConfig = { baseURL: "https://api.xiaomimimo.com/v1", apiKey: "k", model: "mimo-v2.6-pro", reasoning: "none" };
const OTHER: AppConfig = { baseURL: "https://api.openai.com/v1", apiKey: "k", model: "m", reasoning: "none" };

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
const toolCall = (name: string, args: unknown) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
const answer = (text: string) => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

async function collect(gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("read_media", () => {
  test("attaches an image for any provider", async () => {
    const res = await runBuiltin("read_media", { path: file("print.PNG") }, { config: OTHER });
    expect(res.isError).toBe(false);
    expect(res.media?.[0]).toMatchObject({ kind: "image", mime: "image/png", data: Buffer.from("conteudo").toString("base64") });
    expect(res.result).not.toContain(res.media![0]!.data!); // Base64 must not reach the tool message
  });

  test("audio and video only on Xiaomi MiMo", async () => {
    for (const name of ["a.mp3", "b.mp4"]) {
      const refused = await runBuiltin("read_media", { path: file(name) }, { config: OTHER });
      expect(refused.isError).toBe(true);
      expect(refused.media).toBeUndefined();
      expect((await runBuiltin("read_media", { path: file(name) }, { config: MIMO })).isError).toBe(false);
    }
  });

  test("limits fps to the range of the API and ignores invalid options", async () => {
    const path = file("c.mp4");
    const read = async (args: Record<string, unknown>) => (await runBuiltin("read_media", { path, ...args }, { config: MIMO })).media![0]!;
    expect((await read({ fps: 99 })).fps).toBe(10);
    expect((await read({ fps: 0 })).fps).toBe(0.1);
    expect((await read({ fps: "x", mediaResolution: "enorme" })).fps).toBeUndefined();
    expect((await read({ mediaResolution: "enorme" })).mediaResolution).toBeUndefined();
    expect((await read({ mediaResolution: "max" })).mediaResolution).toBe("max");
  });

  test("refuses what cannot be sent", async () => {
    const big = join(dir, "grande.png");
    writeFileSync(big, new Uint8Array(MAX_MEDIA_BYTES + 1));
    for (const path of [file("nota.txt"), file("vazio.png", ""), big, join(dir, "nao-existe.png"), process.platform === "win32" ? "C:\\Windows\\System32\\x.png" : "/etc/x.png"]) {
      const res = await runBuiltin("read_media", { path }, { config: MIMO });
      expect(res.isError).toBe(true);
      expect(res.media).toBeUndefined();
    }
  });
});

describe("media in requests", () => {
  const attachment = (kind: "image" | "audio" | "video", extra = {}) => ({
    kind,
    path: `C:\\x\\${kind}`,
    mime: `${kind}/x`,
    data: "QUJD",
    ...extra,
  });

  test("uses the content parts documented by MiMo", () => {
    const messages: ChatMessage[] = [{
      role: "user",
      content: "nota",
      media: [attachment("image"), attachment("audio"), attachment("video", { fps: 1, mediaResolution: "max" })],
    }];
    expect(buildOpenAIMessages(MIMO, messages)[0]!.content).toEqual([
      { type: "text", text: "nota" },
      { type: "image_url", image_url: { url: "data:image/x;base64,QUJD" } },
      { type: "input_audio", input_audio: { data: "data:audio/x;base64,QUJD" } },
      { type: "video_url", video_url: { url: "data:video/x;base64,QUJD" }, fps: 1, media_resolution: "max" },
    ] as any);
  });

  test("a file without data becomes a note, and so does audio on other providers", () => {
    const { data: _data, ...saved } = attachment("image");
    const content = buildOpenAIMessages(MIMO, [{ role: "user", content: "nota", media: [saved] }])[0]!.content;
    expect(content).toContain("read_media de novo");
    expect(typeof content).toBe("string");
    expect(buildOpenAIMessages(OTHER, [{ role: "user", content: "nota", media: [attachment("audio")] }])[0]!.content).toContain("não reenviada");
  });

  test("keeps only the newest files within the limits", () => {
    const messages: ChatMessage[] = ["1", "2", "3", "4", "5"].map((n) => ({ role: "user", content: n, media: [attachment("image")] }));
    const sent = pruneMedia(messages).map((m) => Boolean(m.media![0]!.data));
    expect(sent).toEqual([false, true, true, true, true]);
    expect(messages[0]!.media![0]!.data).toBe("QUJD"); // the input is not changed

    const big = "x".repeat(30_000_000);
    const two: ChatMessage[] = ["1", "2"].map((n) => ({ role: "user", content: n, media: [attachment("image", { data: big })] }));
    expect(pruneMedia(two).map((m) => Boolean(m.media![0]!.data))).toEqual([false, true]);
  });
});

describe("media in the tool loop", () => {
  test("goes in a user message after the tool results, which stay text", async () => {
    const requests: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push(await req.json());
        return sse(requests.length === 1 ? toolCall("read_media", { path: file("tela.png") }) : answer("vi"));
      },
    });
    try {
      const config: AppConfig = { ...OTHER, baseURL: `http://127.0.0.1:${server.port}/v1` };
      const events = await collect(streamChat({
        config,
        messages: [{ role: "user", content: "olhe" }],
        tools: [],
        reasoning: "none",
        executeTool: (name, args) => runBuiltin(name, args, { config }),
      }));
      const sent = requests[1].messages;
      expect(sent.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
      expect(typeof sent[2].content).toBe("string");
      expect(sent[3].content[0].text).toContain("não é um pedido do usuário");
      expect(sent[3].content[1].image_url.url).toStartWith("data:image/png;base64,");
      const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
      expect(done.content).toBe("vi");
      expect(done.messages?.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
    } finally {
      server.stop(true);
    }
  });

  test("a refused file does not block the conversation", async () => {
    const requests: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        requests.push(body);
        if (JSON.stringify(body.messages).includes("image_url")) {
          return Response.json({ error: { message: "image not supported" } }, { status: 400 });
        }
        return sse(answer("sem imagem"));
      },
    });
    try {
      const config: AppConfig = { ...OTHER, baseURL: `http://127.0.0.1:${server.port}/v1` };
      const history: ChatMessage[] = [{
        role: "user",
        content: "nota",
        media: [{ kind: "image", path: "C:\\x\\a.png", mime: "image/png", data: "QUJD" }],
      }];
      const run = () => collect(streamChat({
        config,
        messages: history,
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: "", isError: false }),
      }));

      const events = await run();
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(requests.length).toBe(2);
      expect(requests[1].messages[0].content).toContain("recusou");

      // The history shared with the session no longer carries the file.
      await run();
      expect(requests.length).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test("an error unrelated to media still reaches the user", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: "modelo invalido" } }, { status: 400 }) });
    try {
      const events = await collect(streamChat({
        config: { ...OTHER, baseURL: `http://127.0.0.1:${server.port}/v1` },
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        reasoning: "none",
        executeTool: async () => ({ result: "", isError: false }),
      }));
      const error = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>;
      expect(error.message).toContain("modelo invalido");
    } finally {
      server.stop(true);
    }
  });
});

describe("media through the session", () => {
  for (const mode of ["programação", "plano"] as const) {
    test(`read_media reaches the model in the ${mode} mode`, async () => {
      const requests: any[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          requests.push(await req.json());
          return sse(requests.length === 1 ? toolCall("read_media", { path: file("sessao.png") }) : answer("vi"));
        },
      });
      const session = new AgentSession({ ...OTHER, baseURL: `http://127.0.0.1:${server.port}/v1`, mcpServers: {} }, { mode });
      try {
        await session.send("olhe");
        const last = requests[1].messages.at(-1);
        expect(last.role).toBe("user");
        expect(last.content[1].image_url.url).toStartWith("data:image/png;base64,");
        expect(session.getState().messages.at(-1)?.content).toBe("vi");
        expect(session.getActivities()[0]?.result).not.toContain("base64");
      } finally {
        await session.close();
        server.stop(true);
      }
    });
  }
});

describe("media in saved conversations", () => {
  test("only the path goes to disk, and the file stays available to the next turn", async () => {
    const store = new ConversationStore(join(dir, "conversas"));
    let seen: ChatMessage[] = [];
    let turn = 0;
    const session = new AgentSession({ ...OTHER, mcpServers: {} }, {}, {
      store,
      stream: (async function* (opts) {
        seen = opts.messages;
        const messages: ChatMessage[] = turn++ === 0
          ? [
              { role: "user", content: "nota", media: [{ kind: "image", path: "C:\\x\\a.png", mime: "image/png", data: "QkFTRTY0" }] },
              { role: "assistant", content: "vi" },
            ]
          : [{ role: "assistant", content: "ok" }];
        yield { type: "done", content: "vi", reasoning: "", messages } as StreamEvent;
      }) as any,
    });

    await session.send("olhe");
    const id = session.getState().conversationId!;
    expect(await Bun.file(join(dir, "conversas", `${id}.jsonl`)).text()).not.toContain("QkFTRTY0");
    expect((await store.load(id)).history.find((m) => m.media)?.media?.[0]?.path).toBe("C:\\x\\a.png");

    await session.send("e agora?");
    expect(seen.find((m) => m.media)?.media?.[0]?.data).toBe("QkFTRTY0");
    await session.close();
  });
});
