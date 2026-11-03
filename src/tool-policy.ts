import type { Mode } from "./types.js";

const PLAN_READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_media",
  "grep_content",
  "repo_map",
  "find_symbol",
  "list_worktrees",
  "ask_question",
  "read_logs",
  "list_directory",
  "file_info",
  "search_files",
  "web_fetch",
  "web_search",
  "show_hooks",
  "read_skill",
  "todowrite",
]);

/** Tools whose read-only use depends on the `action` argument (see isToolAllowedInMode). */
const ACTION_GATED_TOOLS = new Set(["manage_background_task", "memory", "artifact"]);

/** Whether a tool has any use under the read-only policy, to leave the others out of the schema list. */
export function hasReadOnlyUse(name: string): boolean {
  return PLAN_READ_ONLY_TOOLS.has(name) || ACTION_GATED_TOOLS.has(name);
}

export function isToolAllowedInMode(
  mode: Mode,
  name: string,
  args: Record<string, unknown> = {}
): boolean {
  if (mode !== "plano") return true;
  if (name === "manage_background_task") {
    return args.action === "list" || args.action === "status";
  }
  if (name === "memory") return args.action === "recall";
  if (name === "artifact") return args.action === "read" || args.action === "list";
  return PLAN_READ_ONLY_TOOLS.has(name);
}
