import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { AgentSession, SessionState } from "../session.js";
import type { Mode, ReasoningLevel, StreamEvent } from "../types.js";
import { REASONING_LEVELS } from "../types.js";
import { MODES } from "../modes.js";
import { reasoningLabel, reasoningOptions } from "../reasoning.js";
import { log, logFile } from "../logger.js";
import { APP_VERSION } from "../version.js";
import indexHtml from "./client/index.html" with { type: "text" };
import styleCss from "./client/style.css" with { type: "text" };
import appJs from "./client/app.js" with { type: "text" };
import markdownJs from "./client/markdown.js" with { type: "text" };

const HOST = "127.0.0.1";
const TOPIC = "session";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const STATE_FLUSH_MS = 33;
/** Time for a page reload to reconnect before the app considers itself closed. */
const DEFAULT_GRACE_MS = 15_000;
const MAX_TOOL_ACTIVITIES = 300;
const MAX_TOOL_TEXT_CHARS = 50_000;
const MAX_THINKING_CHARS = 200_000;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="#e77fb3"><circle cx="16" cy="7" r="6"/><circle cx="25" cy="13" r="6"/><circle cx="21" cy="24" r="6"/><circle cx="11" cy="24" r="6"/><circle cx="7" cy="13" r="6"/></g><circle cx="16" cy="16" r="4" fill="#f7d774"/></svg>`;

const ASSETS: Record<string, { body: string; type: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/style.css": { body: styleCss, type: "text/css; charset=utf-8" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8" },
  "/markdown.js": { body: markdownJs, type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { body: FAVICON, type: "image/svg+xml" },
};

export interface ToolActivity {
  /** Unique in this session, unlike `id`, which comes from the provider. */
  key: number;
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  /** Number of messages already shown when the tool ran: places the card in the timeline. */
  afterMessage: number;
}

export interface GuiServerOptions {
  /** 0 (default) picks a free port, so several projects can run side by side. */
  port?: number;
  graceMs?: number;
  /** Called when the last page has been gone for longer than the grace period. */
  onIdle?: () => void;
}

export interface GuiServer {
  /** URL with the access token: treat it as a password. */
  url: string;
  port: number;
  stop: () => void;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[... ${text.length - max} caracteres omitidos na interface]` : text;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/**
 * Serves the web front end of one session, on the loopback interface only. The agent runs
 * commands on this machine and any website can try to reach local ports, so every request
 * must come with the expected Host (DNS rebinding) and the session cookie, obtained from
 * the URL with the random token. The WebSocket also checks Origin.
 */
