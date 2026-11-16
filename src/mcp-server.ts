import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConversationStore } from "./services/conversations.js";
import { getWorkspaceDataDir } from "./fs-util.js";
import { killProcessTree } from "./shell.js";
import { isWindows } from "./platform.js";
import { log } from "./logger.js";
import { APP_VERSION } from "./version.js";
import { MODES } from "./modes.js";
import { REASONING_LEVELS } from "./types.js";
import type { RunResult } from "./run.js";

/**
 * `siliconflower mcp`: the agent as an MCP server (stdio), for Claude Code and other clients.
 * Each `ask` runs `siliconflower run --json` in its own process, with the project folder as cwd:
 * the session, the tools and the global state (todos, background tasks) assume one folder per
 * process, and a separate process can be cancelled by killing its tree.
 * stdout is the MCP protocol here: nothing else may be written to it (use log()).
 */

export const ASK_TOOL = "ask";
export const LIST_TOOL = "list_conversations";
export const READ_TOOL = "read_conversation";

const MAX_MESSAGE_CHARS = 200_000;
const MAX_ATTACHMENTS = 4;
const STDERR_TAIL_CHARS = 4_000;
const DEFAULT_LIST = 10;
const MAX_LIST = 50;
const DEFAULT_READ = 6;
const MAX_READ = 50;

export const TOOLS = [
  {
    name: ASK_TOOL,
    description:
      "Envia uma tarefa ou pergunta ao siliconflower, um agente de programação com outro modelo (o configurado no siliconflower, como DeepSeek ou Qwen), e espera a resposta final. " +
      "Ele trabalha sozinho na pasta `cwd`: lê e edita arquivos, roda comandos, pesquisa na web e usa as próprias skills e servidores MCP, sem pedir confirmação. " +
      "Use para delegar tarefas, pedir uma segunda opinião ou revisão, ou rodar trabalho em paralelo. Dê contexto completo: ele não vê esta conversa. " +
      "A resposta traz `conversation_id`; passe-o de volta para continuar a mesma conversa (por exemplo, para responder a uma pergunta que ele fez). " +
      "Use `mode: \"plano\"` quando ele só deve analisar, sem alterar nada.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "A tarefa ou pergunta, com todo o contexto necessário." },
        cwd: { type: "string", description: "Pasta do projeto onde ele trabalha (caminho absoluto). Padrão: a pasta em que o servidor MCP foi iniciado." },
        conversation_id: { type: "string", description: "Continua esta conversa salva (veio numa resposta anterior ou em list_conversations)." },
        continue: { type: "boolean", description: "Continua a conversa mais recente do projeto. Ignorado com conversation_id." },
        attachments: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ATTACHMENTS,
          description: `Imagens ou PDFs para anexar (caminhos; relativos a cwd), no máximo ${MAX_ATTACHMENTS}.`,
        },
        mode: { type: "string", enum: [...MODES], description: "programação (padrão do config), sistema, ou plano (só analisa, não altera nada)." },
        model: { type: "string", description: "Outro modelo só para este pedido (id do provedor configurado)." },
        reasoning: { type: "string", enum: [...REASONING_LEVELS], description: "Nível de raciocínio só para este pedido." },
      },
      required: ["message"],
    },
    annotations: { title: "Perguntar ao siliconflower", destructiveHint: true, openWorldHint: true },
  },
  {
    name: LIST_TOOL,
    description: "Lista as conversas salvas do siliconflower num projeto (as mesmas do app), da mais recente para a mais antiga, com o id para continuar uma delas.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Pasta do projeto (caminho absoluto). Padrão: a pasta do servidor MCP." },
        limit: { type: "number", description: `Quantas conversas (padrão ${DEFAULT_LIST}, máximo ${MAX_LIST}).` },
      },
    },
    annotations: { title: "Listar conversas do siliconflower", readOnlyHint: true },
  },
  {
    name: READ_TOOL,
    description: "Mostra as últimas mensagens de uma conversa salva do siliconflower (pedidos e respostas, sem os detalhes das ferramentas).",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "O id da conversa." },
        cwd: { type: "string", description: "Pasta do projeto (caminho absoluto). Padrão: a pasta do servidor MCP." },
        last: { type: "number", description: `Quantas mensagens do fim (padrão ${DEFAULT_READ}, máximo ${MAX_READ}).` },
      },
      required: ["conversation_id"],
    },
    annotations: { title: "Ler conversa do siliconflower", readOnlyHint: true },
  },
] as const;

