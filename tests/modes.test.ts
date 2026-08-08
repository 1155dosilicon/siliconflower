import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, modeLabel, nextMode } from "../src/modes.js";

describe("modes", () => {
  test("modeLabel returns shorthand mode names", () => {
    expect(modeLabel("programação")).toBe("PROG");
    expect(modeLabel("sistema")).toBe("SISTEMA");
  });

  test("nextMode cycles modes properly", () => {
    expect(nextMode("programação")).toBe("sistema");
    expect(nextMode("sistema")).toBe("programação");
  });

  test("buildSystemPrompt builds detailed prompt with mode and cwd", () => {
    const prompt = buildSystemPrompt("programação", "Be concise", []);
    expect(prompt).toContain("siliconflower");
    expect(prompt).toContain("MODO PROGRAMAÇÃO");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain(process.cwd().replace(/\\/g, "/"));
  });
});
