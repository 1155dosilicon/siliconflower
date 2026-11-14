import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHash } from "node:crypto";
import type { McpServerConfig, McpTool } from "./types.js";
import { APP_VERSION } from "./version.js";
import { log } from "./logger.js";

interface ConnectedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: McpTool[];
  /** The server process ended or the connection dropped: reconnect before the next call. */
  closed: boolean;
}

const MCP_CONNECT_TIMEOUT_MS = 20_000;
const MCP_CALL_TIMEOUT_MS = 120_000;

export interface McpConnectFailure {
  server: string;
  error: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, serverName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms / 1000}s ao conectar ao servidor MCP "${serverName}"`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** How one configured server stands: the tools it listed, or why it did not connect. */
export interface McpServerStatus {
  server: string;
  tools: number;
  error?: string;
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private failures: McpConnectFailure[] = [];
  private configured: string[] = [];

  /**
   * Connects every configured server. Failures never throw: they are logged to the log
   * file and exposed via connectFailures() (in `gui --managed`, stray output would break the protocol with the desktop app).
   */
  async connectAll(config: Record<string, McpServerConfig> | undefined): Promise<McpTool[]> {
    this.failures = [];
    this.configured = Object.keys(config ?? {});
    if (!config) return [];
    const entries = Object.entries(config);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => this.connect(name, cfg))
    );
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        const server = entries[i]?.[0] ?? "?";
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.failures.push({ server, error });
        await log("error", `[MCP] falha ao conectar "${server}": ${error}`);
      }
    }
    return this.allTools();
  }

  connectFailures(): McpConnectFailure[] {
    return [...this.failures];
  }

  /** Every server given to connectAll, in the order of the config, for the diagnosis to show. */
  status(): McpServerStatus[] {
    return this.configured.map((server) => ({
      server,
      tools: this.servers.get(server)?.tools.length ?? 0,
      error: this.failures.find((f) => f.server === server)?.error,
    }));
  }

  private transportFor(name: string, cfg: McpServerConfig): Transport {
    if (typeof cfg.url === "string" && cfg.url.trim()) {
      const url = new URL(cfg.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`"url" do servidor MCP "${name}" precisa ser http:// ou https://`);
      }
      return new StreamableHTTPClientTransport(url, cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined);
    }
    if (typeof cfg.command !== "string" || !cfg.command.trim()) {
      throw new Error(`o servidor MCP "${name}" precisa de "command" (stdio) ou "url" (HTTP)`);
    }
    const rawEnv = { ...process.env, ...(cfg.env ?? {}) };
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (v !== undefined && v !== null) {
        cleanEnv[k] = String(v);
      }
    }

    let resolvedCommand = cfg.command;
    if (typeof Bun !== "undefined" && typeof (Bun as any).which === "function") {
      const found = (Bun as any).which(resolvedCommand);
      if (found) {
        resolvedCommand = found;
      } else if (resolvedCommand === "npx" && (Bun as any).which("bunx")) {
        resolvedCommand = (Bun as any).which("bunx")!;
      }
    }

    return new StdioClientTransport({
      command: resolvedCommand,
      args: cfg.args ?? [],
      env: cleanEnv,
    });
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const transport = this.transportFor(name, cfg);
    const client = new Client(
      { name: "siliconflower", version: APP_VERSION },
      { capabilities: {} }
    );
    try {
      await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, name);
    } catch (err) {
      // client.connect() already spawned the child process; if the handshake fails
      // or times out, close the transport so we don't leak an orphan process.
      await transport.close().catch(() => {});
      throw err;
    }
    let toolList: McpTool[] = [];
    try {
      const res = await client.listTools();
      toolList = (res.tools ?? []).map((t) => ({
        server: name,
        name: qualifyMcpToolName(name, t.name),
        originalName: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    } catch (err) {
      // The server stays connected, but with no tool to offer: say why in the log.
      await log("warn", `[MCP] "${name}" conectou mas nao listou ferramentas: ${err instanceof Error ? err.message : String(err)}`);
      toolList = [];
    }
    const server: ConnectedServer = { name, config: cfg, client, transport, tools: toolList, closed: false };
    client.onclose = () => {
      server.closed = true;
      void log("warn", `[MCP] conexao com "${name}" encerrada`);
    };
    this.servers.set(name, server);
  }

  /**
   * A server that died is started again before the next call. The call itself is never
   * repeated: it may have had an effect before the connection dropped.
   */
  private async reconnect(server: ConnectedServer): Promise<ConnectedServer> {
    await log("info", `[MCP] reconectando "${server.name}"`);
    await server.transport.close().catch(() => {});
    const previousTools = server.tools;
    await this.connect(server.name, server.config);
    const fresh = this.servers.get(server.name)!;
    // The schemas the model already has stay valid even if the list could not be read again.
    if (!fresh.tools.length) fresh.tools = previousTools;
    return fresh;
  }

  /** The tool a name from the model refers to, also without the hash suffix (resolveMcpToolName). */
  resolveTool(name: string): McpTool | undefined {
    const tool = resolveMcpToolName(name, [...this.servers.values()].flatMap((s) => s.tools));
    if (tool && tool.name !== name) void log("info", `[MCP] "${name}" sem o sufixo de hash; usando "${tool.name}"`);
    return tool;
  }

  allTools(): McpTool[] {
    const out: McpTool[] = [];
    const seen = new Set<string>();
    for (const s of this.servers.values()) {
      for (const tool of s.tools) {
        if (seen.has(tool.name)) {
          void log("warn", `[MCP] ferramenta qualificada duplicada ignorada: "${tool.name}"`);
          continue;
        }
        seen.add(tool.name);
        out.push(tool);
      }
    }
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ result: string; isError: boolean }> {
    const tool = this.resolveTool(name);
    const known = tool && this.servers.get(tool.server);
    if (!tool || !known) throw new Error(toolNotFoundMessage(name, this.allTools().map((t) => t.name)));
    const s = known.closed ? await this.reconnect(known) : known;
    const res = await s.client.callTool(
      { name: tool.originalName ?? tool.name, arguments: args },
      undefined,
      { signal, timeout: MCP_CALL_TIMEOUT_MS }
    );
    const text = mcpContentText((res.content as unknown[]) ?? []);
    // MCP servers report tool failures in-band via `isError`, not by rejecting the call.
    return { result: text || "(empty content)", isError: res.isError === true };
  }

  serverCount(): number {
    return this.servers.size;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()].map(async (s) => {
        try {
          await s.transport.close();
        } catch {
          /* ignore */
        }
      })
    );
    this.servers.clear();
  }
}

