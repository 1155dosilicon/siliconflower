import { describe, expect, test } from "bun:test";
import { builtinToolsAsMcp, isBuiltin, runBuiltin, BUILTIN_TOOLS } from "../src/tools.js";

describe("tools", () => {
  test("isBuiltin recognizes builtin tools", () => {
    expect(isBuiltin("read_file")).toBe(true);
    expect(isBuiltin("write_file")).toBe(true);
    expect(isBuiltin("unknown_tool")).toBe(false);
  });

  test("builtinToolsAsMcp returns all tools in MCP schema format", () => {
    const list = builtinToolsAsMcp();
    expect(list.length).toBe(BUILTIN_TOOLS.length);
    expect(list.every((t) => t.server === "builtin")).toBe(true);
  });

  test("delete_path enforces confirm requirement", async () => {
    const res = await runBuiltin("delete_path", { path: "some_file.txt", confirm: false });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("confirmação");
  });

  test("blocked paths prevent access to system directories", async () => {
    const res = await runBuiltin("read_file", { path: "C:\\Windows\\System32\\config\\SAM" });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("bloqueado");
  });
});
