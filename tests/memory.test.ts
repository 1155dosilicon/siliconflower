import { describe, expect, test, afterEach } from "bun:test";
import { saveMemory, recallMemories, forgetMemory, buildMemorySystemPrompt } from "../src/services/memory.js";
import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkspaceDataDir } from "../src/fs-util.js";

describe("memory service", () => {
  const testWorkspace = join(tmpdir(), `memory_test_${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testWorkspace, { recursive: true, force: true });
    } catch {}
    try {
      const wsDir = getWorkspaceDataDir(testWorkspace);
      await rm(wsDir, { recursive: true, force: true });
    } catch {}
  });

  test("saves, recalls and builds memory system prompt without creating .siliconflower in workspace", async () => {
    const saveRes = await saveMemory(
      {
        name: "test_rule",
        type: "feedback",
        description: "Always write clean code with comments",
        scope: "project",
        content: "Rule details: Always add concise docstrings to public exports.",
      },
      testWorkspace
    );

    expect(saveRes.message).toContain("salva com sucesso");

    // Verify workspace directory does NOT have .siliconflower created in it
    let localDirExists = false;
    try {
      await access(join(testWorkspace, ".siliconflower"));
      localDirExists = true;
    } catch {
      localDirExists = false;
    }
    expect(localDirExists).toBe(false);

    // Verify memory file was written into centralized workspace storage
    expect(saveRes.path).toContain(".siliconflower");
    expect(saveRes.path).toContain("workspaces");

    const memories = await recallMemories("clean code", testWorkspace);
    expect(memories.length).toBeGreaterThanOrEqual(1);
    const found = memories.find((m) => m.name === "test_rule");
    expect(found).toBeDefined();
    expect(found?.content).toContain("Rule details");

    const prompt = await buildMemorySystemPrompt(testWorkspace);
    expect(prompt).toContain("test_rule");
    expect(prompt).toContain("Memória Persistente");
  });

  test("forgets memory by name", async () => {
    await saveMemory(
      {
        name: "obsolete_rule",
        type: "project",
        description: "Temporary obsolete rule",
        scope: "project",
        content: "This rule will be forgotten.",
      },
      testWorkspace
    );

    const forgetRes = await forgetMemory("obsolete_rule", testWorkspace);
    expect(forgetRes.isError).toBe(false);
    expect(forgetRes.message).toContain("removida com sucesso");

    const memories = await recallMemories("obsolete_rule", testWorkspace);
    const found = memories.find((m) => m.name === "obsolete_rule");
    expect(found).toBeUndefined();
  });

  test("forgets only the requested memory scope", async () => {
    const name = `scoped_rule_${Date.now()}`;
    const base = {
      name,
      type: "project" as const,
      description: "Scoped memory",
      content: "Scope-specific content",
    };
    await saveMemory({ ...base, scope: "project" }, testWorkspace);
    await saveMemory({ ...base, scope: "global" }, testWorkspace);

    expect((await forgetMemory(name, testWorkspace, "project")).isError).toBe(false);
    const remaining = await recallMemories(name, testWorkspace);
    expect(remaining.some((entry) => entry.scope === "global")).toBe(true);
    expect(remaining.some((entry) => entry.scope === "project")).toBe(false);
    await forgetMemory(name, testWorkspace, "global");
  });
});
