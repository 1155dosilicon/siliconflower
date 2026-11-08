import { streamChat } from "../llm.js";
import { buildSubagentPrompt } from "../modes.js";
import { builtinToolsAsMcp, runBuiltin, isBuiltin } from "../tools.js";
import { SKILL_TOOL, loadSkills, readSkillContent } from "../skills.js";
import { hasReadOnlyUse, isToolAllowedInMode } from "../tool-policy.js";
import type { AppConfig, ChatMessage, McpTool, StreamEvent } from "../types.js";
import { registerBackgroundTask, settleBackgroundTask } from "./background-tasks.js";
import { buildMemorySystemPrompt } from "./memory.js";
import { log } from "../logger.js";

export type SubagentRole = "general" | "research" | "verification" | "plan" | "coder" | "custom";

export interface SubagentOptions {
  config: AppConfig;
  description: string;
  prompt: string;
  role?: SubagentRole;
  customPrompt?: string;
  runInBackground?: boolean;
  signal?: AbortSignal;
}

export interface SubagentSession {
  id: string;
  description: string;
  role: SubagentRole;
  history: ChatMessage[];
  createdAt: string;
  customPrompt?: string;
  /** A run in progress: a second one at the same time would mix up the history. */
  running?: boolean;
}

/**
 * Never offered to a subagent: run_task and send_subagent_message would let it start more
 * agents (recursion), and the checklist of todowrite is the user's, shown by the interface.
 */
const MAIN_AGENT_ONLY = new Set(["run_task", "send_subagent_message", "todowrite"]);

const activeSubagentSessions = new Map<string, SubagentSession>();

// Sessions (with their full message history) are never removed otherwise, so a long-lived
// session spawning many subagents would grow this map's memory usage without bound.
const MAX_SUBAGENT_SESSIONS = 200;

function pruneOldSessions(): void {
  const excess = activeSubagentSessions.size - MAX_SUBAGENT_SESSIONS;
  if (excess <= 0) return;
  // Map preserves insertion order, so the oldest sessions are evicted first.
  for (const id of [...activeSubagentSessions.keys()].slice(0, excess)) {
    activeSubagentSessions.delete(id);
  }
}

/** These roles only investigate: they get the same read-only policy as the "plano" mode. */
const READ_ONLY_ROLES = new Set<SubagentRole>(["research", "plan"]);

function getRolePrompt(role: SubagentRole, description: string, customPrompt?: string): string {
  if (role === "custom" && customPrompt) {
    return `${customPrompt}\n\nTarefa: ${description}`;
  }

  switch (role) {
    case "research":
      return `Você é um subagente de pesquisa, com ferramentas somente de leitura. Investigue código, arquivos e arquitetura para responder ao pedido.
Tarefa: ${description}
Resposta final: relatório conciso e fundamentado, com nomes de arquivos e números de linha exatos.`;

    case "verification":
      return `Você é um subagente de verificação. Teste, compile, rode linters e confira se as alterações cumprem os requisitos sem causar regressões. Não corrija o código: apenas relate.
Tarefa: ${description}
Resposta final: veredito PASS, FAIL ou PARTIAL, com as evidências e as saídas dos testes.`;

    case "plan":
      return `Você é um subagente arquiteto de software, com ferramentas somente de leitura. Analise os requisitos e elabore um plano de implementação.
Tarefa: ${description}
Resposta final: plano passo a passo, com os arquivos críticos e os riscos.`;

    case "coder":
      return `Você é um subagente de implementação. Implemente funcionalidades e correções seguindo o padrão do repositório e rode os testes relevantes.
Tarefa: ${description}
Resposta final: arquivos alterados, o que foi verificado e o que ficou pendente.`;

    case "general":
    default:
      return `Você é um subagente autônomo do siliconflower. Execute a tarefa de forma independente e segura.
Tarefa: ${description}
Resposta final: resumo completo dos resultados obtidos.`;
  }
}

/** Rebuilt on every run, so a follow-up message sees the current instructions and memories. */
export async function buildSubagentSystemPrompt(
  role: SubagentRole,
  description: string,
  customPrompt: string | undefined,
  userSystem: string | undefined
): Promise<string> {
  const [skills, memoryPrompt] = await Promise.all([
    loadSkills().catch(() => []),
    buildMemorySystemPrompt(process.cwd()).catch(() => ""),
  ]);
  return buildSubagentPrompt(getRolePrompt(role, description, customPrompt), userSystem, skills, memoryPrompt);
}

export function isSubagentToolAllowed(role: SubagentRole, name: string, args: Record<string, unknown> = {}): boolean {
  return !READ_ONLY_ROLES.has(role) || isToolAllowedInMode("plano", name, args);
}

/** Tools offered to a subagent: never MAIN_AGENT_ONLY, and read-only roles lose the rest. */
export function subagentTools(role: SubagentRole): McpTool[] {
  const tools: McpTool[] = [
    ...builtinToolsAsMcp().filter((t) => !MAIN_AGENT_ONLY.has(t.name)),
    {
      server: "skill",
      name: SKILL_TOOL.name,
      description: SKILL_TOOL.description,
      inputSchema: SKILL_TOOL.inputSchema,
    },
  ];
  return READ_ONLY_ROLES.has(role) ? tools.filter((t) => hasReadOnlyUse(t.name)) : tools;
}

/**
 * Executes or spawns a subagent task.
 */
