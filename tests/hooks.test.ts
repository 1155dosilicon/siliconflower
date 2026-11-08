import { describe, expect, test } from "bun:test";
import { runHook, loadHooksConfig, hookToolArgs, ignoredRepoHooksFile } from "../src/core/hooks.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { getWorkspaceDataDir, ensureDir } from "../src/fs-util.js";

describe("hooks system", () => {
  test("returns executed=false when no hook command configured", async () => {
    const res = await runHook("preTool", {});
    expect(res.executed).toBe(false);
  });

  test("executes hook command with environment variables", async () => {
    const isWin = process.platform === "win32";
    const echoCmd = isWin
      ? "Write-Output \"$env:SILICONFLOWER_TOOL_NAME|$env:SILICONFLOWER_FILE_PATH\""
      : "echo \"$SILICONFLOWER_TOOL_NAME|$SILICONFLOWER_FILE_PATH\"";
    const filePath = isWin ? "C:\\workspace\\test.txt" : "/workspace/test.txt";

    const res = await runHook(
      "preTool",
      { preTool: echoCmd },
      { toolName: "read_file", toolArgs: { path: "test.txt" }, filePath }
    );

    expect(res.executed).toBe(true);
    expect(res.output).toContain("read_file");
    expect(res.output).toContain(filePath);
    // First shell of the file: a cold PowerShell start on the CI runner can pass Bun's 5 s default.
  }, 30_000);

  test("loads hooks from centralized workspace directory", async () => {
    const dummyCwd = join(tmpdir(), `dummy_hook_ws_${Date.now()}`);
    const wsDir = getWorkspaceDataDir(dummyCwd);
    await ensureDir(wsDir);

    const hookFile = join(wsDir, "hooks.json");
    await writeFile(hookFile, JSON.stringify({ preTool: "echo workspace_hook" }), "utf8");

    const loaded = await loadHooksConfig(dummyCwd);
    expect(loaded).toBeDefined();
    expect(loaded?.preTool).toBe("echo workspace_hook");

    await rm(wsDir, { recursive: true, force: true });
  });

  test("a hooks.json inside the repository is not loaded, only reported", async () => {
    const repo = join(tmpdir(), `repo_hooks_${Date.now()}`);
    await mkdir(join(repo, ".siliconflower"), { recursive: true });
    const file = join(repo, ".siliconflower", "hooks.json");
    await writeFile(file, JSON.stringify({ onCommand: "echo do_repositorio" }), "utf8");
    try {
      expect((await loadHooksConfig(repo))?.onCommand).toBeUndefined();
      expect(await ignoredRepoHooksFile(repo)).toBe(file);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("tool arguments for the environment stay valid JSON within the size limit", () => {
    const small = { path: "a.txt", content: "oi" };
    expect(hookToolArgs(small)).toBe(JSON.stringify(small));
    const big = JSON.parse(hookToolArgs({ path: "a.txt", content: "x".repeat(500_000) }));
    expect(big.path).toBe("a.txt");
    expect(big.content).toContain("caracteres omitidos");
    const many = { path: "a.txt", changes: Array.from({ length: 50 }, () => ({ oldText: "o".repeat(3_000), newText: "n".repeat(3_000) })) };
    const shortened = hookToolArgs(many);
    expect(shortened.length).toBeLessThanOrEqual(16_000);
    expect(JSON.parse(shortened)).toEqual({ path: "a.txt", _truncado: true });
  });
});
