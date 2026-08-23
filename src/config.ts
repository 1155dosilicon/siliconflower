import { join } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import type { AppConfig, McpServerConfig, Mode } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

const CONFIG_DIR = getGlobalDataDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const data = JSON.parse(raw);
    return normalize(data);
  } catch {
    return null;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureDir(CONFIG_DIR);
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function normalize(data: Partial<AppConfig>): AppConfig {
  const apiKey = (process.env.SILICONFLOWER_API_KEY || data.apiKey || "").trim();
  const baseURL = (process.env.SILICONFLOWER_BASE_URL || data.baseURL || "").trim();
  const model = (process.env.SILICONFLOWER_MODEL || data.model || "").trim();
  const reasoning = data.reasoning && REASONING_LEVELS.includes(data.reasoning) ? data.reasoning : "high";
  
  let mode: Mode = "programação";
  if (data.mode) {
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
    system: data.system?.trim() || undefined,
    mcpServers: (data.mcpServers ?? {}) as Record<string, McpServerConfig>,
    hooks: data.hooks ? { ...data.hooks } : undefined,
  };
}

export function isValid(config: AppConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model);
}
