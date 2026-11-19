import { createHash } from "node:crypto";
import { formatTokenCount } from "./context.js";
import type { LimitReason } from "./types.js";

/*
 * What keeps one turn from running forever: budgets of steps, tokens and time (`TurnBudget`)
 * and a detector of loops (`LoopGuard`). Neither stops anything itself: llm.ts asks them
 * between steps and either asks the user (`confirmContinue`) or ends the turn with a summary.
 */

export interface TurnUsage {
  steps: number;
  tokens: number;
  elapsedMs: number;
}

export interface LimitHit extends TurnUsage {
  reason: LimitReason;
  /** The limit that was reached (steps, tokens or minutes); 0 for a loop. */
  limit: number;
  /** For a loop: what was repeated. */
  detail?: string;
}

/** Each 0 turns that budget off. */
export interface TurnLimits {
  steps: number;
  tokens: number;
  minutes: number;
}

/** Share of a budget left when the model is told to wrap up (only when nobody can be asked). */
const LANDING_SHARE = 0.1;

export class TurnBudget {
  steps = 0;
  tokens = 0;
  private readonly started: number;
  /** Where each budget asks next: it moves on by a full allowance when the user goes on. */
  private next: { steps: number; tokens: number; ms: number };
  private landed = { steps: false, tokens: false, time: false };

  constructor(
    private readonly limits: TurnLimits,
    private readonly now: () => number = () => Date.now()
  ) {
    this.started = now();
    this.next = { steps: limits.steps, tokens: limits.tokens, ms: limits.minutes * 60_000 };
  }

  elapsedMs(): number {
    return this.now() - this.started;
  }

  usage(): TurnUsage {
    return { steps: this.steps, tokens: this.tokens, elapsedMs: this.elapsedMs() };
  }

  /** The first budget used up, if any. */
  exceeded(): LimitHit | null {
    const usage = this.usage();
    if (this.limits.steps && this.steps >= this.next.steps) return { reason: "steps", limit: this.limits.steps, ...usage };
    if (this.limits.tokens && this.tokens >= this.next.tokens) return { reason: "tokens", limit: this.limits.tokens, ...usage };
    if (this.limits.minutes && usage.elapsedMs >= this.next.ms) return { reason: "time", limit: this.limits.minutes, ...usage };
    return null;
  }

  /** The user went on: every budget already used up gets another full allowance from here. */
  extend(): void {
    const elapsed = this.elapsedMs();
    if (this.limits.steps && this.steps >= this.next.steps) this.next.steps = this.steps + this.limits.steps;
    if (this.limits.tokens && this.tokens >= this.next.tokens) this.next.tokens = this.tokens + this.limits.tokens;
    if (this.limits.minutes && elapsed >= this.next.ms) this.next.ms = elapsed + this.limits.minutes * 60_000;
  }

  /**
   * Once per budget, when less than LANDING_SHARE of it is left: a note telling the model to
   * finish, so it usually answers by itself before the hard stop. Empty otherwise.
   */
  landingNotice(): string {
    const parts: string[] = [];
    const near = (used: number, limit: number) => limit > 0 && used < limit && limit - used <= Math.max(1, Math.round(limit * LANDING_SHARE));
    if (!this.landed.steps && near(this.steps, this.limits.steps)) {
      this.landed.steps = true;
      parts.push(`restam ${this.limits.steps - this.steps} de ${this.limits.steps} passos`);
    }
    if (!this.landed.tokens && near(this.tokens, this.limits.tokens)) {
      this.landed.tokens = true;
      parts.push(`restam ~${formatTokenCount(this.limits.tokens - this.tokens)} de ${formatTokenCount(this.limits.tokens)} tokens`);
    }
    const limitMs = this.limits.minutes * 60_000;
    if (!this.landed.time && near(this.elapsedMs(), limitMs)) {
      this.landed.time = true;
      parts.push(`restam ~${Math.max(1, Math.round((limitMs - this.elapsedMs()) / 60_000))} de ${this.limits.minutes} min`);
    }
    if (!parts.length) return "";
    return `\n\n[Aviso automático do siliconflower: este turno está perto do limite (${parts.join("; ")}). Encaminhe para terminar: conclua só o essencial e responda com o que fez, o que descobriu e o que falta. Não comece nada grande agora.]`;
  }
}

