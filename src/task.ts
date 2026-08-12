import { streamChat } from "./llm.js";
import { builtinToolsAsMcp, runBuiltin, isBuiltin } from "./tools.js";
import type { AppConfig, ChatMessage, StreamEvent } from "./types.js";
import { log } from "./logger.js";

export interface TaskOptions {
  config: AppConfig;
  description: string;
  prompt: string;
}

export async function runSubagentTask(opts: TaskOptions): Promise<string> {
  const subagentSystem = `Você é um subagente especializado em executar tarefas autonômas de exploração, análise ou execução de código. 
Tarefa: ${opts.description}
Instrução: execute o trabalho usando as ferramentas disponíveis e responda com um resumo claro, direto e objetivo dos resultados obtidos.`;

  const history: ChatMessage[] = [
    { role: "user", content: opts.prompt },
  ];

  const tools = builtinToolsAsMcp().filter((t) => t.name !== "run_task");

  let accumulatedContent = "";

  try {
    await log("info", `[Subagente iniciado] ${opts.description}`);

    const gen = streamChat({
      config: { ...opts.config, system: subagentSystem },
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
