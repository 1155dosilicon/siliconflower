import { describe, expect, test } from "bun:test";
import { isToolAllowedInMode } from "../src/tool-policy.js";

describe("tool policy", () => {
  test("plan mode permits read-only tools", () => {
    expect(isToolAllowedInMode("plano", "read_file")).toBe(true);
    expect(isToolAllowedInMode("plano", "read_media")).toBe(true);
    expect(isToolAllowedInMode("plano", "show_hooks")).toBe(true);
    expect(isToolAllowedInMode("plano", "artifact", { action: "list" })).toBe(true);
    expect(isToolAllowedInMode("plano", "artifact", { action: "read" })).toBe(true);
    expect(isToolAllowedInMode("plano", "memory", { action: "recall" })).toBe(true);
    expect(isToolAllowedInMode("plano", "manage_background_task", { action: "status" })).toBe(true);
  });

  test("plan mode blocks the actions that change memories and artifacts", () => {
    expect(isToolAllowedInMode("plano", "memory", { action: "save" })).toBe(false);
    expect(isToolAllowedInMode("plano", "memory", { action: "forget" })).toBe(false);
    expect(isToolAllowedInMode("plano", "memory")).toBe(false);
    expect(isToolAllowedInMode("plano", "artifact", { action: "create" })).toBe(false);
    expect(isToolAllowedInMode("plano", "artifact", { action: "delete" })).toBe(false);
    expect(isToolAllowedInMode("plano", "artifact", { _raw: "{" })).toBe(false);
  });

  test("plan mode blocks mutations, subagents, MCP and task cancellation", () => {
    for (const name of ["write_file", "enter_worktree", "run_task", "send_subagent_message", "mcp_server_tool_hash"]) {
      expect(isToolAllowedInMode("plano", name)).toBe(false);
    }
    expect(isToolAllowedInMode("plano", "manage_background_task", { action: "kill" })).toBe(false);
  });
});
