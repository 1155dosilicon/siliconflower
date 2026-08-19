import { describe, expect, test } from "bun:test";
import { isToolAllowedInMode } from "../src/tool-policy.js";

describe("tool policy", () => {
  test("plan mode permits read-only tools", () => {
    expect(isToolAllowedInMode("plano", "read_file")).toBe(true);
    expect(isToolAllowedInMode("plano", "list_artifacts")).toBe(true);
    expect(isToolAllowedInMode("plano", "manage_background_task", { action: "status" })).toBe(true);
  });

  test("plan mode blocks mutations, subagents, MCP and task cancellation", () => {
    for (const name of ["write_file", "save_memory", "create_artifact", "enter_worktree", "run_task", "send_subagent_message", "mcp_server_tool_hash"]) {
      expect(isToolAllowedInMode("plano", name)).toBe(false);
    }
    expect(isToolAllowedInMode("plano", "manage_background_task", { action: "kill" })).toBe(false);
  });
});
