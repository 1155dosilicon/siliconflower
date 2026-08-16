import { describe, expect, test, afterEach } from "bun:test";
import { saveMemory, recallMemories, forgetMemory, buildMemorySystemPrompt } from "../src/services/memory.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("memory service", () => {
  const testWorkspace = join(tmpdir(), `memory_test_${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  test("saves, recalls and builds memory system prompt", async () => {
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
});