export interface AskRequest {
  message: string;
  cwd: string;
  conversationId?: string;
  continueLatest?: boolean;
  attachments?: string[];
  mode?: string;
  model?: string;
  reasoning?: string;
}

/** Arguments of `siliconflower run` for a request; the message goes through stdin. */
export function buildRunArgs(req: AskRequest): string[] {
  const args = ["run", "--json"];
  if (req.conversationId) args.push("--resume", req.conversationId);
  else if (req.continueLatest) args.push("--continue");
  if (req.mode) args.push("--mode", req.mode);
  if (req.model) args.push("--model", req.model);
  if (req.reasoning) args.push("--reasoning", req.reasoning);
  // Last: the option takes every value after it.
  if (req.attachments?.length) args.push("--attach", ...req.attachments);
  return args;
}

/** How to start this same program again: the compiled binary, or Bun with the script. */
export function selfCommand(execPath = process.execPath, script = process.argv[1]): string[] {
  // In a compiled binary the script lives in Bun's virtual file system (/$bunfs/, B:\~BUN\).
  if (script && /\.(ts|tsx|js|mjs)$/.test(script) && existsSync(script)) return [execPath, script];
  return [execPath];
}

export class ToolInputError extends Error {}

function str(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${name} deve ser texto.`);
  return value;
}

function count(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/** An existing folder, absolute or relative to the server's own folder. */
export function resolveCwd(value: unknown, base: string): string {
  const raw = str(value, "cwd");
  const dir = raw ? resolve(base, raw) : base;
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch { /* missing */ }
  if (!ok) throw new ToolInputError(`a pasta não existe: ${dir}`);
  return dir;
}

/** Checks and normalizes the arguments of `ask`. Model arguments are not trusted. */
export function parseAsk(args: Record<string, unknown>, base: string): AskRequest {
  const message = str(args.message, "message")?.trim();
  if (!message) throw new ToolInputError("message é obrigatório.");
  if (message.length > MAX_MESSAGE_CHARS) throw new ToolInputError(`message tem ${message.length} caracteres; o limite é ${MAX_MESSAGE_CHARS}.`);
  const cwd = resolveCwd(args.cwd, base);
  const conversationId = str(args.conversation_id, "conversation_id");
  if (conversationId && !/^[A-Za-z0-9_-]{1,100}$/.test(conversationId)) throw new ToolInputError("conversation_id inválido.");
  const mode = str(args.mode, "mode");
  if (mode && !(MODES as readonly string[]).includes(mode)) throw new ToolInputError(`mode deve ser um de: ${MODES.join(", ")}.`);
  const reasoning = str(args.reasoning, "reasoning");
  if (reasoning && !(REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new ToolInputError(`reasoning deve ser um de: ${REASONING_LEVELS.join(", ")}.`);
  }
  const model = str(args.model, "model");
  if (model && (model.startsWith("-") || /\s/.test(model))) throw new ToolInputError("model inválido.");
  let attachments: string[] | undefined;
  if (args.attachments !== undefined && args.attachments !== null) {
    if (!Array.isArray(args.attachments) || args.attachments.some((a) => typeof a !== "string" || !a)) {
      throw new ToolInputError("attachments deve ser uma lista de caminhos.");
    }
    if (args.attachments.length > MAX_ATTACHMENTS) throw new ToolInputError(`no máximo ${MAX_ATTACHMENTS} anexos.`);
    // Absolute, so a name starting with "-" is never read as an option.
    attachments = (args.attachments as string[]).map((a) => resolve(cwd, a));
  }
  return {
    message,
    cwd,
    conversationId,
    continueLatest: args.continue === true,
    attachments,
    mode,
    model,
    reasoning,
  };
}

export interface AskOutcome {
  result: RunResult | null;
  /** What went wrong when there is no result (the process failed before answering). */
  failure?: string;
  cancelled?: boolean;
}

export interface AskDeps {
  command: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Each tool the agent runs, as `run` writes it on stderr. */
  onProgress?: (line: string) => void;
}

/** Runs one `ask` in a child `siliconflower run --json` and reads its JSON line. */
export function runAsk(req: AskRequest, deps: AskDeps): Promise<AskOutcome> {
  return new Promise((done) => {
    if (deps.signal?.aborted) return done({ result: null, cancelled: true });
    const [file, ...prefix] = deps.command;
    const child = spawn(file!, [...prefix, ...buildRunArgs(req)], {
      cwd: req.cwd,
      env: deps.env ?? process.env,
      windowsHide: true,
      // Unix: its own process group, so a cancel also reaches the commands the agent started.
      detached: !isWindows(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let cancelled = false;
    // Resolves when the whole tree is gone, not only the direct child: the caller may exit next.
    let killed: Promise<void> = Promise.resolve();
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("🔨 ")) deps.onProgress?.(line.slice(3).trim());
    });
    const onAbort = () => {
      cancelled = true;
      killed = killProcessTree(child);
    };
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin!.on("error", () => { /* the child may exit before reading everything */ });
    child.stdin!.end(req.message);

    child.on("error", (e) => {
      deps.signal?.removeEventListener("abort", onAbort);
      done({ result: null, failure: `não consegui iniciar o siliconflower: ${e.message}` });
    });
    child.on("close", (code) => {
      deps.signal?.removeEventListener("abort", onAbort);
      if (cancelled) return void killed.then(() => done({ result: null, cancelled: true }));
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        const parsed = JSON.parse(line) as RunResult;
        if (parsed && typeof parsed === "object" && "ok" in parsed) return done({ result: parsed });
      } catch { /* no JSON: failed before the turn (bad config, missing attachment...) */ }
      const reason = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("🔨") && !l.startsWith("✗")).pop();
      done({ result: null, failure: reason?.replace(/^Erro:\s*/, "") || `o siliconflower saiu com código ${code} sem responder` });
    });
  });
}

/** What the client sees: the answer first, then how to continue. */
export function formatAsk(outcome: AskOutcome): CallToolResult {
  if (outcome.cancelled) return { content: [{ type: "text", text: "Cancelado: o siliconflower foi interrompido." }], isError: true };
  const r = outcome.result;
  if (!r) return { content: [{ type: "text", text: `Erro: ${outcome.failure ?? "falha desconhecida"}` }], isError: true };
  const answer = r.ok ? r.text || "(resposta vazia)" : `Erro: ${r.error ?? "falha desconhecida"}${r.text ? `\n\nResposta parcial:\n${r.text}` : ""}`;
  const meta: string[] = [];
  if (r.conversationId) meta.push(`conversation_id: ${r.conversationId}`);
  if (r.tools.length) {
    const names = [...new Set(r.tools.map((t) => t.name))];
    const failed = r.tools.filter((t) => t.isError).length;
    meta.push(`ferramentas: ${r.tools.length} chamada(s) (${names.join(", ")})${failed ? `, ${failed} com erro` : ""}`);
  }
  if (r.tokens) meta.push(`tokens: ${r.tokens}`);
  const content: CallToolResult["content"] = [{ type: "text", text: answer }];
  if (meta.length) content.push({ type: "text", text: `[siliconflower] ${meta.join(" · ")}` });
  return { content, isError: !r.ok };
}

async function listConversations(args: Record<string, unknown>, base: string): Promise<CallToolResult> {
  const cwd = resolveCwd(args.cwd, base);
  const limit = count(args.limit, DEFAULT_LIST, MAX_LIST);
  const store = new ConversationStore(join(getWorkspaceDataDir(cwd), "sessions"));
  const { items, damaged } = await store.list();
  if (!items.length) return { content: [{ type: "text", text: `Nenhuma conversa salva em ${cwd}.` }] };
  const lines = items.slice(0, limit).map((c) => `- ${c.id} · ${c.updatedAt} · ${c.messageCount} mensagens · ${c.title}`);
  if (items.length > limit) lines.push(`(mais ${items.length - limit})`);
  if (damaged) lines.push(`(${damaged} conversa(s) danificada(s) ignorada(s))`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function readConversation(args: Record<string, unknown>, base: string): Promise<CallToolResult> {
  const id = str(args.conversation_id, "conversation_id");
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ToolInputError("conversation_id inválido.");
  const cwd = resolveCwd(args.cwd, base);
  const last = count(args.last, DEFAULT_READ, MAX_READ);
  const store = new ConversationStore(join(getWorkspaceDataDir(cwd), "sessions"));
  let messages: { role: string; content: string }[];
  try {
    messages = (await store.load(id)).messages;
  } catch {
    throw new ToolInputError(`não achei a conversa ${id} em ${cwd}.`);
  }
  const shown = messages.slice(-last);
  const text = shown.map((m) => `### ${m.role === "user" ? "Pedido" : "Resposta"}\n${m.content}`).join("\n\n");
  const skipped = messages.length - shown.length;
  return { content: [{ type: "text", text: `${skipped ? `(${skipped} mensagem(ns) anteriores omitidas)\n\n` : ""}${text || "(conversa vazia)"}` }] };
}

