import { describe, expect, test } from "bun:test";
import { isValid, presets, normalize } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

describe("config", () => {
  test("presets returns openai and anthropic presets", () => {
    const p = presets();
    expect(p.openai).toBeDefined();
    expect(p.anthropic).toBeDefined();
    expect(p.openai.baseURL).toContain("api.siliconflow.com");
  });

  test("isValid validates configuration completeness", () => {
    const valid: AppConfig = {
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-123",
      model: "gpt-4o",
      reasoning: "high",
    };
    expect(isValid(valid)).toBe(true);

    const invalid: AppConfig = {
      provider: "openai",
      baseURL: "",
      apiKey: "sk-123",
      model: "gpt-4o",
      reasoning: "high",
    };
    expect(isValid(invalid)).toBe(false);
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
});