/** How the limit is described to the user and to the model. */
export function describeLimit(hit: LimitHit): string {
  switch (hit.reason) {
    case "steps":
      return `${hit.steps} passos de ferramentas (limite de ${hit.limit})`;
    case "tokens":
      return `${formatTokenCount(hit.tokens)} tokens (limite de ${formatTokenCount(hit.limit)})`;
    case "time":
      return `${Math.round(hit.elapsedMs / 60_000)} min de trabalho (limite de ${hit.limit} min)`;
    case "loop":
      return `loop sem progresso: ${hit.detail ?? "a mesma ação repetida"}`;
  }
}

/** The instruction for the last request of a stopped turn: no tools, only the report. */
export function wrapUpPrompt(hit: LimitHit): string {
  return [
    `[Mensagem automática do siliconflower, não do usuário] Este turno foi encerrado: ${describeLimit(hit)}.`,
    "Não chame mais ferramentas. Responda agora, no idioma do pedido do usuário, com:",
    "1. **Feito:** o que você já fez (arquivos alterados, comandos rodados, resultados).",
    "2. **Descobertas:** o que aprendeu que importa para a tarefa.",
    "3. **Falta:** o que ainda não foi feito ou não funcionou, e por quê.",
    "4. **Próximo passo:** a próxima ação concreta para continuar.",
    "Seja direto e não afirme nada que não esteja no histórico.",
  ].join("\n");
}

/** The note that opens the answer of a stopped turn, before the summary. */
export function limitHeader(hit: LimitHit): string {
  return `[Parei antes de terminar: ${describeLimit(hit)}. Abaixo, o resumo do que foi feito; para continuar, envie outra mensagem nesta conversa.]`;
}

/* --------------------------------- loops --------------------------------- */

/** Identical calls (same arguments, same result) in one turn: warning, correction, stop. */
export const REPEAT_WARN_AT = 3;
export const REPEAT_CORRECT_AT = 5;
export const REPEAT_STOP_AT = 8;
/** Consecutive failures of one tool with the same error, whatever the arguments. */
export const ERROR_WARN_AT = 3;
export const ERROR_CORRECT_AT = 5;
export const ERROR_STOP_AT = 8;
/** Consecutive searches that found nothing, in any tool. Never stops: looking is legitimate. */
export const EMPTY_WARN_AT = 5;
export const EMPTY_CORRECT_AT = 8;

/** JSON with sorted keys: the same arguments in another order are the same call. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A command that only exited with 1 and printed nothing: grep/rg without matches. */
const NO_MATCH_COMMAND = /^Erro ao executar comando \(código de saída 1\)$/;
/** "Nenhuma ocorrência encontrada.", "(nenhum arquivo encontrado)", "Nenhum resultado encontrado na web...". */
const NOTHING_FOUND = /^\(?nenhu(m|ma)\b[^\n]{0,60}\bencontrad[oa]s?\b/i;

/** A result that found nothing. Commands that succeed without output (mkdir, cp) are not this. */
export function isEmptyResult(result: string, isError: boolean): boolean {
  const text = result.trim();
  if (!text || text === "[]" || text === "{}") return true;
  if (isError) return NO_MATCH_COMMAND.test(text);
  return NOTHING_FOUND.test(text);
}

/**
 * What identifies an error, whatever the arguments that caused it: the first sentence of its
 * first line, without numbers ("oldText não encontrado em src/a.ts" stays the same with any
 * oldText, line numbers or exit codes aside).
 */
export function errorSignature(result: string): string {
  const firstLine = result.trim().split("\n")[0] ?? "";
  const sentence = firstLine.split(/\.\s/)[0] ?? firstLine;
  return sentence.replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 200);
}

export interface LoopVerdict {
  /** Appended to the tool result, for the model; empty when nothing looks wrong. */
  notice: string;
  /** Set when the turn should stop (or the user be asked) before the next step. */
  stop?: string;
}

/**
 * Counts, over one turn, what a model stuck in a loop does: the same call with the same result
 * (in any order, so A,B,A,B counts too), the same error from one tool with varied arguments,
 * and searches that keep finding nothing. Each count first warns, then tells the model what
 * to do instead and, for the first two, finally stops the turn. A result that changes is not
 * a loop: running the tests after each edit, or a background task's output growing.
 */
