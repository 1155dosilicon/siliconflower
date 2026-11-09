import { ConfigFileError, isValid, loadConfig, loadStoredConfig, normalize, saveConfig } from "../../src/config.js";
import { reasoningLabel, reasoningOptions } from "../../src/reasoning.js";
import type { AppConfig, McpServerConfig, ReasoningLevel } from "../../src/types.js";

const TEST_TIMEOUT_MS = 30_000;
const MAX_FIELD_CHARS: Record<keyof SettingsInput, number> = {
  baseURL: 2_000,
  apiKey: 2_000,
  model: 500,
  reasoning: 20,
  system: 200_000,
  mcp: 200_000,
};
const REASONING_NAMES: Record<string, string> = { off: "desligado", on: "ligado", low: "baixo", med: "médio", high: "alto" };

/** What the page sees. The API key itself never leaves the main process. */
export interface SettingsView {
  baseURL: string;
  model: string;
  reasoning: ReasoningLevel;
  system: string;
  mcp: string;
  /** "***1234", or empty when there is no key. */
  keyHint: string;
  /** Variables that override the saved values while they are set. */
  envOverrides: string[];
  /** config.json exists but cannot be read: the form must not save over it. */
  fileError?: string;
}

/** What the page sends. An empty `apiKey` keeps the saved one. */
export interface SettingsInput {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoning: string;
  system: string;
  mcp: string;
}

export type SettingsErrors = Partial<Record<keyof SettingsInput, string>>;

export function maskKey(key: string): string {
  if (!key) return "";
  // A short key would be almost entirely shown by its last four characters.
  return key.length >= 12 ? `***${key.slice(-4)}` : "***";
}

/** The page is not trusted to send the expected shape. */
export function parseInput(raw: unknown): SettingsInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const result = {} as SettingsInput;
  for (const key of Object.keys(MAX_FIELD_CHARS) as (keyof SettingsInput)[]) {
    const value = input[key] ?? "";
    if (typeof value !== "string" || value.length > MAX_FIELD_CHARS[key]) return null;
    result[key] = value;
  }
  return result;
}

export function parseMcp(text: string): { servers?: Record<string, McpServerConfig>; error?: string } {
  if (!text.trim()) return { servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "O JSON dos servidores MCP é inválido." };
  }
  if (typeof parsed === "object" && parsed !== null && "mcpServers" in parsed) {
    parsed = (parsed as { mcpServers: unknown }).mcpServers; // as most MCP docs show it
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: 'Use um objeto: { "nome": { "command": "npx", "args": ["..."] } } ou { "nome": { "url": "https://..." } }.' };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const server = value as Partial<McpServerConfig> | null;
    const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
    const onlyText = (v: unknown) => typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");
    if (isText(server?.url)) {
      // A remote server, reached by HTTP instead of started here.
      if (!validUrl(server.url)) return { error: `Em "${name}", "url" precisa ser um endereço http:// ou https://.` };
      if (server.headers !== undefined && !onlyText(server.headers)) {
        return { error: `Em "${name}", "headers" precisa ter só valores de texto.` };
      }
      servers[name] = { url: server.url.trim(), ...(server.headers ? { headers: server.headers } : {}) };
      continue;
    }
    if (!isText(server?.command)) {
      return { error: `O servidor MCP "${name}" precisa de um "command" ou de uma "url".` };
    }
    if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((a) => typeof a === "string"))) {
      return { error: `Em "${name}", "args" precisa ser uma lista de textos.` };
    }
    if (server.env !== undefined && !(typeof server.env === "object" && server.env !== null && Object.values(server.env).every((v) => typeof v === "string"))) {
      return { error: `Em "${name}", "env" precisa ter só valores de texto.` };
    }
    servers[name] = { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
  }
  return { servers };
}

function validUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function reasoningChoices(baseURL: string): { value: ReasoningLevel; label: string }[] {
  return reasoningOptions(baseURL).map((value) => {
    const label = reasoningLabel(value, baseURL);
    return { value, label: REASONING_NAMES[label] ?? label };
  });
}

