import type { Mode } from "./types.js";

const PLAN_READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep_content",
  "repo_map",
  "find_symbol",
  "recall_memory",
  "list_worktrees",
  "ask_question",
  "read_logs",
  "list_directory",
  "file_info",
  "search_files",
  "web_fetch",
  "web_search",
  "read_artifact",
  "list_artifacts",
  "manage_hooks",
  "read_skill",
  "todowrite",
]);

export function isToolAllowedInMode(
  mode: Mode,
  name: string,
  args: Record<string, unknown> = {}
): boolean {
  if (mode !== "plano") return true;
  if (name === "manage_background_task") {
    return args.action === "list" || args.action === "status";
  }
  return PLAN_READ_ONLY_TOOLS.has(name);
}
