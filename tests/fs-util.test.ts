import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, access } from "node:fs/promises";
import { ensureDir, hidePathOnWindows, getWorkspaceId, getWorkspaceDataDir, getGlobalDataDir } from "../src/fs-util.js";

describe("fs-util", () => {
  test("getWorkspaceId generates consistent hash and slug", () => {
    const id1 = getWorkspaceId("C:\\Projects\\MyApp");
    const id2 = getWorkspaceId("C:/Projects/MyApp");
    expect(id1).toBe(id2);
    expect(id1).toContain("myapp-");
  });

  test("getWorkspaceDataDir returns path in ~/.siliconflower/workspaces", () => {
    const wsDir = getWorkspaceDataDir("C:\\Projects\\SampleApp");
    expect(wsDir).toContain(".siliconflower");
    expect(wsDir).toContain("workspaces");
    expect(wsDir).toContain("sampleapp-");
  });

  test("getGlobalDataDir returns ~/.siliconflower", () => {
    const globalDir = getGlobalDataDir();
    expect(globalDir).toContain(".siliconflower");
  });

  test("ensureDir creates directory and does not throw", async () => {
    const testDir = join(tmpdir(), `.siliconflower_test_${Date.now()}`);
    await ensureDir(testDir);
    
    let exists = false;
    try {
      await access(testDir);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });

  test("hidePathOnWindows runs without throwing on valid directory", async () => {
    const testDir = join(tmpdir(), `.siliconflower_test_hide_${Date.now()}`);
    await ensureDir(testDir);
    await expect(hidePathOnWindows(testDir)).resolves.toBeUndefined();
    await rm(testDir, { recursive: true, force: true });
  });
});
