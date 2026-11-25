import { describe, expect, test } from "bun:test";
import {
  EMPTY_CORRECT_AT,
  EMPTY_WARN_AT,
  ERROR_STOP_AT,
  ERROR_WARN_AT,
  LoopGuard,
  CACHE_HIT_WEIGHT,
  PREFILL_WEIGHT,
  REPEAT_CORRECT_AT,
  REPEAT_STOP_AT,
  TurnBudget,
  describeLimit,
  errorSignature,
  isEmptyResult,
  wrapUpPrompt,
  weightedCost,
} from "../src/turn-limits.js";
import { askAfterMinutes, askAfterTokens, DEFAULT_ASK_AFTER_MINUTES, DEFAULT_ASK_AFTER_TOKENS, normalize } from "../src/config.js";
import { continueQuestion } from "../src/session.js";
import type { AppConfig } from "../src/types.js";

describe("turn budget", () => {
  test("each budget stops the turn when used up, and only that one", () => {
    let now = 0;
    const budget = new TurnBudget({ steps: 10, tokens: 1000, minutes: 5 }, () => now);
    expect(budget.exceeded()).toBeNull();
    budget.steps = 10;
    expect(budget.exceeded()).toMatchObject({ reason: "steps", steps: 10, limit: 10 });
    budget.steps = 3;
    budget.tokens = 1000;
    expect(budget.exceeded()).toMatchObject({ reason: "tokens", tokens: 1000 });
    budget.tokens = 0;
    now = 5 * 60_000;
    expect(budget.exceeded()).toMatchObject({ reason: "time", elapsedMs: 300_000, limit: 5 });
  });

  test("going on gives a full allowance again from where the turn is", () => {
    let now = 0;
    const budget = new TurnBudget({ steps: 10, tokens: 1000, minutes: 5 }, () => now);
    budget.steps = 10;
    budget.tokens = 1200;
    budget.extend();
    expect(budget.exceeded()).toBeNull();
    budget.steps = 19;
    budget.tokens = 2199;
    expect(budget.exceeded()).toBeNull();
    budget.steps = 20;
    expect(budget.exceeded()?.reason).toBe("steps");
    budget.extend();
    budget.tokens = 2200;
    expect(budget.exceeded()?.reason).toBe("tokens");
    budget.extend();
    now = 5 * 60_000;
    expect(budget.exceeded()?.reason).toBe("time");
    budget.extend();
    expect(budget.exceeded()).toBeNull();
  });

  test("0 turns a budget off", () => {
    let now = 0;
    const budget = new TurnBudget({ steps: 0, tokens: 0, minutes: 0 }, () => now);
    budget.steps = 1_000_000;
    budget.tokens = 1e12;
    now = 1e12;
    expect(budget.exceeded()).toBeNull();
    expect(budget.landingNotice()).toBe("");
  });

  test("the model is told once per budget when 10% is left", () => {
    let now = 0;
    const budget = new TurnBudget({ steps: 150, tokens: 1_000_000, minutes: 60 }, () => now);
    budget.steps = 134;
    expect(budget.landingNotice()).toBe("");
    budget.steps = 135;
    expect(budget.landingNotice()).toContain("restam 15 de 150 passos");
    budget.steps = 136;
    expect(budget.landingNotice()).toBe("");
    budget.tokens = 950_000;
    expect(budget.landingNotice()).toContain("tokens");
    now = 55 * 60_000;
    const notice = budget.landingNotice();
    expect(notice).toContain("restam ~5 de 60 min");
    expect(notice).toContain("Encaminhe para terminar");
  });

  test("a small limit still warns one step before", () => {
    const budget = new TurnBudget({ steps: 3, tokens: 0, minutes: 0 });
    budget.steps = 2;
    expect(budget.landingNotice()).toContain("restam 1 de 3 passos");
  });

  test("the token budget measures the cost of the turn, not the context re-sent", () => {
    const budget = new TurnBudget({ steps: 0, tokens: 100_000, minutes: 0 });
    // Sending a 90K context again costs 9000, not 90000: the same budget holds ~11 steps of a
    // full context instead of stopping after one, and it does not move with the context size.
    budget.addUsage(90_000, 500);
    expect(budget.tokens).toBe(9_500);
    expect(budget.exceeded()).toBeNull();
    budget.addUsage(90_000, 500);
    for (let i = 0; i < 8; i++) budget.addUsage(90_000, 500);
    expect(budget.tokens).toBe(95_000);
    expect(budget.exceeded()).toBeNull();
    budget.addUsage(90_000, 500);
    expect(budget.exceeded()).toMatchObject({ reason: "tokens", limit: 100_000 });
  });

  test("output is not discounted, and the weight is the documented one", () => {
    expect(weightedCost(1_000_000, 0)).toBe(100_000);
    expect(weightedCost(0, 1_000)).toBe(1_000);
    expect(weightedCost(10_000, 0)).toBe(PREFILL_WEIGHT * 10_000);
  });

  test("a cached input token is cheaper than a fresh one, and can never exceed the input", () => {
    // The prompt cache is what makes a long turn cheap: without this, every re-sent prefix is
    // priced as new and the budget asks for more money than the provider charged.
    expect(weightedCost(100_000, 0, 100_000)).toBe(CACHE_HIT_WEIGHT * 100_000);
    expect(weightedCost(100_000, 0, 0)).toBe(PREFILL_WEIGHT * 100_000);
    const half = weightedCost(100_000, 0, 50_000);
    expect(half).toBe(50_000 * PREFILL_WEIGHT + 50_000 * CACHE_HIT_WEIGHT);
    // A provider that reports more cached tokens than input cannot make the cost negative.
    expect(weightedCost(1_000, 0, 999_999)).toBe(CACHE_HIT_WEIGHT * 1_000);
  });

  test("the user can turn the weighing off and get the raw sum the provider reports", () => {
    const raw = new TurnBudget({ steps: 0, tokens: 0, minutes: 0 }, undefined, { prefill: 1, cacheHit: 1 });
    raw.addUsage(90_000, 500, 80_000);
    expect(raw.tokens).toBe(90_500);
    const mine = new TurnBudget({ steps: 0, tokens: 0, minutes: 0 }, undefined, { prefill: 0, cacheHit: 0 });
    mine.addUsage(90_000, 500, 80_000);
    // Only the output counts: the user decided the input is free in their plan.
    expect(mine.tokens).toBe(500);
  });

  test("the wrap-up asks for what was done, found and is left, without tools", () => {
    const prompt = wrapUpPrompt({ reason: "steps", limit: 150, steps: 150, tokens: 0, elapsedMs: 0 });
    expect(prompt).toContain("150 passos");
    expect(prompt).toContain("Não chame mais ferramentas");
    for (const part of ["Feito", "Descobertas", "Falta", "Próximo passo"]) expect(prompt).toContain(part);
    expect(describeLimit({ reason: "steps", limit: 1, steps: 1, tokens: 0, elapsedMs: 0 })).toBe("1 passo de ferramentas (limite de 1)");
    expect(describeLimit({ reason: "loop", limit: 0, steps: 9, tokens: 0, elapsedMs: 0, detail: "x repetida" })).toContain("x repetida");
  });

  test("the question at a limit says what ran out", () => {
    const usage = { steps: 40, tokens: 8_000_000, elapsedMs: 61 * 60_000 };
    expect(continueQuestion({ reason: "steps", limit: 150, ...usage, steps: 150 })).toContain("150 passos");
    expect(continueQuestion({ reason: "tokens", limit: 8_000_000, ...usage })).toContain("8.00M tokens");
    expect(continueQuestion({ reason: "time", limit: 60, ...usage })).toContain("61 min");
    expect(continueQuestion({ reason: "loop", limit: 0, ...usage, detail: "ler repetida" })).toContain("loop (ler repetida)");
  });

  test("askAfterTokens and askAfterMinutes of config.json are bounded, optional and 0 turns them off", () => {
    expect(askAfterTokens(undefined)).toBe(DEFAULT_ASK_AFTER_TOKENS);
    expect(askAfterMinutes("abc")).toBe(DEFAULT_ASK_AFTER_MINUTES);
    expect(askAfterMinutes(-1)).toBe(0);
    expect(askAfterMinutes(10_000_000)).toBe(24 * 60);
    expect(normalize({ askAfterTokens: 0, askAfterMinutes: 30.9 } as Partial<AppConfig>)).toMatchObject({ askAfterTokens: 0, askAfterMinutes: 30 });
    const plain = normalize({});
    expect("askAfterTokens" in plain || "askAfterMinutes" in plain).toBe(false);
  });
});

