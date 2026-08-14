import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, access } from "node:fs/promises";
import { ensureDir, hidePathOnWindows } from "../src/fs-util.js";

describe("fs-util", () => {
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
