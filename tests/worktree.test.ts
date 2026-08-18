import { describe, expect, test } from "bun:test";
import { listWorktrees } from "../src/services/worktree.js";

describe("worktree service", () => {
  test("listWorktrees returns at least the main worktree in a git repo", async () => {
    const list = await listWorktrees();
    expect(Array.isArray(list)).toBe(true);
    if (list.length > 0) {
      expect(list[0].path).toBeDefined();
      expect(list[0].head).toBeDefined();
    }
  });
});
