import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, McpTool } from "./types.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();

  async connectAll(config: Record<string, McpServerConfig> | undefined): Promise<McpTool[]> {
    if (!config) return [];
    const entries = Object.entries(config);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => this.connect(name, cfg))
    );
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const name = entries[i]?.[0] ?? "?";
        process.stderr.write(`\n[MCP] falha ao conectar "${name}": ${String(r.reason)}\n`);
      }
    });
    return this.allTools();
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const rawEnv = { ...process.env, ...(cfg.env ?? {}) };
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (v !== undefined && v !== null) {
        cleanEnv[k] = String(v);
      }
    }
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cleanEnv,
    });
    const client = new Client(
      { name: "siliconflower", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    let toolList: McpTool[] = [];
    try {
      const res = await client.listTools();
      toolList = (res.tools ?? []).map((t) => ({
        server: name,
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    } catch {
      toolList = [];
    }
    this.servers.set(name, { name, client, transport, tools: toolList });
  }

  allTools(): McpTool[] {
    const out: McpTool[] = [];
    const seen = new Map<string, string>();
    for (const s of this.servers.values()) {
      for (const tool of s.tools) {
        const existing = seen.get(tool.name);
        if (existing && existing !== s.name) {
          process.stderr.write(`\n[MCP] Warning: tool "${tool.name}" exists in both "${existing}" and "${s.name}"\n`);
        }
        seen.set(tool.name, s.name);
        out.push(tool);
      }
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    for (const s of this.servers.values()) {
      const tool = s.tools.find((t) => t.name === name);
      if (!tool) continue;
      const res = await s.client.callTool({ name, arguments: args });
      const content = (res.content as unknown[]) ?? [];
      const text = content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
        .join("\n");
      return text || "(empty content)";
    }
    throw new Error(`tool not found: ${name}`);
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
