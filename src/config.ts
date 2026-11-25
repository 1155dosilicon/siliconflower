import { join } from "node:path";
import { chmod, readFile, realpath, rename, rm, stat, writeFile, access } from "node:fs/promises";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import { isWindows } from "./platform.js";
import { contextBudget } from "./context.js";
import { DEFAULT_WEIGHTS, type TokenWeights } from "./turn-limits.js";
import type { AppConfig, McpServerConfig, Mode } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

const CONFIG_DIR = getGlobalDataDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// It holds the API key: only the owner may read it. Has no effect on Windows.
const CONFIG_MODE = 0o600;

export function configDir(): string {
  return CONFIG_DIR;
}

export function configFile(): string {
  return CONFIG_FILE;
}

const DEFAULT_PRESET: { label: string; baseURL: string; example: string } = {
  label: "OpenAI-compatible (SiliconFlow, OpenRouter, OpenAI, ...)",
  baseURL: "https://api.siliconflow.com/v1",
  example: "deepseek-ai/DeepSeek-V4-Pro or gpt-5.5",
};

export function defaultPreset() {
  return DEFAULT_PRESET;
}

export async function configExists(): Promise<boolean> {
  try {
    await access(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective runtime config: config.json with SILICONFLOWER_API_KEY / _BASE_URL / _MODEL
 * applied on top. Never pass the result to saveConfig (it would persist the env values).
 */
export async function loadConfig(): Promise<AppConfig | null> {
  return readConfigFile(true);
}

/** config.json exactly as stored (no environment overrides); use it for editing/saving. */
export async function loadStoredConfig(): Promise<AppConfig | null> {
  return readConfigFile(false);
}

/**
 * config.json exists but cannot be used. Never treated as a missing file: the wizard or the
 * settings form would then save a new one over it, losing what only the file had (hooks, MCP).
 */
export class ConfigFileError extends Error {
  constructor(detail: string) {
    super(`O arquivo de configuração ${CONFIG_FILE} ${detail}. Ele não foi alterado: corrija-o num editor de texto, ou apague-o para configurar do zero.`);
    this.name = "ConfigFileError";
  }
}

/** Null only when the file does not exist; throws ConfigFileError when it cannot be used. */
async function readConfigFile(applyEnv: boolean): Promise<AppConfig | null> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigFileError(`não pôde ser lido (${e instanceof Error ? e.message : String(e)})`);
  }
  await restrictConfigAccess();
  let data: unknown;
  try {
    // Notepad and other Windows editors may save UTF-8 with a BOM.
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new ConfigFileError(`não é um JSON válido (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigFileError("precisa conter um objeto JSON ({ ... })");
  }
  return normalize(data as Partial<AppConfig>, { applyEnv });
}

/** Fixes files saved by older versions. May fail on a read-only target (Nix store): that is fine. */
async function restrictConfigAccess(): Promise<void> {
  if (isWindows()) return;
  try {
    if (((await stat(CONFIG_FILE)).mode & 0o077) !== 0) await chmod(CONFIG_FILE, CONFIG_MODE);
  } catch {
    // The config still works; there is nothing more to do from here.
  }
}

/** Applies the SILICONFLOWER_* environment overrides to an already normalized config. */
export function applyEnvOverrides(config: AppConfig): AppConfig {
  return {
    ...config,
    apiKey: process.env.SILICONFLOWER_API_KEY?.trim() || config.apiKey,
    baseURL: process.env.SILICONFLOWER_BASE_URL?.trim() || config.baseURL,
    model: process.env.SILICONFLOWER_MODEL?.trim() || config.model,
  };
}

/** Shorter values are not treated as secrets: replacing them would garble ordinary output. */
const MIN_SECRET_LENGTH = 8;
/** MCP `env` entries whose value is a secret (the others are paths, flags, ...). */
const SECRET_ENV_NAME = /key|token|secret|pass|auth|cookie|credential/i;

/** The API key and the MCP keys and headers of a config, as written. */
export function configSecrets(config: AppConfig): string[] {
  const out = [config.apiKey];
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const [name, value] of Object.entries(server.env ?? {})) if (SECRET_ENV_NAME.test(name)) out.push(value);
    for (const value of Object.values(server.headers ?? {})) out.push(value);
  }
  return out;
}

/**
 * Every secret siliconflower knows: those of the running config, SILICONFLOWER_API_KEY and those
 * stored in config.json (they differ when the environment overrides the file). Tool results pass
 * through redactKnownSecrets with them, so `cat ~/.siliconflower/config.json` reaches the model
 * without the key.
 */
export async function knownSecrets(config: AppConfig): Promise<string[]> {
  const found = [...configSecrets(config), process.env.SILICONFLOWER_API_KEY ?? ""];
  try {
    const stored = await loadStoredConfig();
    if (stored) found.push(...configSecrets(stored));
  } catch {
    // A damaged config.json: the running config was already counted.
  }
  const unique = new Set(found.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length >= MIN_SECRET_LENGTH));
  // Longest first, so a secret that contains another is replaced whole.
  return [...unique].sort((a, b) => b.length - a.length);
}

/** Replaces each occurrence of the given secrets with `***`. */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("***");
  return out;
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureDir(CONFIG_DIR);
  // Atomic: a crash in the middle of a save must not cost the user the API key.
  // rename() replaces the path itself, so resolve links (dotfile managers, Nix/Home Manager).
  const target = await realpath(CONFIG_FILE).catch(() => CONFIG_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: CONFIG_MODE });
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

/** A hand-edited file may have any type in any field: a wrong one must not stop the app. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function stringValues(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Tool steps of one turn before asking whether to go on (`askAfterSteps`): a loop stops there. */
export const DEFAULT_ASK_AFTER_STEPS = 150;
const MAX_ASK_AFTER_STEPS = 100_000;
/**
 * Tokens of one turn (every request summed: each step sends the history again) before asking
 * (`askAfterTokens`). A loop of 140 steps once spent 5.6M. What is counted is the cost of the
 * turn, not the raw sum: input counts at `PREFILL_WEIGHT` (see `turn-limits.ts`), so the limit
 * does not move with the size of the context.
 */
export const DEFAULT_ASK_AFTER_TOKENS = 8_000_000;
const MAX_ASK_AFTER_TOKENS = 1_000_000_000;
/** Minutes of one turn before asking (`askAfterMinutes`); checked between steps. */
export const DEFAULT_ASK_AFTER_MINUTES = 60;
const MAX_ASK_AFTER_MINUTES = 24 * 60;

/**
 * How the tokens of a request weigh against `askAfterTokens` (`tokenWeights`), when the defaults
 * of `turn-limits.ts` do not match what the provider charges. `1` and `1` count the raw sum.
 */
export function tokenWeights(value: unknown): TokenWeights {
  const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const ratio = (raw: unknown, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && raw !== null && raw !== "" && Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : fallback;
  };
  return { prefill: ratio(data.prefill, DEFAULT_WEIGHTS.prefill), cacheHit: ratio(data.cacheHit, DEFAULT_WEIGHTS.cacheHit) };
}

/** A whole number from 0 to `max`; the default when absent or not a number. */
function boundedCount(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n)
    ? Math.min(max, Math.max(0, Math.floor(n)))
    : fallback;
}

/** `askAfterSteps` of config.json, bounded; 0 never asks; the default when absent or not a number. */
export function askAfterSteps(value: unknown): number {
  return boundedCount(value, DEFAULT_ASK_AFTER_STEPS, MAX_ASK_AFTER_STEPS);
}

/** `askAfterTokens` of config.json, bounded; 0 never asks. */
export function askAfterTokens(value: unknown): number {
  return boundedCount(value, DEFAULT_ASK_AFTER_TOKENS, MAX_ASK_AFTER_TOKENS);
}

/** `askAfterMinutes` of config.json, bounded; 0 never asks. */
export function askAfterMinutes(value: unknown): number {
  return boundedCount(value, DEFAULT_ASK_AFTER_MINUTES, MAX_ASK_AFTER_MINUTES);
}

export function normalize(data: Partial<AppConfig>, opts: { applyEnv?: boolean } = {}): AppConfig {
  const applyEnv = opts.applyEnv ?? true;
  const env = (name: string) => (applyEnv ? process.env[name]?.trim() : undefined);
  const apiKey = (env("SILICONFLOWER_API_KEY") || text(data.apiKey)).trim();
  const baseURL = (env("SILICONFLOWER_BASE_URL") || text(data.baseURL)).trim();
  const model = (env("SILICONFLOWER_MODEL") || text(data.model)).trim();
  const reasoning = data.reasoning && REASONING_LEVELS.includes(data.reasoning) ? data.reasoning : "high";

  let mode: Mode = "programação";
  if (typeof data.mode === "string") {
    const rawMode = data.mode.toLowerCase().trim();
    if (rawMode === "programacao" || rawMode === "programação" || rawMode === "prog") {
      mode = "programação";
    } else if (rawMode === "sistema" || rawMode === "sys") {
      mode = "sistema";
    } else if (rawMode === "plano" || rawMode === "plan") {
      mode = "plano";
    }
  }

  // A legacy "provider" key may still sit in config.json; it is dropped on the next save.
  return {
    baseURL,
    apiKey,
    model,
    reasoning,
    mode,
    system: text(data.system).trim() || undefined,
    ...(data.contextTokens !== undefined && Number.isFinite(Number(data.contextTokens))
      ? { contextTokens: contextBudget(data.contextTokens, model) }
      : {}),
    ...(data.askAfterSteps !== undefined && Number.isFinite(Number(data.askAfterSteps))
      ? { askAfterSteps: askAfterSteps(data.askAfterSteps) }
      : {}),
    ...(data.askAfterTokens !== undefined && Number.isFinite(Number(data.askAfterTokens))
      ? { askAfterTokens: askAfterTokens(data.askAfterTokens) }
      : {}),
    ...(data.askAfterMinutes !== undefined && Number.isFinite(Number(data.askAfterMinutes))
      ? { askAfterMinutes: askAfterMinutes(data.askAfterMinutes) }
      : {}),
    ...(data.tokenWeights !== undefined ? { tokenWeights: tokenWeights(data.tokenWeights) } : {}),
    mcpServers: (data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
      ? data.mcpServers
      : {}) as Record<string, McpServerConfig>,
    hooks: stringValues(data.hooks),
  };
}

export function isValid(config: AppConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model);
}
