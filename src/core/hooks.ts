import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../logger";

const execAsync = promisify(exec);

export type HookEvent = "preTool" | "postTool" | "onEdit" | "onCommand";

export interface HookConfig {
  preTool?: string;
  postTool?: string;
  onEdit?: string;
  onCommand?: string;
}

export interface HookResult {
  executed: boolean;
  command?: string;
  output?: string;
  error?: string;
}

/**
 * Runs a configured hook shell command for a given event.
 */
export async function runHook(
  event: HookEvent,
  config?: HookConfig,
  cwd: string = process.cwd()
): Promise<HookResult> {
  if (!config) return { executed: false };

  const command = config[event];
  if (!command || !command.trim()) {
    return { executed: false };
  }

  try {
    await log("info", `Executando hook [${event}]: ${command}`);
    const { stdout, stderr } = await execAsync(command, { cwd, windowsHide: true });
    const output = (stdout + (stderr ? `\nStderr: ${stderr}` : "")).trim();
    return { executed: true, command, output };
  } catch (e: any) {
    const errorMsg = e.message || String(e);
    await log("error", `Erro ao executar hook [${event}]: ${errorMsg}`);
    return { executed: true, command, error: errorMsg };
  }
}
