import { select, input, password, editor, confirm } from "@inquirer/prompts";
import { saveConfig, presets, loadConfig, configFile, configDir } from "./config.js";
import type { AppConfig, McpServerConfig, Provider, ReasoningLevel } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

const LABELS: Record<ReasoningLevel, string> = {
  none: "None (no reasoning)",
  low: "Low (fast)",
  medium: "Medium (balanced)",
  high: "High (deep)",
};

function validateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function runSetup(existing: AppConfig | null): Promise<AppConfig> {
  console.clear();
  console.log("\n\x1b[35m SILICONFLOWER \x1b[0m - setup wizard\n");

  const provider = (await select<Provider>({
    message: "API variant (openai / anthropic):",
    default: existing?.provider ?? "openai",
    choices: [
      { name: presets().openai.label, value: "openai" },
      { name: presets().anthropic.label, value: "anthropic" },
    ],
  })) as Provider;

  const preset = presets()[provider];

  const baseURL = await input({
    message: "API base URL:",
    default: existing?.baseURL || preset.baseURL,
    validate: (v) => validateUrl(v) || "URL inválida. Use https://...",
  });

  let apiKey = "";
  if (existing?.apiKey) {
    const keep = await confirm({
      message: `Keep the existing API key (${existing.apiKey.slice(-4).padStart(existing.apiKey.length, "*")})?`,
      default: true,
    });
    if (keep) {
      apiKey = existing.apiKey;
    } else {
      apiKey = await password({ message: "API key:", mask: "*" });
    }
  } else {
    apiKey = await password({ message: "API key:", mask: "*" });
  }

  const model = await input({
    message: "Model ID:",
    default: existing?.model || "",
    validate: (v) => (v.trim() ? true : "Provide a model ID"),
  });

  const reasoning = (await select<ReasoningLevel>({
    message: "Default reasoning level:",
    default: existing?.reasoning ?? "high",
    choices: REASONING_LEVELS.map((l) => ({ name: `${l} - ${LABELS[l]}`, value: l })),
  })) as ReasoningLevel;

  const useSystem = await confirm({
    message: "Define an optional custom system prompt?",
    default: Boolean(existing?.system),
  });
  let system: string | undefined = existing?.system;
  if (useSystem) {
    try {
      if (existing?.system) {
        const reuse = await confirm({ message: "Reuse the existing system prompt?", default: true });
        if (!reuse) system = await editor({ message: "System prompt:", default: existing.system });
      } else {
        system = await editor({ message: "System prompt:" });
      }
    } catch {
      system = await input({
        message: "System prompt (single line):",
        default: existing?.system ?? "",
      });
    }
  }

  const mcpServers: Record<string, McpServerConfig> = { ...(existing?.mcpServers ?? {}) };
  let addMcp = await confirm({
    message: "Add an MCP server now? (you can edit later)",
    default: false,
  });
  while (addMcp) {
    const name = await input({ message: "MCP server name:", validate: (v) => (v.trim() ? true : "required") });
    const command = await input({ message: "Command:", default: "npx", validate: (v) => (v.trim() ? true : "required") });
    const argsRaw = await input({ message: "Arguments (space-separated):", default: "-y @modelcontextprotocol/server-filesystem C:/" });
    mcpServers[name.trim()] = {
      command: command.trim(),
      args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [],
    };
    addMcp = await confirm({ message: "Add another MCP server?", default: false });
  }

  const finalKey = (apiKey || (existing?.apiKey ?? "")).trim();

  const config: AppConfig = {
    provider,
    baseURL: baseURL.trim(),
    apiKey: finalKey.trim(),
    model: model.trim(),
    reasoning,
    system: system?.trim() || undefined,
    mcpServers,
  };

  await saveConfig(config);
  console.log(`\n[OK] Config saved at ${configFile()}`);
  console.log(`      Directory: ${configDir()}\n`);
  return config;
}

export async function ensureConfig(): Promise<AppConfig> {
  const existing = await loadConfig();
  if (existing && existing.apiKey && existing.baseURL && existing.model) {
    return existing;
  }
  return runSetup(existing);
}
