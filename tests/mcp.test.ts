import { describe, expect, test } from "bun:test";
import { qualifyMcpToolName } from "../src/mcp.js";

describe("MCP tool names", () => {
  test("qualifies names deterministically without collisions", () => {
    const first = qualifyMcpToolName("filesystem", "read_file");
    expect(first).toBe(qualifyMcpToolName("filesystem", "read_file"));
    expect(first).not.toBe(qualifyMcpToolName("other", "read_file"));
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
  });
});
