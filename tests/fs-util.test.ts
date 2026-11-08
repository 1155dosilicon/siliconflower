import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, access } from "node:fs/promises";
import { ensureDir, hidePathOnWindows, getWorkspaceId, getWorkspaceDataDir, getGlobalDataDir, isPathBlocked } from "../src/fs-util.js";

describe("fs-util", () => {
  test("getWorkspaceId generates consistent hash and slug", () => {
    const sample = process.platform === "win32" ? "C:\\Projects\\MyApp" : "/home/user/Projects/MyApp";
    const id1 = getWorkspaceId(sample);
    const id2 = getWorkspaceId(sample.replace(/\\/g, "/"));
    expect(id1).toBe(id2);
    expect(id1).toContain("myapp-");
  });

  test("getWorkspaceId preserves path case on Unix (no collision)", () => {
    if (process.platform === "win32") return;
    const a = getWorkspaceId("/home/user/Projects/MyApp");
    const b = getWorkspaceId("/home/user/Projects/myapp");
    expect(a).not.toBe(b);
  });

  test("getWorkspaceId folds path case on Windows", () => {
    if (process.platform !== "win32") return;
    expect(getWorkspaceId("C:\\Projects\\MyApp")).toBe(getWorkspaceId("c:\\projects\\myapp"));
  });

  test("getWorkspaceDataDir returns path in ~/.siliconflower/workspaces", () => {
    const sample = process.platform === "win32" ? "C:\\Projects\\SampleApp" : "/home/user/Projects/SampleApp";
    const wsDir = getWorkspaceDataDir(sample);
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

  test("isPathBlocked covers the sensitive folders and what is inside them", () => {
    for (const path of ["/etc", "/etc/passwd", "/root/.bashrc", "/boot/grub", "/home/u/.ssh", "/home/u/.ssh/id_rsa", "/home/u/.aws/credentials", "C:\\Windows\\System32\\drivers", "c:/windows/syswow64"]) {
      expect(isPathBlocked(path)).toBe(true);
    }
    for (const path of ["/etc2", "/home/u/projeto", "/home/u/.sshx", "C:\\Windows\\Temp"]) {
      expect(isPathBlocked(path)).toBe(false);
    }
  });
});