/** The config to save, or what is wrong with the form. Keeps what the form does not show. */
export function applyInput(stored: AppConfig | null, input: SettingsInput): { config?: AppConfig; errors?: SettingsErrors } {
  const errors: SettingsErrors = {};
  const baseURL = input.baseURL.trim();
  const model = input.model.trim();
  const apiKey = input.apiKey.trim() || stored?.apiKey || "";
  if (!validUrl(baseURL)) errors.baseURL = "Use um endereço http:// ou https://.";
  if (!apiKey) errors.apiKey = "Informe a chave de API.";
  if (!model) errors.model = "Informe o modelo.";
  const mcp = parseMcp(input.mcp);
  if (mcp.error) errors.mcp = mcp.error;
  if (Object.keys(errors).length) return { errors };

  const options = reasoningOptions(baseURL);
  const reasoning = options.includes(input.reasoning as ReasoningLevel) ? (input.reasoning as ReasoningLevel) : options.at(-1)!;
  return {
    config: {
      ...normalize({ ...stored, baseURL, apiKey, model, reasoning, system: input.system, mcpServers: mcp.servers }, { applyEnv: false }),
    },
  };
}

/** The stored config, or the reason the file cannot be used (any other error is thrown). */
async function storedConfig(): Promise<{ stored: AppConfig | null; fileError?: string }> {
  try {
    return { stored: await loadStoredConfig() };
  } catch (e) {
    if (e instanceof ConfigFileError) return { stored: null, fileError: e.message };
    throw e;
  }
}

export async function readSettings(env: NodeJS.ProcessEnv = process.env): Promise<SettingsView> {
  // The stored file, never loadConfig: saving must not persist environment overrides.
  const { stored, fileError } = await storedConfig();
  const mcpServers = stored?.mcpServers ?? {};
  return {
    ...(fileError ? { fileError } : {}),
    baseURL: stored?.baseURL ?? "",
    model: stored?.model ?? "",
    reasoning: stored?.reasoning ?? "high",
    system: stored?.system ?? "",
    mcp: Object.keys(mcpServers).length ? JSON.stringify(mcpServers, null, 2) : "",
    keyHint: maskKey(stored?.apiKey ?? ""),
    envOverrides: ["SILICONFLOWER_API_KEY", "SILICONFLOWER_BASE_URL", "SILICONFLOWER_MODEL"].filter((name) => env[name]?.trim()),
  };
}

export async function writeSettings(
  input: SettingsInput
): Promise<{ ok: boolean; changed?: boolean; errors?: SettingsErrors; fileError?: string }> {
  // A damaged file is never replaced: what the form does not show (hooks) would be lost.
  const { stored, fileError } = await storedConfig();
  if (fileError) return { ok: false, fileError };
  const { config, errors } = applyInput(stored, input);
  if (!config) return { ok: false, errors };
  const changed = JSON.stringify(config) !== JSON.stringify(stored);
  if (changed) await saveConfig(config);
  return { ok: true, changed };
}

/** Whether a project can start: the environment may supply what the file lacks. */
export async function isConfigured(): Promise<boolean> {
  // A damaged file opens the settings, which explain what is wrong with it.
  const config = await loadConfig().catch((e) => {
    if (e instanceof ConfigFileError) return null;
    throw e;
  });
  return Boolean(config && isValid(config));
}

/** Provider messages can echo the request: never let the key reach the page. */
function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("***") : text;
}

/** Sends the smallest possible request, so the form tells a typo from a real answer. */
export async function testConnection(input: SettingsInput, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  // Only reads the file (for the saved key): a damaged one just means there is no saved key.
  const { config, errors } = applyInput((await storedConfig()).stored, input);
  if (!config) return { ok: false, message: Object.values(errors ?? {})[0] ?? "Formulário inválido." };

  const url = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const request = (limit: Record<string, number>) => fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "Responda apenas: ok" }], ...limit }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  try {
    let response = await request({ max_tokens: 16 });
    let body = await response.text();
    // Some models accept only the newer name of this parameter.
    if (response.status === 400 && /max_tokens/.test(body)) {
      response = await request({ max_completion_tokens: 16 });
      body = await response.text();
    }
    if (response.ok) return { ok: true, message: `Conexão ok: o modelo ${config.model} respondeu.` };
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? parsed?.message ?? body;
    } catch {
      // not JSON: show it as it came
    }
    return { ok: false, message: scrub(`O provedor respondeu ${response.status}: ${String(detail).slice(0, 400)}`, config.apiKey) };
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "o provedor não respondeu a tempo" : e instanceof Error ? e.message : String(e);
    return { ok: false, message: scrub(`Não consegui conectar: ${reason}`, config.apiKey) };
  }
}
