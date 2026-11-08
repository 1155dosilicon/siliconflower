import { join } from "node:path";
import { chmod, readFile, realpath, rename, rm, stat, writeFile, access } from "node:fs/promises";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import { isWindows } from "./platform.js";
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
    mcpServers: (data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
      ? data.mcpServers
      : {}) as Record<string, McpServerConfig>,
    hooks: stringValues(data.hooks),
  };
}

export function isValid(config: AppConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model);
}
