import { describe, expect, test } from "bun:test";
import { runHook } from "../src/core/hooks.js";

describe("hooks system", () => {
  test("returns executed=false when no hook command configured", async () => {
    const res = await runHook("preTool", {});
    expect(res.executed).toBe(false);
  });

  test("executes hook command with environment variables", async () => {
    const isWin = process.platform === "win32";
    const echoCmd = isWin ? "echo %SILICONFLOWER_TOOL_NAME%" : "echo $SILICONFLOWER_TOOL_NAME";

    const res = await runHook(
      "preTool",
      { preTool: echoCmd },
      { toolName: "read_file", toolArgs: { path: "test.txt" } }
    );

    expect(res.executed).toBe(true);
    expect(res.output).toContain("read_file");
  });
});
