import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { log } from "../logger.js";
import { getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";

const execAsync = promisify(exec);

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

/**
 * Discovers and loads hook configurations from workspace (~/.siliconflower/workspaces/<workspace-id>/hooks.json),
 * legacy repo (.siliconflower/hooks.json), or global (~/.siliconflower/hooks.json).
 */
export async function loadHooksConfig(cwd: string = process.cwd()): Promise<HookConfig | undefined> {
  const workspaceHooksFile = join(getWorkspaceDataDir(cwd), "hooks.json");
  const legacyHooksFile = join(cwd, ".siliconflower", "hooks.json");
  const globalHooksFile = join(getGlobalDataDir(), "hooks.json");

  try {
    await access(workspaceHooksFile);
    const raw = await readFile(workspaceHooksFile, "utf8");
    return JSON.parse(raw);
  } catch {
    // Fallback to legacy
  }

  try {
    await access(legacyHooksFile);
    const raw = await readFile(legacyHooksFile, "utf8");
    return JSON.parse(raw);
  } catch {
    // Fallback to global
  }

  try {
    await access(globalHooksFile);
    const raw = await readFile(globalHooksFile, "utf8");
    return JSON.parse(raw);
  } catch {
    // No hooks file found
  }

  return undefined;
}

/**
 * Runs a configured hook shell command for a given event.
 */
export async function runHook(
  event: HookEvent,
  config?: HookConfig,
  context: { toolName?: string; toolArgs?: Record<string, unknown>; command?: string; cwd?: string; filePath?: string } = {}
): Promise<HookResult> {
  const effectiveCwd = context.cwd || process.cwd();
  
  // If no explicit config provided, try loading from workspace/global
  const effectiveConfig = config || (await loadHooksConfig(effectiveCwd));
  if (!effectiveConfig) return { executed: false };

  const command = effectiveConfig[event];
  if (!command || !command.trim()) {
    return { executed: false };
  }

  try {
    await log("info", `Executando hook [${event}]: ${command}`);
    
    // Pass hook context as environment variables
    const env = {
      ...process.env,
      SILICONFLOWER_EVENT: event,
      SILICONFLOWER_TOOL_NAME: context.toolName || "",
      SILICONFLOWER_TOOL_ARGS: context.toolArgs ? JSON.stringify(context.toolArgs) : "",
      SILICONFLOWER_COMMAND: context.command || "",
      SILICONFLOWER_FILE_PATH: context.filePath || "",
    };

    const { stdout, stderr } = await execAsync(command, {
      cwd: effectiveCwd,
      env,
      windowsHide: true,
      timeout: 30000,
      shell: "powershell.exe",
    });

    const output = (stdout + (stderr ? `\nStderr: ${stderr}` : "")).trim();
    return { executed: true, command, output };
  } catch (e: any) {
    const errorMsg = e.message || String(e);
    await log("error", `Erro ao executar hook [${event}]: ${errorMsg}`);
    return { executed: true, command, error: errorMsg };
  }
}