export class LoopGuard {
  private repeats = new Map<string, { digest: string; count: number }>();
  /** Per tool: the last error and how many times in a row. A success of that tool clears it. */
  private errors = new Map<string, { signature: string; count: number }>();
  private empties = 0;

  observe(name: string, args: Record<string, unknown>, result: string, isError: boolean): LoopVerdict {
    const key = `${name}\0${canonicalJson(args)}`;
    const digest = createHash("sha256").update(result).digest("hex");
    const seen = this.repeats.get(key);
    const repeat = seen?.digest === digest ? seen.count + 1 : 1;
    this.repeats.set(key, { digest, count: repeat });

    const empty = isEmptyResult(result, isError);
    this.empties = empty ? this.empties + 1 : 0;

    let sameError = 0;
    if (isError && !empty) {
      const signature = errorSignature(result);
      const last = this.errors.get(name);
      sameError = last?.signature === signature ? last.count + 1 : 1;
      this.errors.set(name, { signature, count: sameError });
    } else if (!isError) {
      this.errors.delete(name);
    }

    // One notice per result: the most serious one.
    if (repeat >= REPEAT_STOP_AT) {
      return { notice: repeatNotice(name, repeat, true), stop: `${name} chamada ${repeat} vezes com os mesmos argumentos e o mesmo resultado` };
    }
    if (sameError >= ERROR_STOP_AT) {
      return { notice: errorNotice(name, sameError, true), stop: `${name} falhou ${sameError} vezes seguidas com o mesmo erro` };
    }
    if (repeat >= REPEAT_WARN_AT && repeat >= sameError) return { notice: repeatNotice(name, repeat, repeat >= REPEAT_CORRECT_AT) };
    if (sameError >= ERROR_WARN_AT) return { notice: errorNotice(name, sameError, sameError >= ERROR_CORRECT_AT) };
    if (this.empties >= EMPTY_WARN_AT) return { notice: emptyNotice(this.empties, this.empties >= EMPTY_CORRECT_AT) };
    return { notice: "" };
  }

  /** The user chose to go on after a loop: counting starts again. */
  reset(): void {
    this.repeats.clear();
    this.errors.clear();
    this.empties = 0;
  }
}

function repeatNotice(name: string, count: number, firm: boolean): string {
  if (!firm) {
    return `\n\n[Aviso: é a ${count}ª vez neste turno que você chama ${name} com os mesmos argumentos e recebe o mesmo resultado. Repetir não muda nada: mude de abordagem ou responda ao usuário com o que já tem.]`;
  }
  return `\n\n[Atenção: é a ${count}ª vez neste turno que você chama ${name} com os mesmos argumentos e recebe o mesmo resultado: isto é um loop. Pare de repetir. Antes da próxima chamada, diga em uma frase por que isso não está avançando e faça algo diferente; se não houver alternativa, responda ao usuário com o que já tem e o que bloqueou.]`;
}

function errorNotice(name: string, count: number, firm: boolean): string {
  if (!firm) {
    return `\n\n[Aviso: ${count} chamadas seguidas de ${name} falharam com o mesmo erro, mesmo com argumentos diferentes. Leia o erro com atenção antes de tentar de novo: variar os detalhes dos argumentos não está resolvendo.]`;
  }
  return `\n\n[Atenção: ${count}ª falha seguida de ${name} com o mesmo erro. Pare de tentar variações: investigue a causa (leia o estado atual do arquivo, confira o caminho, rode um diagnóstico) ou use outra ferramenta. Se não houver saída, responda ao usuário explicando o bloqueio.]`;
}

function emptyNotice(count: number, firm: boolean): string {
  if (!firm) {
    return `\n\n[Aviso: ${count} buscas seguidas sem resultado. Reveja a premissa: o que você procura pode não existir, ter outro nome ou estar em outro lugar. Veja a estrutura (pastas, arquivos) antes de buscar de novo.]`;
  }
  return `\n\n[Atenção: ${count} buscas seguidas sem resultado. Pare de variar a busca: liste a estrutura do projeto e confirme o nome e o lugar do que procura, ou diga ao usuário que não encontrou e o que tentou.]`;
}