export function startGuiServer(session: AgentSession, options: GuiServerOptions = {}): GuiServer {
  const token = randomBytes(32).toString("hex");
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const activities: ToolActivity[] = [];
  let nextActivityKey = 1;
  let thinking = "";
  let lastSent: SessionState = session.getState();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let clients = 0;
  let stopped = false;

  const startGrace = () => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      if (clients === 0 && !stopped) options.onIdle?.();
    }, graceMs);
  };

  const publish = (message: unknown) => {
    if (!stopped) server.publish(TOPIC, JSON.stringify(message));
  };

  // State is immutable at the top level, so comparing references finds what changed;
  // the (possibly long) message list is sent only when it really changes.
  const flushState = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    const current = session.getState();
    const changes: Partial<Record<keyof SessionState, unknown>> = {};
    for (const key of Object.keys(current) as (keyof SessionState)[]) {
      if (current[key] !== lastSent[key]) changes[key] = current[key];
    }
    lastSent = current;
    if (Object.keys(changes).length) publish({ type: "state", changes });
  };

  const unsubscribeState = session.subscribe((state) => {
    if (state.streaming && !lastSent.streaming) thinking = "";
    if (state.streaming !== lastSent.streaming) flushState();
    else flushTimer ??= setTimeout(flushState, STATE_FLUSH_MS);
  });

  const unsubscribeStream = session.onStreamEvent((event: StreamEvent) => {
    flushState(); // events are placed relative to the messages the page already has
    if (event.type === "thinking") {
      thinking = (thinking + event.text).slice(-MAX_THINKING_CHARS);
      publish({ type: "thinking", text: event.text });
    } else if (event.type === "tool_call") {
      const activity: ToolActivity = {
        key: nextActivityKey++,
        id: event.id,
        name: event.name,
        args: clip(event.args, MAX_TOOL_TEXT_CHARS),
        afterMessage: session.getState().messages.length,
      };
      activities.push(activity);
      if (activities.length > MAX_TOOL_ACTIVITIES) activities.shift();
      publish({ type: "tool", activity });
    } else if (event.type === "tool_result") {
      // Some providers reuse call ids across steps: the latest unanswered call is the one.
      const activity = [...activities].reverse().find((a) => a.id === event.id && a.result === undefined);
      if (activity) {
        activity.result = clip(event.result, MAX_TOOL_TEXT_CHARS);
        activity.isError = event.isError;
        publish({ type: "tool", activity });
      }
    }
  });

  const handleMessage = (raw: string | Buffer) => {
    let msg: { type?: unknown; text?: unknown; mode?: unknown; level?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    switch (msg.type) {
      case "send":
        if (typeof msg.text === "string") {
          session.send(msg.text).catch((e) => void log("error", `GUI send: ${String(e)}`));
        }
        break;
      case "answer":
        if (typeof msg.text === "string") session.answer(msg.text);
        break;
      case "cancel":
        session.cancel();
        break;
      case "mode":
        if ((MODES as unknown[]).includes(msg.mode)) session.setMode(msg.mode as Mode);
        break;
      case "reasoning":
        if ((REASONING_LEVELS as unknown[]).includes(msg.level)) session.setReasoning(msg.level as ReasoningLevel);
        break;
    }
  };

  let port = options.port ?? 0;
  const securityHeaders = () => ({
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ws://${HOST}:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  });
  const refuse = (status: number, text: string) =>
    new Response(text, { status, headers: { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" } });

  const server = Bun.serve({
    hostname: HOST,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get("host") !== `${HOST}:${port}`) return refuse(403, "Host não permitido.");
      if (req.method !== "GET") return refuse(405, "Método não permitido.");

      const cookieName = `sf_gui_${port}`;
      const offered = url.searchParams.get("token");
      if (url.pathname === "/" && offered !== null) {
        if (!sameSecret(offered, token)) return refuse(401, "Token inválido. Use a URL mostrada no terminal.");
        // Moves the token out of the address bar and of the browser history.
        return new Response(null, {
          status: 303,
          headers: {
            ...securityHeaders(),
            Location: "/",
            "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }
      if (!sameSecret(readCookie(req.headers.get("cookie"), cookieName) ?? "", token)) {
        return refuse(401, "Acesso negado. Abra a URL mostrada no terminal pelo siliconflower gui.");
      }

      if (url.pathname === "/ws") {
        if (req.headers.get("origin") !== `http://${HOST}:${port}`) return refuse(403, "Origem não permitida.");
        return srv.upgrade(req) ? undefined : refuse(400, "Esperava uma conexão WebSocket.");
      }
      const asset = ASSETS[url.pathname];
      if (!asset) return refuse(404, "Não encontrado.");
      return new Response(asset.body, { headers: { ...securityHeaders(), "Content-Type": asset.type } });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES,
      open(ws: ServerWebSocket<undefined>) {
        clients++;
        if (graceTimer) clearTimeout(graceTimer);
        flushState();
        const { baseURL } = session.config;
        ws.send(JSON.stringify({
          type: "hello",
          state: session.getState(),
          activities,
          thinking,
          meta: {
            version: APP_VERSION,
            cwd: process.cwd(),
            logFile: logFile(),
            modes: MODES,
            reasoningOptions: reasoningOptions(baseURL).map((value) => ({ value, label: reasoningLabel(value, baseURL) })),
          },
        }));
        ws.subscribe(TOPIC);
      },
      message(_ws, raw) {
        handleMessage(raw);
      },
      close() {
        clients--;
        if (clients === 0) startGrace();
      },
    },
  });
  port = server.port ?? port;

  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    stop() {
      if (stopped) return;
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribeState();
      unsubscribeStream();
      void server.stop(true);
    },
  };
}
