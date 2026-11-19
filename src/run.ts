import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_UPLOADS, type AgentSession, type SessionQuestion, type SessionUpload } from "./session.js";
import { MAX_MEDIA_BYTES } from "./services/media.js";
import { knownSecrets, redactKnownSecrets } from "./config.js";
import type { LimitReason } from "./types.js";

/** How `siliconflower run` talks to the terminal. Replaceable in tests. */
export interface RunIO {
  /** The answer (stdout). */
  out: (text: string) => void;
  /** Progress, warnings and errors (stderr), so a script can keep only the answer. */
  err: (text: string) => void;
  /** Asks the person at the terminal; absent when nobody can answer (session not interactive). */
  ask?: (question: SessionQuestion) => Promise<string>;
}

export interface RunOptions {
  prompt: string;
  uploads?: SessionUpload[];
  /** Writes the answer as it arrives; otherwise only the final answer, at the end. */
  stream?: boolean;
  /** One line of JSON at the end in place of the text. */
  json?: boolean;
  /** No tool lines on stderr. */
  quiet?: boolean;
}

export interface RunTool {
  name: string;
  args: string;
  isError?: boolean;
}

/** The turn ended at a limit, before a final answer: `text` is then the summary. */
export interface RunStop {
  reason: LimitReason;
  steps: number;
  tokens: number;
  elapsedSeconds: number;
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  cancelled: boolean;
  text: string;
  error: string | null;
  conversationId: string | null;
  tools: RunTool[];
  /** Size of the last request (how full the context is). */
  tokens: number;
  /** Every request of the turn summed: what it cost. */
  turnTokens: number;
  stopped: RunStop | null;
}

const TOOL_LINE_CHARS = 160;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Runs one turn of an already started session and reports it on `io`. The session must have
 * been created with `interactive: false` when `io.ask` is absent, or a question would hang.
 */
export async function runTurn(session: AgentSession, options: RunOptions, io: RunIO): Promise<RunResult> {
  const stream = Boolean(options.stream) && !options.json;
  const tools: RunTool[] = [];
  // What leaves this process (the answer, tool lines, the JSON an MCP client reads) goes
  // without the API key, as tool results already reach the model. Streamed text is redacted
  // chunk by chunk, so a key split across two chunks would pass: only a terminal streams.
  const secrets = await knownSecrets(session.config);
  const redact = (text: string) => redactKnownSecrets(text, secrets);
  let wroteText = false;
  let endsWithNewline = true;
  let turnTokens = 0;
  let stopped: RunStop | null = null;

  const stopStream = session.onStreamEvent((ev) => {
    switch (ev.type) {
      case "text":
        if (stream && ev.text) {
          io.out(redact(ev.text));
          wroteText = true;
          endsWithNewline = ev.text.endsWith("\n");
        }
        break;
      case "tool_call":
        tools.push({ name: ev.name, args: redact(ev.args) });
        if (!options.quiet) {
          if (stream && wroteText && !endsWithNewline) {
            io.out("\n");
            endsWithNewline = true;
          }
          io.err(`🔨 ${ev.name} ${oneLine(redact(ev.args), TOOL_LINE_CHARS)}\n`);
        }
        break;
      case "tool_result": {
        const tool = [...tools].reverse().find((t) => t.name === ev.name && t.isError === undefined);
        if (tool) tool.isError = ev.isError;
        if (ev.isError && !options.quiet) io.err(`   ✗ ${oneLine(ev.result, TOOL_LINE_CHARS)}\n`);
        break;
      }
      case "retry":
        // What was already written cannot be taken back: say that it is being redone.
        if (!options.quiet) io.err(`\n[${ev.message}]\n`);
        break;
      case "usage":
        turnTokens += ev.totalTokens ?? (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
        break;
      case "limit":
        stopped = {
          reason: ev.reason,
          steps: ev.steps,
          tokens: ev.tokens,
          elapsedSeconds: Math.round(ev.elapsedMs / 1000),
          ...(ev.detail ? { detail: redact(ev.detail) } : {}),
        };
        break;
    }
  });

  // Questions (ask_question, "continue?" every askAfterSteps) go to the person at the terminal.
  let asked: SessionQuestion | null = null;
  const stopState = io.ask
    ? session.subscribe((state) => {
        if (!state.question || state.question === asked) return;
        asked = state.question;
        const question = state.question;
        if (stream && wroteText && !endsWithNewline) {
          io.out("\n");
          endsWithNewline = true;
        }
        void io.ask!(question).then(
          (answer) => {
            if (!session.answer(answer)) session.answer(question.options?.[0] ?? "ok");
          },
          () => session.cancel()
        );
      })
    : () => {};

  const before = session.getState().messages.length;
  try {
    await session.send(options.prompt, options.uploads ?? []);
  } finally {
    stopStream();
    stopState();
  }

  const state = session.getState();
  const added = state.messages.slice(before);
  const reply = redact(added.length && added[added.length - 1]!.role === "assistant" ? added[added.length - 1]!.content : "");
  const cancelled = state.status === "cancelado";
  const error = cancelled || !state.error ? null : redact(state.error);
  const result: RunResult = {
    ok: !error && !cancelled && added.length > 0,
    cancelled,
    text: reply,
    error: error ?? (added.length ? null : "a mensagem não foi enviada"),
    conversationId: state.conversationId,
    tools,
    tokens: state.apiTokens,
    turnTokens,
    stopped,
  };

  if (options.json) {
    io.out(`${JSON.stringify(result)}\n`);
  } else if (stream) {
    if (wroteText && !endsWithNewline) io.out("\n");
    // Nothing streamed (e.g. the "empty answer" note, or an error before any text).
    if (!wroteText && reply && result.ok) io.out(`${reply}\n`);
  } else if (result.ok && reply) {
    io.out(`${reply}\n`);
  }
  if (!options.json) {
    if (cancelled) io.err("[cancelado]\n");
    else if (result.error) io.err(`Erro: ${result.error}\n`);
  }
  return result;
}

/** Reads the files given with --attach, with the same limits as the interface. */
export async function readUploads(paths: string[]): Promise<SessionUpload[]> {
  if (paths.length > MAX_UPLOADS) throw new Error(`no máximo ${MAX_UPLOADS} anexos por mensagem`);
  const uploads: SessionUpload[] = [];
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (e) {
      throw new Error(`não consegui ler o anexo ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`${path} tem ${bytes.length} bytes; o limite é ${MAX_MEDIA_BYTES}`);
    uploads.push({ name: basename(path), data: bytes.toString("base64") });
  }
  return uploads;
}

/** Joins the words of the command line and, when asked, what came through the pipe. */
export function buildPrompt(words: string[], piped: string | undefined): string {
  const typed = words.join(" ").trim();
  const extra = piped?.replace(/\r\n?/g, "\n").trim() ?? "";
  if (typed && extra) return `${typed}\n\n${extra}`;
  return typed || extra;
}

/** Everything that came through stdin, until it closes. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}
