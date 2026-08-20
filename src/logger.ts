import { join } from "node:path";
import { appendFile, readFile, writeFile, stat } from "node:fs/promises";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";

const LOG_DIR = join(getGlobalDataDir(), "logs");
const LOG_FILE = join(LOG_DIR, "siliconflower.log");
const MAX_BYTES = 200 * 1024; // 200 KB (~1,500 lines max)

export type LogLevel = "info" | "tool" | "warn" | "error" | "ok";

let ensured = false;
let isRotating = false;

async function ensure() {
  if (ensured) return;
  try {
    await ensureDir(LOG_DIR);
    ensured = true;
  } catch {
    // Transient failure (permissions, AV lock, full disk): don't mark as ensured,
    // so the next log() call retries instead of silently disabling logging forever.
  }
}

async function rotateIfNeeded() {
  if (isRotating) return;
  isRotating = true;
  try {
    const st = await stat(LOG_FILE).catch(() => null);
    if (st && st.size > MAX_BYTES) {
      const old = await readFile(LOG_FILE, "utf8").catch(() => "");
      const lines = old.split("\n").filter(Boolean);
      // Keep last 500 lines during rotation
      const trimmed = lines.slice(-500).join("\n") + "\n";
      await writeFile(LOG_FILE, trimmed, "utf8");
    }
  } catch {
    /* rotation best-effort */
  } finally {
    isRotating = false;
  }
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export async function log(level: LogLevel, msg: string): Promise<void> {
  await ensure();
  await rotateIfNeeded();
  const tag = level.toUpperCase().padEnd(5);
  const line = `[${stamp()}] ${tag} ${msg}\n`;
  try {
    await appendFile(LOG_FILE, line, "utf8");
  } catch {
    /* logging must never crash the app */
  }
}

export function logFile(): string {
  return LOG_FILE;
}

export interface TailLogsOptions {
  lines?: number;
  level?: LogLevel | string;
  search?: string;
}

export async function tailLogs(opts: number | TailLogsOptions = 50): Promise<string> {
  const options: TailLogsOptions = typeof opts === "number" ? { lines: opts } : opts;
  const maxLines = options.lines ?? 50;

  try {
    const raw = await readFile(LOG_FILE, "utf8");
    let lines = raw.split("\n").filter(Boolean);

    if (options.level) {
      const levelUpper = options.level.toUpperCase();
      lines = lines.filter((line) => line.includes(`] ${levelUpper}`));
    }

    if (options.search) {
      const q = options.search.toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(q));
    }

    if (lines.length === 0) {
      return "(nenhum log encontrado com os filtros fornecidos)";
    }

    return lines.slice(-maxLines).join("\n");
  } catch {
    return "(sem logs)";
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await writeFile(LOG_FILE, "", "utf8");
  } catch {
    /* best effort */
  }
}
