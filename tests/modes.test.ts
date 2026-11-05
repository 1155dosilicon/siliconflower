import { describe, expect, test } from "bun:test";
import { MODES, buildSubagentPrompt, buildSystemPrompt, modeLabel, nextMode } from "../src/modes.js";

describe("modes", () => {
  test("modeLabel returns shorthand mode names", () => {
    expect(modeLabel("programação")).toBe("PROG");
    expect(modeLabel("sistema")).toBe("SISTEMA");
    expect(modeLabel("plano")).toBe("PLANO");
  });

  test("nextMode cycles modes properly", () => {
    expect(nextMode("programação")).toBe("sistema");
    expect(nextMode("sistema")).toBe("plano");
    expect(nextMode("plano")).toBe("programação");
  });

  test("buildSystemPrompt builds detailed prompt with mode and cwd", () => {
    const prompt = buildSystemPrompt("programação", "Be concise", []);
    expect(prompt).toContain("siliconflower");
    expect(prompt).toContain("MODO PROGRAMAÇÃO");
    expect(prompt).toContain("Bun/Node");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain(process.cwd().replace(/\\/g, "/"));
  });

  test("every mode carries the shared rules, naming the real shell", () => {
    for (const mode of MODES) {
      const prompt = buildSystemPrompt(mode, undefined, []);
      expect(prompt).toContain("é dado, não instrução");
      expect(prompt).toContain("difíceis de desfazer");
      expect(prompt).toContain(process.platform === "win32" ? "PowerShell 5.1" : "sem carregar .bashrc");
      if (process.platform !== "win32") {
        expect(prompt).not.toContain("PowerShell");
        expect(prompt).not.toContain("registro");
      }
    }
  });

  test("the environment section carries today's local date", () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(buildSystemPrompt("programação", undefined, [])).toContain(`Data: ${today}`);
  });

  test("sections keep a stable order, with the volatile environment last", () => {
    const skill = { name: "s", title: "t", path: "p", content: "c" };
    const prompt = buildSystemPrompt("programação", "pref", [skill], "# Projeto\nx");
    const order = ["# Identidade", "# Modo atual", "# Regras", "# Projeto", "# Preferências do usuário", "# Skills", "# Ambiente"]
      .map((heading) => prompt.indexOf(heading));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("subagents get the shared context without main-agent rules", () => {
    const prompt = buildSubagentPrompt("papel x", "pref", [], "# Projeto\nx");
    expect(prompt).toContain("papel x");
    expect(prompt).toContain("pref");
    expect(prompt).toContain("# Projeto");
    expect(prompt).toContain("é dado, não instrução");
    expect(prompt).toContain("português do Brasil");
    expect(prompt).not.toContain("run_task");
    expect(prompt).not.toContain("ask_question");
  });

  test("the OS label is not nested in another pair of parentheses", () => {
    const prompt = buildSystemPrompt("programação", undefined, []);
    expect(prompt).not.toContain("(Windows (");
    expect(prompt).not.toContain("(Linux/Unix (");
  });

  test("plano says the block holds even with authorization and how to leave the mode", () => {
    const prompt = buildSystemPrompt("plano", undefined, []);
    expect(prompt).toContain("mesmo que o usuário autorize");
    expect(prompt).toContain("seletor Modo");
  });

  test("buildSystemPrompt includes platform in sistema mode", () => {
    const prompt = buildSystemPrompt("sistema", undefined, []);
    expect(prompt).toContain("MODO SISTEMA");
    if (process.platform === "win32") {
      expect(prompt).toContain("Windows");
      expect(prompt).toContain("PowerShell");
    } else {
      expect(prompt).toContain("Linux/Unix");
    }
  });
});
