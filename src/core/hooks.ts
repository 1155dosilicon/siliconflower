import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { log } from "../logger.js";
import { getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";
import { runShell, describeFailure } from "../shell.js";
import { resolveWorkspaceRoot } from "../project.js";

const HOOK_TIMEOUT_MS = 30_000;
// Environment values are limited (128 KB each on Linux, 32,767 characters on Windows): above
// that the hook does not even start. A write_file of a big file would pass it in TOOL_ARGS.
const MAX_HOOK_ENV_CHARS = 16_000;
const MAX_HOOK_ARG_CHARS = 2_000;

export type HookEvent = "preTool" | "postTool" | "onEdit" | "onCommand" | "onSessionStart" | "onSessionEnd";

export interface HookConfig {
  preTool?: string;
  postTool?: string;
  onEdit?: string;
  onCommand?: string;
  onSessionStart?: string;
  onSessionEnd?: string;
}

export interface HookResult {
  executed: boolean;
  command?: string;
  output?: string;
  error?: string;
}

async function readHooksFile(path: string): Promise<HookConfig | undefined> {
  try {
    await access(path);
  } catch {
    // File does not exist at this location; caller falls back to the next one.
    return undefined;
  }
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // File exists but is unreadable or not valid JSON: warn instead of silently
    // falling back to a different (unexpected) hooks source.
    await log("warn", `Falha ao ler/parsear hooks.json em ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

const warnedRepoHooks = new Set<string>();

/**
 * A hooks.json inside the repository (`<root>/.siliconflower/hooks.json`, read by older
 * versions) is never run: a cloned project could otherwise run its own commands as soon as
 * the agent ran anything there. Returns its path when there is one, to tell the user.
 */
export async function ignoredRepoHooksFile(cwd: string = process.cwd()): Promise<string | undefined> {
  const repoFile = join(resolveWorkspaceRoot(cwd), ".siliconflower", "hooks.json");
  try {
    await access(repoFile);
  } catch {
    return undefined;
  }
  if (!warnedRepoHooks.has(repoFile)) {
    warnedRepoHooks.add(repoFile);
    await log("warn", `hooks.json do repositorio ignorado: ${repoFile}. Para manter esses hooks, mova o arquivo para ${workspaceHooksFile(cwd)}`);
  }
  return repoFile;
}

export function workspaceHooksFile(cwd: string = process.cwd()): string {
  return join(getWorkspaceDataDir(cwd), "hooks.json");
}

/**
 * Hooks from the user's data folder only: the workspace's
 * (~/.siliconflower/workspaces/<workspace-id>/hooks.json), else the global one (~/.siliconflower/hooks.json).
 */
export async function loadHooksConfig(cwd: string = process.cwd()): Promise<HookConfig | undefined> {
  await ignoredRepoHooksFile(cwd);
  return (await readHooksFile(workspaceHooksFile(cwd))) ?? (await readHooksFile(join(getGlobalDataDir(), "hooks.json")));
}

/** The tool's arguments as JSON, short enough to fit in an environment variable. */
export function hookToolArgs(args: Record<string, unknown>): string {
  const full = JSON.stringify(args);
  if (full.length <= MAX_HOOK_ENV_CHARS) return full;
  const shortened = JSON.stringify(args, (_key, value: unknown) =>
    typeof value === "string" && value.length > MAX_HOOK_ARG_CHARS
      ? `${value.slice(0, MAX_HOOK_ARG_CHARS)}... [${value.length - MAX_HOOK_ARG_CHARS} caracteres omitidos]`
      : value
  );
  if (shortened.length <= MAX_HOOK_ENV_CHARS) return shortened;
  // Still too long (e.g. many apply_patch blocks): only the short top-level values.
  const short = Object.entries(args).filter(([, v]) => v === null || (typeof v !== "object" && String(v).length <= MAX_HOOK_ARG_CHARS));
  return JSON.stringify({ ...Object.fromEntries(short), _truncado: true });
}

function capEnv(value: string): string {
  return value.length <= MAX_HOOK_ENV_CHARS
    ? value
    : `${value.slice(0, MAX_HOOK_ENV_CHARS)}... [${value.length - MAX_HOOK_ENV_CHARS} caracteres omitidos]`;
}

/**
 * Runs a configured hook shell command for a given event. `signal` is the turn's: cancelling
 * it stops the hook too.
 */
export async function runHook(
  event: HookEvent,
  config?: HookConfig,
  context: { toolName?: string; toolArgs?: Record<string, unknown>; command?: string; cwd?: string; filePath?: string } = {},
  signal?: AbortSignal
): Promise<HookResult> {
  const effectiveCwd = context.cwd || process.cwd();

  // If no explicit config provided, try loading from workspace/global
  const effectiveConfig = config || (await loadHooksConfig(effectiveCwd));
  if (!effectiveConfig) return { executed: false };

  const command: unknown = effectiveConfig[event];
  if (typeof command !== "string" || !command.trim()) {
    return { executed: false };
  }

  try {
    await log("info", `Executando hook [${event}]: ${command}`);

    // Pass hook context as environment variables
    const env = {
      ...process.env,
      SILICONFLOWER_EVENT: event,
      SILICONFLOWER_TOOL_NAME: context.toolName || "",
      SILICONFLOWER_TOOL_ARGS: context.toolArgs ? hookToolArgs(context.toolArgs) : "",
      SILICONFLOWER_COMMAND: capEnv(context.command || ""),
      SILICONFLOWER_FILE_PATH: context.filePath || "",
    };

    const res = await runShell(command, { cwd: effectiveCwd, env, timeout: HOOK_TIMEOUT_MS, signal });
    const output = (res.stdout + (res.stderr ? `\nStderr: ${res.stderr}` : "")).trim();
    const failure = describeFailure(res, HOOK_TIMEOUT_MS);
    if (failure) {
      await log("error", `Erro ao executar hook [${event}]: ${failure}`);
      return { executed: true, command, output, error: failure };
    }
    return { executed: true, command, output };
  } catch (e: any) {
    const errorMsg = e.message || String(e);
    await log("error", `Erro ao executar hook [${event}]: ${errorMsg}`);
    return { executed: true, command, error: errorMsg };
  }
}
