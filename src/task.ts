import { runSubagentTask as runServiceSubagent, type SubagentRole } from "./services/subagent.js";
import type { AppConfig } from "./types.js";

export interface TaskOptions {
  config: AppConfig;
  description: string;
  prompt: string;
  role?: SubagentRole;
  customPrompt?: string;
  runInBackground?: boolean;
}

export async function runSubagentTask(opts: TaskOptions): Promise<string> {
  return runServiceSubagent({
    config: opts.config,
    description: opts.description,
    prompt: opts.prompt,
    role: opts.role,
    customPrompt: opts.customPrompt,
    runInBackground: opts.runInBackground,
  });
}

