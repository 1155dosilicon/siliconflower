import { describe, expect, test } from "bun:test";
import { isValid, defaultPreset, normalize } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

describe("config", () => {
  test("defaultPreset points at an OpenAI-compatible endpoint", () => {
    expect(defaultPreset().baseURL).toContain("api.siliconflow.com");
  });

  test("isValid validates configuration completeness", () => {
    const valid: AppConfig = {
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-123",
      model: "gpt-4o",
      reasoning: "high",
    };
    expect(isValid(valid)).toBe(true);

    const invalid: AppConfig = {
      baseURL: "",
      apiKey: "sk-123",
      model: "gpt-4o",
      reasoning: "high",
    };
    expect(isValid(invalid)).toBe(false);
  });

  test("tokenWeights are read from config.json, bounded, and 1/1 means the raw sum", () => {
    const base = { apiKey: "k", baseURL: "https://api.test.com", model: "m", reasoning: "low" as const };
    expect(normalize(base).tokenWeights).toBeUndefined();
    // What the user wrote is what is used: the default is not a decision forced on them.
    expect(normalize({ ...base, tokenWeights: { prefill: 1, cacheHit: 1 } }).tokenWeights).toEqual({ prefill: 1, cacheHit: 1 });
    expect(normalize({ ...base, tokenWeights: { prefill: 0 } }).tokenWeights).toEqual({ prefill: 0, cacheHit: 0.025 });
    // Nonsense falls back to the default instead of turning the budget off.
    expect(normalize({ ...base, tokenWeights: { prefill: -5, cacheHit: "x" } }).tokenWeights).toEqual({ prefill: 0, cacheHit: 0.025 });
    expect(normalize({ ...base, tokenWeights: { prefill: 1e9 } }).tokenWeights!.prefill).toBe(10);
  });

  test("normalize preserves hooks and handles mode aliases", () => {
    const norm1 = normalize({
      apiKey: "test-key",
      baseURL: "https://api.test.com",
      model: "test-model",
      mode: "programacao" as any,
      hooks: {
        preTool: "echo pre",
        onEdit: "bun x tsc",
      },
    });

    expect(norm1.mode).toBe("programação");
    expect(norm1.hooks).toBeDefined();
    expect(norm1.hooks?.preTool).toBe("echo pre");
    expect(norm1.hooks?.onEdit).toBe("bun x tsc");

    const norm2 = normalize({
      mode: "sys" as any,
    });
    expect(norm2.mode).toBe("sistema");

    const norm3 = normalize({
      mode: "plan" as any,
    });
    expect(norm3.mode).toBe("plano");
  });

  test("normalize drops the legacy provider key from config data", () => {
    const norm = normalize({ provider: "anthropic", model: "gpt-4o" } as any);
    expect("provider" in norm).toBe(false);
  });
});