export interface McpServerOptions {
  /** Folder used when a call has no `cwd`. */
  cwd?: string;
  /** How to start `siliconflower run`. */
  command?: string[];
  /** Environment of each run (the CLI overrides travel as SILICONFLOWER_* variables). */
  env?: NodeJS.ProcessEnv;
  /** From the command line of `siliconflower mcp`: used when a call does not choose. */
  defaults?: { mode?: string; reasoning?: string };
}

export function createMcpServer(options: McpServerOptions = {}): Server & { stopRuns?: () => Promise<void> } {
  const base = options.cwd ?? process.cwd();
  const command = options.command ?? selfCommand();
  // Aborted when the client goes away: runs still going must not outlive the server.
  const shutdown = new AbortController();
  const running = new Set<Promise<AskOutcome>>();
  const server: Server & { stopRuns?: () => Promise<void> } = new Server({ name: "siliconflower", version: APP_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case ASK_TOOL: {
          const req = parseAsk(args, base);
          req.mode ??= options.defaults?.mode;
          req.reasoning ??= options.defaults?.reasoning;
          const progressToken = request.params._meta?.progressToken;
          let step = 0;
          await log("info", `MCP server: ask (cwd=${req.cwd}, ${req.message.length} chars)`);
          const run = runAsk(req, {
            command,
            env: options.env,
            signal: AbortSignal.any([extra.signal, shutdown.signal]),
            onProgress: progressToken === undefined
              ? undefined
              : (line) => {
                  step++;
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: step, message: line.slice(0, 200) },
                  }).catch(() => {});
                },
          });
          running.add(run);
          const outcome = await run.finally(() => running.delete(run));
          if (outcome.failure) await log("warn", `MCP server: ask falhou: ${outcome.failure}`);
          return formatAsk(outcome);
        }
        case LIST_TOOL:
          return await listConversations(args, base);
        case READ_TOOL:
          return await readConversation(args, base);
        default:
          return { content: [{ type: "text", text: `Ferramenta desconhecida: ${request.params.name}` }], isError: true };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ToolInputError)) await log("error", `MCP server: ${request.params.name}: ${msg}`);
      return { content: [{ type: "text", text: `Erro: ${msg}` }], isError: true };
    }
  });
  server.stopRuns = async () => {
    shutdown.abort();
    await Promise.allSettled([...running]);
  };
  return server;
}

/** Serves on stdin/stdout until the client closes the connection. */
export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const closed = new Promise<void>((done) => { server.onclose = () => done(); });
  await server.connect(new StdioServerTransport());
  await log("info", `=== siliconflower iniciado como servidor MCP (cwd=${options.cwd ?? process.cwd()}) ===`);
  process.stdin.once("end", () => void server.close());
  // Each run is in its own process group (Unix): a signal to the server does not reach it.
  const signals: NodeJS.Signals[] = isWindows() ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, () => void server.close());
  await closed;
  await server.stopRuns?.();
}