export async function runSubagentTask(opts: SubagentOptions): Promise<string> {
  const role = opts.role || "general";
  const systemPrompt = await buildSubagentSystemPrompt(role, opts.description, opts.customPrompt, opts.config.system);
  const sessionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const session: SubagentSession = {
    id: sessionId,
    description: opts.description,
    role,
    history: [{ role: "user", content: opts.prompt }],
    createdAt: new Date().toISOString(),
    customPrompt: opts.customPrompt,
  };

  activeSubagentSessions.set(sessionId, session);
  pruneOldSessions();

  if (opts.runInBackground) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    registerBackgroundTask({
      id: sessionId,
      type: "subagent",
      description: opts.description,
      role,
      status: "running",
      startedAt: new Date().toISOString(),
      cancel: () => controller.abort(),
    });

    // Execute asynchronously without blocking caller
    runSubagentExecution({ ...opts, signal: controller.signal }, systemPrompt, session)
      .then((res) => {
        settleBackgroundTask(sessionId, "completed", res);
      })
      .catch((err) => {
        settleBackgroundTask(sessionId, "failed", `Erro: ${err.message || String(err)}`);
      })
      .finally(() => opts.signal?.removeEventListener("abort", onParentAbort));

    return `Subagente iniciado em background! [ID do Subagente: ${sessionId}] — Descrição: ${opts.description}`;
  }

  return runSubagentExecution(opts, systemPrompt, session);
}

/**
 * Sends a follow-up message to an existing subagent session.
 */
export async function sendSubagentMessage(
  sessionId: string,
  message: string,
  config: AppConfig,
  signal?: AbortSignal
): Promise<{ result: string; isError: boolean }> {
  const session = activeSubagentSessions.get(sessionId);
  if (!session) {
    return { result: `Sessão de subagente '${sessionId}' não encontrada.`, isError: true };
  }
  if (session.running) {
    return {
      result: `O subagente '${sessionId}' ainda está trabalhando. Espere ele terminar (manage_background_task com action='status') antes de mandar outra mensagem.`,
      isError: true,
    };
  }

  session.history.push({ role: "user", content: message });

  try {
    const systemPrompt = await buildSubagentSystemPrompt(session.role, session.description, session.customPrompt, config.system);
    const res = await runSubagentExecution(
      {
        config,
        description: session.description,
        prompt: message,
        role: session.role,
        customPrompt: session.customPrompt,
        signal,
      },
      systemPrompt,
      session
    );
    return { result: res, isError: false };
  } catch (err) {
    return { result: `Erro ao executar subagente: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function runSubagentExecution(opts: SubagentOptions, systemPrompt: string, session: SubagentSession): Promise<string> {
  const role = session.role;
  const tools = subagentTools(role);
  // Models sometimes call a tool they were not offered (e.g. one named in a prompt).
  const offered = new Set(tools.map((t) => t.name));

  let accumulatedContent = "";
  let turnMessages: ChatMessage[] = [];
  // Finished tool steps: kept if the run fails, so a follow-up knows what already happened.
  const steps: ChatMessage[] = [];
  session.running = true;

  try {
    await log("info", `[Subagente iniciado] [${opts.role || "general"}] ${opts.description}`);

    const gen = streamChat({
      config: { ...opts.config, system: systemPrompt },
      messages: session.history,
      tools,
      reasoning: "none",
      signal: opts.signal,
      executeTool: async (name, args) => {
        if (!offered.has(name)) {
          return { result: `Ferramenta ${name} não disponível no subagente`, isError: true };
        }
        // Actions such as memory "save" stay in the schema list, so the check is needed here too.
        if (!isSubagentToolAllowed(role, name, args)) {
          return { result: `Subagente "${role}" é somente leitura: ${name} bloqueada com esses argumentos.`, isError: true };
        }
        if (name === SKILL_TOOL.name) {
          try {
            const content = await readSkillContent(String(args.name ?? ""));
            return { result: content, isError: false };
          } catch (e) {
            return { result: String(e), isError: true };
          }
        }
        if (isBuiltin(name)) {
          // Propagate cancellation so Ctrl+C / kill also stops the subagent's commands.
          return runBuiltin(name, args, { config: opts.config, signal: opts.signal });
        }
        return { result: `Ferramenta ${name} não disponível no subagente`, isError: true };
      },
    });

    for await (const ev of gen as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") {
        accumulatedContent += ev.text;
      } else if (ev.type === "step") {
        steps.push(...ev.messages);
      } else if (ev.type === "done") {
        if (ev.content) accumulatedContent = ev.content;
        turnMessages = ev.messages ?? [];
      } else if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }

    // Keep the tool calls/results so follow-ups via send_subagent_message have full context,
    // and always close the turn with an assistant message (no two consecutive user messages).
    session.history.push(...turnMessages);
    const last = session.history[session.history.length - 1];
    if (!last || last.role !== "assistant" || last.toolCalls?.length) {
      session.history.push({ role: "assistant", content: accumulatedContent || "(sem saída de texto)" });
    }

    await log("ok", `[Subagente concluído] ${opts.description}`);
    return accumulatedContent || "(Subagente concluiu a tarefa sem retornar saída de texto)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `[Subagente erro] ${msg}`);
    session.history.push(...steps, { role: "assistant", content: `[Erro: ${msg}]` });
    throw err;
  } finally {
    session.running = false;
  }
}

export function getSubagentSession(id: string): SubagentSession | undefined {
  return activeSubagentSessions.get(id);
}
