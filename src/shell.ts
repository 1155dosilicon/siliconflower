import { spawn, execFile, type ChildProcess } from "node:child_process";

/**
 * Prefix that forces PowerShell 5.1 to emit UTF-8 (the console default is the OEM
 * codepage, e.g. CP850, which corrupts accented characters when decoded as UTF-8).
 */
const UTF8_PREFIX =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n";

// -EncodedCommand avoids every quoting pitfall of the Windows command line, but the
// whole command line is limited to 32767 chars; fall back to -Command for huge scripts.
const MAX_ENCODED_COMMAND_CHARS = 30_000;

export function powershellArgs(command: string): string[] {
  const script = UTF8_PREFIX + command;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  return encoded.length <= MAX_ENCODED_COMMAND_CHARS
    ? [...base, "-EncodedCommand", encoded]
    : [...base, "-Command", script];
}

/**
 * PowerShell 5.1 serializes stderr as CLIXML when started with -EncodedCommand and
 * redirected streams. Converts it back to plain text (error records only; progress dropped).
 */
export function decodeClixml(stderr: string): string {
  const marker = "#< CLIXML";
  const idx = stderr.indexOf(marker);
  if (idx === -1) return stderr;
  const before = stderr.slice(0, idx);
  const xml = stderr.slice(idx + marker.length);
  const parts: string[] = [];
  for (const m of xml.matchAll(/<S S="(?:Error|Warning|Verbose|Debug|Information)">([\s\S]*?)<\/S>/g)) {
    parts.push(
      m[1]
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
    );
  }
  return (before + parts.join("")).trim();
}

/**
 * Kills a process and all of its descendants (Windows `taskkill /T`). The tree must be
 * killed before the parent dies, otherwise the children are orphaned and keep running.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
      try { child.kill(); } catch { /* already gone */ }
    });
  } else {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

export interface PowerShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

export interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

/**
 * Runs a PowerShell command with UTF-8 output, without loading the user profile, and
 * kills the whole process tree on timeout/abort. Returns the child for external control.
 */
export function startPowerShell(
  command: string,
  opts: PowerShellOptions = {}
): { child: ChildProcess; done: Promise<PowerShellResult> } {
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
  const child = spawn("powershell.exe", powershellArgs(command), {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const done = new Promise<PowerShellResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let aborted = false;
    let error: string | undefined;
    let settled = false;

    const collect = (bucket: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        if (!error) error = `Saída excedeu o limite de ${maxBuffer} bytes`;
        killProcessTree(child);
        return;
      }
      bucket.push(chunk);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));

    const timer = opts.timeout && opts.timeout > 0
      ? setTimeout(() => { timedOut = true; killProcessTree(child); }, opts.timeout)
      : undefined;
    const onAbort = () => { aborted = true; killProcessTree(child); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(out).toString("utf8").replace(/^﻿/, ""),
        // PowerShell echoes the failing script in error records; hide our encoding prefix.
        stderr: decodeClixml(Buffer.concat(err).toString("utf8").replace(/^﻿/, ""))
          .split(/\r?\n/)
          .filter((line) => line !== UTF8_PREFIX.trim())
          .join("\n"),
        exitCode,
        timedOut,
        aborted,
        error,
      });
    };
    child.on("error", (e) => { error = e.message; finish(null); });
    child.on("close", (code) => finish(code));
  });

  return { child, done };
}

export function runPowerShell(command: string, opts: PowerShellOptions = {}): Promise<PowerShellResult> {
  return startPowerShell(command, opts).done;
}

/** Human-readable failure description, or undefined when the command succeeded. */
export function describeFailure(res: PowerShellResult, timeoutMs?: number): string | undefined {
  if (res.aborted) return "cancelado";
  if (res.timedOut) return `tempo limite de ${timeoutMs ?? "?"}ms excedido`;
  if (res.error) return res.error;
  if (res.exitCode !== 0) return `código de saída ${res.exitCode}`;
  return undefined;
}
