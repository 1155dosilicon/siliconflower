import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

const READY_TIMEOUT_MS = 30_000;
/** Longer than the 5 s the agent itself allows for hooks and MCP servers to close. */
const STOP_TIMEOUT_MS = 8_000;
const KILL_TIMEOUT_MS = 3_000;
const MAX_STDERR_CHARS = 4_000;

export type AgentStartFailure = "config_required" | "spawn_failed" | "exited" | "timeout";

export class AgentStartError extends Error {
  constructor(readonly failure: AgentStartFailure, readonly detail: string) {
    super(`${failure}: ${detail}`);
  }
}

export interface AgentExit {
  code: number | null;
  /** Last lines the agent wrote to stderr, to explain an unexpected end. */
  stderr: string;
}

export interface AgentProcess {
  /** The access URL. It contains the token: never log it. */
  ready: Promise<string>;
  exited: Promise<AgentExit>;
  stop: () => Promise<void>;
}

export interface AgentProcessOptions {
  exe: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Electron's own variables would change how Electron projects run under the agent's tools. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("ELECTRON_")));
}

const isWindows = process.platform === "win32";

/** Windows: taskkill /T. Unix: the agent leads its own process group (detached), so the whole group gets SIGKILL. */
export function killTree(pid: number): Promise<void> {
  if (!isWindows) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    return Promise.resolve();
  }
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

/** Starts one project's agent, without a console window, and manages its whole life. */
export function startAgentProcess(options: AgentProcessOptions): AgentProcess {
  const child = spawn(options.exe, options.args ?? ["gui", "--managed"], {
    cwd: options.cwd,
    env: childEnv(options.env ?? process.env),
    windowsHide: true,
    // Unix: a process group of its own, so killTree reaches what the agent started.
    detached: !isWindows,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdoutTail = "";
  let finished = false;
  let settleReady: { resolve: (url: string) => void; reject: (e: AgentStartError) => void } | undefined;
  const ready = new Promise<string>((resolve, reject) => { settleReady = { resolve, reject }; });
  // Callers that only care about exits must not get an unhandled rejection.
  ready.catch(() => {});
  const readyTimer = setTimeout(() => {
    settleReady?.reject(new AgentStartError("timeout", stderr));
    void stop();
  }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);

  const handleLine = (line: string) => {
    let message: { event?: unknown; url?: unknown; code?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol line
    }
    if (message?.event === "ready" && typeof message.url === "string") {
      clearTimeout(readyTimer);
      settleReady?.resolve(message.url);
    } else if (message?.event === "error" && message.code === "config_required") {
      clearTimeout(readyTimer);
      settleReady?.reject(new AgentStartError("config_required", ""));
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (stdoutTail + chunk).split(/\r?\n/);
    stdoutTail = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  child.stdin.on("error", () => {}); // EPIPE when the process is already gone

  const exited = new Promise<AgentExit>((resolve) => {
    const finish = (code: number | null, failure?: AgentStartError) => {
      if (finished) return;
      finished = true;
      clearTimeout(readyTimer);
      settleReady?.reject(failure ?? new AgentStartError("exited", stderr || `código de saída ${code}`));
      resolve({ code, stderr });
    };
    child.once("error", (e) => finish(null, new AgentStartError("spawn_failed", e.message)));
    child.once("close", (code) => finish(code));
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (finished) return;
      child.stdin.end(); // the clean way: hooks and MCP servers get to close
      const wait = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
      const first = await Promise.race([exited, wait(options.stopTimeoutMs ?? STOP_TIMEOUT_MS)]);
      if (first !== "timeout" || child.pid === undefined) return;
      await killTree(child.pid);
      await Promise.race([exited, wait(KILL_TIMEOUT_MS)]);
    })();
    return stopping;
  };

  return { ready, exited, stop };
}
