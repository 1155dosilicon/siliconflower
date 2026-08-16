import { describe, expect, test } from "bun:test";
import { runSubagentTask, getSubagentSession, sendSubagentMessage } from "../src/services/subagent.js";
import type { AppConfig } from "../src/types.js";

describe("subagent service", () => {
  const mockConfig: AppConfig = {
    provider: "openai",
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

  test("rejects follow-up message when session is not found", async () => {
    const res = await sendSubagentMessage("non_existent_session", "followup", mockConfig);
    expect(res.isError).toBe(true);
    expect(res.result).toContain("não encontrada");
  });
});