describe("loop guard", () => {
  test("the same call with the same result warns, then corrects, then stops", () => {
    const guard = new LoopGuard();
    const notices = Array.from({ length: REPEAT_STOP_AT }, () => guard.observe("ler", { path: "a" }, "igual", false));
    expect(notices[1]!.notice).toBe("");
    expect(notices[2]!.notice).toContain("3ª vez");
    expect(notices[REPEAT_CORRECT_AT - 1]!.notice).toContain("isto é um loop");
    expect(notices.slice(0, -1).every((v) => !v.stop)).toBe(true);
    expect(notices.at(-1)!.stop).toContain(`ler chamada ${REPEAT_STOP_AT} vezes`);
  });

  test("A, B, A, B counts as a repetition too", () => {
    const guard = new LoopGuard();
    let last = { notice: "" };
    for (let i = 0; i < 3; i++) {
      guard.observe("a", {}, "x", false);
      last = guard.observe("b", {}, "y", false);
    }
    expect(last.notice).toContain("3ª vez");
  });

  test("a result that changes is not a loop", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 20; i++) expect(guard.observe("testes", {}, `falhas: ${i}`, false)).toEqual({ notice: "" });
  });

  test("the same error with varied arguments warns and finally stops; a success clears it", () => {
    const guard = new LoopGuard();
    const fail = (i: number) => guard.observe("edit_file", { oldText: `tentativa ${i}` }, `oldText não encontrado em src/a.ts. Linhas semelhantes encontradas próximas às linhas: ${i}.`, true);
    for (let i = 1; i < ERROR_WARN_AT; i++) expect(fail(i).notice).toBe("");
    expect(fail(ERROR_WARN_AT).notice).toContain("falharam com o mesmo erro");
    guard.observe("edit_file", { oldText: "certo" }, "Editado: src/a.ts", false);
    expect(fail(100).notice).toBe("");
    let verdict = { notice: "" } as ReturnType<LoopGuard["observe"]>;
    for (let i = 2; i <= ERROR_STOP_AT; i++) verdict = fail(100 + i);
    expect(verdict.stop).toContain(`edit_file falhou ${ERROR_STOP_AT} vezes seguidas`);
  });

  test("errors of different tools are counted apart", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 4; i++) {
      expect(guard.observe("a", { i }, "Erro: falhou", true).notice === "").toBe(i < ERROR_WARN_AT - 1);
      guard.observe("b", { i }, "Erro: outro", true);
    }
  });

  test("searches that keep finding nothing warn, but never stop the turn", () => {
    const guard = new LoopGuard();
    const miss = (i: number) => guard.observe("search", { pattern: `p${i}` }, "Nenhuma ocorrência encontrada.", false);
    for (let i = 1; i < EMPTY_WARN_AT; i++) expect(miss(i).notice).toBe("");
    expect(miss(EMPTY_WARN_AT).notice).toContain("buscas seguidas sem resultado");
    for (let i = EMPTY_WARN_AT + 1; i < EMPTY_CORRECT_AT; i++) miss(i);
    const firm = miss(EMPTY_CORRECT_AT);
    expect(firm.notice).toContain("Pare de variar a busca");
    for (let i = 0; i < 30; i++) expect(miss(1000 + i).stop).toBeUndefined();
    guard.observe("read_file", { path: "a" }, "conteúdo", false);
    expect(miss(5000).notice).toBe("");
  });

  test("going on after a loop starts the counting again", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < REPEAT_STOP_AT; i++) guard.observe("ler", {}, "igual", false);
    guard.reset();
    expect(guard.observe("ler", {}, "igual", false)).toEqual({ notice: "" });
  });

  test("what counts as an empty result", () => {
    expect(isEmptyResult("", false)).toBe(true);
    expect(isEmptyResult("[]", false)).toBe(true);
    expect(isEmptyResult("(nenhum arquivo encontrado)", false)).toBe(true);
    expect(isEmptyResult("Nenhum resultado encontrado na web para 'x'", false)).toBe(true);
    // grep/rg without matches through execute_command.
    expect(isEmptyResult("Erro ao executar comando (código de saída 1)", true)).toBe(true);
    // A command that worked and printed nothing (mkdir, cp) is not a failed search.
    expect(isEmptyResult("(comando executado com sucesso sem saída de texto)", false)).toBe(false);
    expect(isEmptyResult("Erro ao executar comando (código de saída 2)\n--- STDERR ---\nx", true)).toBe(false);
  });

  test("an error is the same whatever numbers and details follow it", () => {
    expect(errorSignature("oldText não encontrado em a.ts. Linhas semelhantes: 3, 9.")).toBe(errorSignature("oldText não encontrado em a.ts. Linhas semelhantes: 40."));
    expect(errorSignature("Erro (código de saída 2)\nstderr")).toBe("Erro (código de saída #)");
  });
});
