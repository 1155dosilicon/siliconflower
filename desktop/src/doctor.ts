import { spawn } from "node:child_process";
import { childEnv, killTree } from "./agent-process.js";

/** The checks have their own limits (shell, provider, MCP): this one is for an agent that hangs. */
const DOCTOR_TIMEOUT_MS = 120_000;
const MAX_STDERR_CHARS = 2_000;
const STATUSES = ["ok", "warn", "fail", "skip"] as const;

// The shapes of src/doctor.ts, repeated: importing it would bring the agent's Bun-only
// modules into this project. tests/desktop.test.ts runs the real agent through this parser.
type CheckStatus = (typeof STATUSES)[number];

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  items?: string[];
  hint?: string;
  fixable?: boolean;
  fixed?: string;
}

/** What the start screen shows: the report, or why there is none. */
export interface DoctorResult {
  report?: { checks: DoctorCheck[]; ok: boolean };
  summary?: string;
  error?: string;
}

export interface AgentDoctorOptions {
  exe: string;
  cwd: string;
  /** The recent projects, checked together: the start screen has no project of its own. */
  projects: string[];
  fix?: boolean;
  /** Before `doctor`, for running the agent from source in tests. */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Ends the agent: the window that asked is gone. */
  signal?: AbortSignal;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** The agent's answer is shown on a page: only the expected fields, with the expected types, pass. */
export function parseDoctorOutput(stdout: string): DoctorResult | null {
  // The report is the last line: anything a dependency printed before it is not ours.
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let parsed: { report?: { checks?: unknown; ok?: unknown }; summary?: unknown };
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const raw = parsed?.report?.checks;
  if (!Array.isArray(raw) || typeof parsed.report?.ok !== "boolean" || !isText(parsed.summary)) return null;
  const checks: DoctorCheck[] = [];
  for (const entry of raw as Partial<Record<keyof DoctorCheck, unknown>>[]) {
    if (!isText(entry?.id) || !isText(entry.title) || !isText(entry.detail) || !STATUSES.includes(entry.status as CheckStatus)) return null;
    checks.push({
      id: entry.id,
      title: entry.title,
      status: entry.status as CheckStatus,
      detail: entry.detail,
      ...(Array.isArray(entry.items) ? { items: entry.items.filter(isText) } : {}),
      ...(isText(entry.hint) ? { hint: entry.hint } : {}),
      ...(entry.fixable === true ? { fixable: true } : {}),
      ...(isText(entry.fixed) ? { fixed: entry.fixed } : {}),
    });
  }
  return { report: { checks, ok: parsed.report.ok }, summary: parsed.summary };
}

/**
 * Runs `siliconflower doctor --json` with the agent the projects use, so the report is about
 * what really runs: its shell, its config, its data folder. Never rejects: a diagnosis that
 * cannot run is a result too.
 */
export function runAgentDoctor(options: AgentDoctorOptions): Promise<DoctorResult> {
  const args = [
    ...(options.prefixArgs ?? []),
    "doctor",
    "--json",
    ...(options.fix ? ["--fix"] : []),
    // Last: the option takes every argument that follows it.
    "--projects",
    ...options.projects,
  ];
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ error: "Diagnóstico cancelado." });
      return;
    }
    const child = spawn(options.exe, args, {
      cwd: options.cwd,
      env: childEnv(options.env ?? process.env),
      windowsHide: true,
      // Unix: a process group of its own, so killTree reaches the shell the checks start.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stopped: string | undefined;
    const stop = (message: string) => {
      if (stopped !== undefined) return;
      stopped = message;
      if (child.pid !== undefined) void killTree(child.pid);
    };
    const timer = setTimeout(
      () => stop("O diagnóstico demorou demais e foi interrompido. Verifique de novo; se repetir, rode `siliconflower doctor --offline` num terminal."),
      options.timeoutMs ?? DOCTOR_TIMEOUT_MS
    );
    const onAbort = () => stop("Diagnóstico cancelado.");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let finished = false;
    const finish = (result: DoctorResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS); });

    child.once("error", (e) => finish({ error: `Não consegui iniciar o agente em ${options.exe}: ${e.message}` }));
    child.once("close", (code) => {
      if (stopped !== undefined) {
        finish({ error: stopped });
        return;
      }
      // Exit code 1 with a report is a report with failures, not a broken diagnosis.
      finish(parseDoctorOutput(stdout) ?? { error: `O agente não devolveu o diagnóstico (código de saída ${code}). ${stderr.trim()}`.trim() });
    });
  });
}
