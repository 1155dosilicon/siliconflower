import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubagentSystemPrompt,
  getSubagentSession,
  isSubagentToolAllowed,
  runSubagentTask,
  sendSubagentMessage,
  subagentTools,
} from "../src/services/subagent.js";
import type { AppConfig } from "../src/types.js";

describe("subagent service", () => {
  const mockConfig: AppConfig = {
    baseURL: "https://api.mock.test/v1",
    apiKey: "mock-key",
    model: "mock-model",
    reasoning: "none",
  };

  test("creates background subagent task and registers session", async () => {
    const res = await runSubagentTask({
      config: mockConfig,
      description: "Explore test repository structure",
      prompt: "Find all typescript files",
      role: "research",
      runInBackground: true,
    });

    expect(res).toContain("Subagente iniciado em background");
    expect(res).toContain("ID do Subagente: sub_");

    const matchId = res.match(/ID do Subagente: (sub_[a-zA-Z0-9_]+)/);
    expect(matchId).not.toBeNull();
    if (matchId) {
      const session = getSubagentSession(matchId[1]);
      expect(session).toBeDefined();
      expect(session?.role).toBe("research");
      expect(session?.description).toBe("Explore test repository structure");
    }
  });

  test("read-only roles lose write tools, in the schema list and at execution", () => {
    for (const role of ["research", "plan"] as const) {
      const names = subagentTools(role).map((t) => t.name);
      expect(names).toContain("read_file");
      for (const blocked of ["write_file", "edit_file", "delete_path", "execute_command", "send_subagent_message", "run_task"]) {
        expect(names).not.toContain(blocked);
        expect(isSubagentToolAllowed(role, blocked)).toBe(false);
      }
      // Stays in the list for "recall", but "save" is refused when it runs.
      expect(names).toContain("memory");
      expect(isSubagentToolAllowed(role, "memory", { action: "recall" })).toBe(true);
      expect(isSubagentToolAllowed(role, "memory", { action: "save" })).toBe(false);
    }
  });

  test("other roles keep the write tools but never run_task", () => {
    for (const role of ["general", "coder", "verification", "custom"] as const) {
      const names = subagentTools(role).map((t) => t.name);
      expect(names).toContain("write_file");
      expect(names).toContain("execute_command");
      expect(names).not.toContain("run_task");
      expect(isSubagentToolAllowed(role, "write_file")).toBe(true);
    }
  });

  test("the system prompt carries role, preferences and project instructions", async () => {
    const dir = join(tmpdir(), `subagent_project_${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "REGRA_DO_PROJETO", "utf8");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const prompt = await buildSubagentSystemPrompt("coder", "corrigir bug", undefined, "PREFERENCIA_DO_USUARIO");
      expect(prompt).toContain("subagente de implementação");
      expect(prompt).toContain("corrigir bug");
      expect(prompt).toContain("REGRA_DO_PROJETO");
      expect(prompt).toContain("PREFERENCIA_DO_USUARIO");
    } finally {
      process.chdir(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects follow-up message when session is not found", async () => {
    const res = await sendSubagentMessage("non_existent_session", "followup", mockConfig);
    expect(res.isError).toBe(true);
    expect(res.result).toContain("não encontrada");
  });
});
