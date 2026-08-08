import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, appendFile, readFile, writeFile, stat } from "node:fs/promises";

const LOG_DIR = join(homedir(), ".siliconflower", "logs");
const LOG_FILE = join(LOG_DIR, "siliconflower.log");
const MAX_BYTES = 1024 * 1024; // 1 MB

export type LogLevel = "info" | "tool" | "warn" | "error" | "ok";

let ensured = false;

async function ensure() {
  if (ensured) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    ensured = true;
  } catch {
    ensured = true;
  }
}

async function rotateIfNeeded() {
  try {
    const st = await stat(LOG_FILE).catch(() => null);
    if (st && st.size > MAX_BYTES) {
      const old = await readFile(LOG_FILE, "utf8").catch(() => "");
      const trimmed = old.slice(-Math.floor(MAX_BYTES / 2));
      await writeFile(LOG_FILE, trimmed, "utf8");
    }
  } catch {
    /* rotation best-effort */
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

export async function tailLogs(n = 50): Promise<string> {
  try {
    const raw = await readFile(LOG_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch {
    return "(sem logs)";
  }
}

