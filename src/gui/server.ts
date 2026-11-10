import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { MAX_UPLOADS, type AgentSession, type SessionState, type SessionUpload } from "../session.js";
import type { Mode, ReasoningLevel } from "../types.js";
import { REASONING_LEVELS } from "../types.js";
import { MODES } from "../modes.js";
import { reasoningLabel, reasoningOptions } from "../reasoning.js";
import { log, logFile } from "../logger.js";
import { APP_VERSION } from "../version.js";
import indexHtml from "./client/index.html" with { type: "text" };
import styleCss from "./client/style.css" with { type: "text" };
import appJs from "./client/app.js" with { type: "text" };
import markdownJs from "./client/markdown.js" with { type: "text" };
// Embedded in the compiled binary too; JetBrains Mono (OFL), subset to Latin-1 (see client/fonts/OFL.txt).
import monoFontPath from "./client/fonts/jetbrains-mono-extrabold.woff2" with { type: "file" };

const HOST = "127.0.0.1";
const TOPIC = "session";
// Room for the files attached to a message (Base64), which travel in the message itself.
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_NAME_CHARS = 200;
const STATE_FLUSH_MS = 33;
/** Time for a page reload to reconnect before the app considers itself closed. */
const DEFAULT_GRACE_MS = 15_000;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="#e77fb3"><circle cx="16" cy="7" r="6"/><circle cx="25" cy="13" r="6"/><circle cx="21" cy="24" r="6"/><circle cx="11" cy="24" r="6"/><circle cx="7" cy="13" r="6"/><circle cx="16" cy="16" r="8"/></g><circle cx="16" cy="16" r="4" fill="#f7d774"/></svg>`;

const ASSETS: Record<string, { body: string | Blob; type: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/style.css": { body: styleCss, type: "text/css; charset=utf-8" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8" },
  "/markdown.js": { body: markdownJs, type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { body: FAVICON, type: "image/svg+xml" },
  "/fonts/jetbrains-mono-extrabold.woff2": { body: Bun.file(monoFontPath), type: "font/woff2" },
};

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

/** The page only says the model is thinking: the text would clutter it and can be long. */
function withoutReasoning<T extends { reasoning?: unknown }>(message: T): Omit<T, "reasoning"> {
  const { reasoning: _reasoning, ...rest } = message;
  return rest;
}

/** The files of a "send" message, or null when the page sent anything else in their place. */
export function parseUploads(raw: unknown): SessionUpload[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_UPLOADS) return null;
  const uploads: SessionUpload[] = [];
  for (const item of raw as { name?: unknown; data?: unknown }[]) {
    if (typeof item?.name !== "string" || !item.name || item.name.length > MAX_UPLOAD_NAME_CHARS) return null;
    if (typeof item.data !== "string" || !item.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) return null;
    uploads.push({ name: item.name, data: item.data });
  }
  return uploads;
}

function forPage(state: SessionState) {
  return { ...state, messages: state.messages.map(withoutReasoning) };
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
    // An answer grows a few characters at a time: send what is new, not the whole text again.
    let liveAppend: string | undefined;
    const previousLive = lastSent.liveText;
    if (typeof changes.liveText === "string" && previousLive && changes.liveText.startsWith(previousLive)) {
      liveAppend = changes.liveText.slice(previousLive.length);
      delete changes.liveText;
    }
    lastSent = current;
    if (changes.messages) changes.messages = current.messages.map(withoutReasoning);
    if (Object.keys(changes).length || liveAppend) publish({ type: "state", changes, ...(liveAppend ? { liveAppend } : {}) });
  };

  const unsubscribeState = session.subscribe((state) => {
    if (state.streaming !== lastSent.streaming) flushState();
    else flushTimer ??= setTimeout(flushState, STATE_FLUSH_MS);
  });

  const unsubscribeActivity = session.onActivity((activity) => {
    flushState(); // cards are placed relative to the messages the page already has
    publish({ type: "tool", activity });
  });

  const helloMessage = () => {
    const { baseURL } = session.config;
    return {
      type: "hello",
      state: forPage(session.getState()),
      activities: session.getActivities(),
      meta: {
        version: APP_VERSION,
        cwd: process.cwd(),
        logFile: logFile(),
        modes: MODES,
        reasoningOptions: reasoningOptions(baseURL).map((value) => ({ value, label: reasoningLabel(value, baseURL) })),
      },
    };
  };

  /** Another conversation on screen: the pages redraw everything, as after a reload. */
  const publishConversation = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    lastSent = session.getState();
    publish(helloMessage());
  };

  const handleMessage = (raw: string | Buffer) => {
    let msg: { type?: unknown; text?: unknown; mode?: unknown; level?: unknown; id?: unknown; attachments?: unknown; title?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    switch (msg.type) {
      case "send":
        if (typeof msg.text === "string") {
          const uploads = parseUploads(msg.attachments);
          if (uploads) session.send(msg.text, uploads).catch((e) => void log("error", `GUI send: ${String(e)}`));
        }
        break;
      case "edit":
        // The old turn is dropped synchronously: the pages redraw without it, then follow the new one.
        if (typeof msg.text === "string") {
          const turn = session.editLastMessage(msg.text);
          if (turn) {
            publishConversation();
            turn.catch((e) => void log("error", `GUI edit: ${String(e)}`));
          }
        }
        break;
      case "rename":
        if (typeof msg.id === "string" && typeof msg.title === "string") void session.renameConversation(msg.id, msg.title);
        break;
      case "kill-task":
        if (typeof msg.id === "string") session.killBackgroundTask(msg.id);
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
      case "new":
        if (!session.getState().streaming) {
          session.newConversation();
          publishConversation();
        }
        break;
      case "resume":
        if (typeof msg.id === "string") {
          void session.resumeConversation(msg.id).then((resumed) => { if (resumed) publishConversation(); });
        }
        break;
      case "delete":
        if (typeof msg.id === "string") {
          void session.deleteConversation(msg.id).then(publishConversation);
        }
        break;
    }
  };

  let port = options.port ?? 0;
  const securityHeaders = () => ({
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src ws://${HOST}:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
        ws.send(JSON.stringify(helloMessage()));
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
      unsubscribeActivity();
      void server.stop(true);
    },
  };
}
