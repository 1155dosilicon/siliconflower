import { describe, expect, test } from "bun:test";
import { isValid, presets } from "../src/config.js";
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
});
