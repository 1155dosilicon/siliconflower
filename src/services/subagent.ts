import { streamChat } from "../llm";
import { builtinToolsAsMcp, runBuiltin, isBuiltin } from "../tools";
import type { AppConfig, ChatMessage, StreamEvent } from "../types";
import { log } from "../logger";

export type SubagentRole = "general" | "research" | "verification" | "plan";

export interface SubagentOptions {
  config: AppConfig;
  description: string;
  prompt: string;
  role?: SubagentRole;
  runInBackground?: boolean;
}

export interface BackgroundTask {
  id: string;
  description: string;
  role: SubagentRole;
  status: "running" | "completed" | "failed";
  result?: string;
  startedAt: string;
  completedAt?: string;
}

const backgroundTasks = new Map<string, BackgroundTask>();

function getRoleSystemPrompt(role: SubagentRole, description: string): string {
  switch (role) {
    case "research":
      return `Você é um agente de pesquisa e exploração de código de alta velocidade.
Sua missão: investigar a estrutura do código, arquivos, funções e responder perguntas complexas sobre a arquitetura.
Descrição da Tarefa: ${description}
Foco: Forneça relatórios concisos e fundamentados com nomes de arquivos e números de linhas exatos.`;

    case "verification":
      return `Você é um agente de verificação e controle de qualidade rigoroso.
Sua missão: testar, compilar, rodar linters e verificar se as alterações de código satisfazem todos os requisitos sem introduzir regressões.
Descrição da Tarefa: ${description}
Resultado Esperado: Um veredito claro (PASS / FAIL / PARTIAL) acompanhado das evidências e saídas de testes.`;

    case "plan":
      return `Você é um arquiteto de software.
Sua missão: analisar requisitos, identificar arquivos críticos e elaborar um plano de implementação detalhado passo a passo.
Descrição da Tarefa: ${description}`;

    case "general":
    default:
      return `Você é um subagente autônomo do Siliconflower.
Sua missão: executar a tarefa atribuída de forma independente e segura.
Descrição da Tarefa: ${description}
Instrução: Use as ferramentas necessárias e responda com um resumo completo dos resultados obtidos.`;
  }
}

/**
 * Executes a subagent task synchronously or in background.
 */
export async function runSubagentTask(opts: SubagentOptions): Promise<string> {
  const role = opts.role || "general";
  const systemPrompt = getRoleSystemPrompt(role, opts.description);

  if (opts.runInBackground) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const taskRecord: BackgroundTask = {
      id: taskId,
      description: opts.description,
      role,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    backgroundTasks.set(taskId, taskRecord);

    // Execute asynchronously without blocking caller
    runSubagentExecution(opts, systemPrompt)
      .then((res) => {
        taskRecord.status = "completed";
        taskRecord.result = res;
        taskRecord.completedAt = new Date().toISOString();
      })
      .catch((err) => {
        taskRecord.status = "failed";
        taskRecord.result = `Erro: ${err.message || String(err)}`;
        taskRecord.completedAt = new Date().toISOString();
      });

    return `Subagente iniciado em background! [Task ID: ${taskId}] — Descrição: ${opts.description}`;
  }

  return runSubagentExecution(opts, systemPrompt);
}

async function runSubagentExecution(opts: SubagentOptions, systemPrompt: string): Promise<string> {
  const history: ChatMessage[] = [{ role: "user", content: opts.prompt }];

  // Tools available to subagent (exclude recursion on run_task)
  const tools = builtinToolsAsMcp().filter((t) => t.name !== "run_task");

  let accumulatedContent = "";

  try {
    await log("info", `[Subagente iniciado] [${opts.role || "general"}] ${opts.description}`);

    const gen = streamChat({
      config: { ...opts.config, system: systemPrompt },
      messages: history,
      tools,
      reasoning: "none",
      executeTool: async (name, args) => {
        if (isBuiltin(name)) {
          return runBuiltin(name, args, { config: opts.config });
        }
        return { result: `Ferramenta ${name} não disponível no subagente`, isError: true };
      },
    });

    for await (const ev of gen as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") {
        accumulatedContent += ev.text;
      } else if (ev.type === "done") {
        if (ev.content) accumulatedContent = ev.content;
      } else if (ev.type === "error") {
        return `[Erro no subagente: ${ev.message}]`;
      }
    }

    await log("ok", `[Subagente concluído] ${opts.description}`);
    return accumulatedContent || "(Subagente concluiu a tarefa sem retornar saída de texto)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `[Subagente erro] ${msg}`);
    return `[Erro ao executar subagente: ${msg}]`;
  }
}

/**
 * Lists all background subagent tasks.
 */
export function listBackgroundTasks(): BackgroundTask[] {
  return Array.from(backgroundTasks.values());
}

/**
 * Retrieves the status/result of a background task.
 */
export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return backgroundTasks.get(id);
}
