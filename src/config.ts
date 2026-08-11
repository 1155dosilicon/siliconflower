import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import type { AppConfig, McpServerConfig, Mode, Provider, ReasoningLevel } from "./types.js";

const CONFIG_DIR = join(homedir(), ".siliconflower");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configDir(): string {
  return CONFIG_DIR;
}

export function configFile(): string {
  return CONFIG_FILE;
}

const PRESETS: Record<Provider, { label: string; baseURL: string; example: string }> = {
  openai: {
    label: "OpenAI-compatible (SiliconFlow, OpenRouter, OpenAI, ...)",
    baseURL: "https://api.siliconflow.com/v1",
    example: "deepseek-ai/DeepSeek-V4-Pro or gpt-5.5",
  },
  anthropic: {
    label: "Anthropic-compatible (Anthropic, proxies)",
    baseURL: "https://api.anthropic.com",
    example: "claude-5-sonnet or claude-opus-4.8",
  },
};

export function presets() {
  return PRESETS;
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
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function normalize(data: Partial<AppConfig>): AppConfig {
  const provider: Provider = data.provider === "anthropic" ? "anthropic" : "openai";
  const apiKey = (process.env.SILICONFLOWER_API_KEY || data.apiKey || "").trim();
  const baseURL = (process.env.SILICONFLOWER_BASE_URL || data.baseURL || "").trim();
  const model = (process.env.SILICONFLOWER_MODEL || data.model || "").trim();
  return {
    provider,
    baseURL,
    apiKey,
    model,
    reasoning: (data.reasoning as ReasoningLevel) ?? "high",
    mode: (data.mode as Mode) ?? "programação",
    system: data.system?.trim() || undefined,
    mcpServers: (data.mcpServers ?? {}) as Record<string, McpServerConfig>,
  };
}

export function isValid(config: AppConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model);
}