const MEDIA_NAMES: Record<string, string> = { image: "imagem", audio: "áudio" };

/**
 * The text the model gets from a tool's content blocks. Images and audio arrive in Base64:
 * as text they are only noise that fills the context (a screenshot is megabytes).
 */
export function mcpContentText(content: unknown[]): string {
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return String(c);
      const block = c as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; resource?: { uri?: unknown; text?: unknown; mimeType?: unknown } };
      if ("text" in block) return String(block.text);
      if (block.type === "resource" && block.resource) {
        if (typeof block.resource.text === "string") return block.resource.text;
        return `[recurso ${String(block.resource.uri ?? "")} omitido: conteúdo binário (${String(block.resource.mimeType ?? "tipo desconhecido")})]`;
      }
      if (typeof block.data === "string") {
        const kind = MEDIA_NAMES[String(block.type)] ?? String(block.type ?? "conteúdo");
        return `[${kind} omitido(a) (${String(block.mimeType ?? "tipo desconhecido")}, ${block.data.length} caracteres em Base64): o modelo não recebe esse conteúdo]`;
      }
      return JSON.stringify(c);
    })
    .join("\n");
}

const HASH_SUFFIX = /_[0-9a-f]{8}$/;
const withoutHash = (name: string) => name.replace(HASH_SUFFIX, "");

/**
 * The MCP tool a name from the model refers to. Models sometimes leave out the hash suffix of
 * qualifyMcpToolName ("mcp_brave_brave_web_search"), mostly far from the tool list: when only
 * one tool has that name before the suffix, it is the one meant.
 */
export function resolveMcpToolName(name: string, tools: McpTool[]): McpTool | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const matches = tools.filter((t) => withoutHash(t.name) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

const MAX_SUGGESTIONS = 3;

/** The answer to a call of an unknown tool: the right names, so the next call gets it right. */
export function toolNotFoundMessage(name: string, names: string[]): string {
  const ambiguous = names.filter((n) => withoutHash(n) === name);
  if (ambiguous.length > 1) {
    return `Ferramenta não encontrada: ${name}. Mais de uma ferramenta tem esse nome; chame uma destas, com o nome exato: ${ambiguous.join(", ")}.`;
  }
  // The bare name of an MCP tool ("brave_web_search") is the end of its qualified name.
  const distance = (n: string) => (withoutHash(n).endsWith(`_${name}`) ? 0 : editDistance(name, withoutHash(n)));
  const similar = names
    .map((n) => ({ n, d: distance(n) }))
    .filter(({ d }) => d <= Math.max(2, Math.floor(name.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ n }) => n);
  return similar.length
    ? `Ferramenta não encontrada: ${name}. Nomes parecidos: ${similar.join(", ")}. Chame com o nome exato, como aparece na lista de ferramentas.`
    : `Ferramenta não encontrada: ${name}. Use um dos nomes da lista de ferramentas.`;
}

export function qualifyMcpToolName(server: string, tool: string): string {
  const slug = (value: string, max: number) =>
    value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "unnamed";
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `mcp_${slug(server, 14)}_${slug(tool, 30)}_${hash}`;
}
