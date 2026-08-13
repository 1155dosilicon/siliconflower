import { readFile, writeFile, readdir, mkdir, stat, rename, rm, access } from "node:fs/promises";
import { resolve, isAbsolute, dirname } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { search } from "./glob-util.js";
import { searchContent } from "./grep.js";
import { setTodos } from "./todo.js";
import { runSubagentTask, listBackgroundTasks } from "./services/subagent.js";
import { smartEditFile } from "./services/smart-edit.js";
import { generateRepoMap, findSymbolInRepo } from "./services/repomap.js";
import { saveMemory, recallMemories, forgetMemory } from "./services/memory.js";
import { enterWorktree, exitWorktree, listWorktrees } from "./services/worktree.js";
import { runHook } from "./core/hooks.js";
import { processToolOutput } from "./context.js";
import { tailLogs } from "./logger.js";
import type { AppConfig, McpTool, TodoItem } from "./types.js";
import { log } from "./logger.js";

const execAsync = promisify(exec);

export interface ToolContext {
  config?: AppConfig;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive?: boolean;
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<{ result: string; isError: boolean }>;
}

function toAbs(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
}

const BLOCKED_PATHS = [
  "c:\\windows\\system32",
  "c:\\windows\\syswow64",
  "/etc",
  "/root",
  "/boot",
];

function isPathBlocked(p: string): boolean {
  const normalized = p.toLowerCase().replace(/\\/g, "/");
  for (const blocked of BLOCKED_PATHS) {
    if (normalized.startsWith(blocked.toLowerCase().replace(/\\/g, "/"))) return true;
  }
  if (normalized.includes("/.ssh/") || normalized.endsWith("/.ssh")) return true;
  if (normalized.includes("/.aws/") || normalized.endsWith("/.aws")) return true;
  return false;
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: "read_file",
    description:
      "Lê o conteúdo de um arquivo de texto. Suporta os parâmetros opcionais 'offset' (linha inicial, base 1) e 'limit' (máximo de linhas a ler, padrão 2000). Retorna as linhas numeradas.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho do arquivo" },
        offset: { type: "number", description: "Linha inicial (base 1)" },
        limit: { type: "number", description: "Quantidade máxima de linhas" },
      },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        const raw = await readFile(path, "utf8");
        const lines = raw.split(/\r?\n/);
        const rawOffset = Number(a.offset);
        const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 1;
        const rawLimit = Number(a.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 2000;

        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const formatted = slice.map((line, idx) => `${offset + idx}: ${line}`).join("\n");
        const processed = await processToolOutput(formatted);
        return { result: processed, isError: false };
      } catch (e) {
        return { result: `Erro ao ler ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "grep_content",
    description:
      "Busca por conteúdo textual/regex dentro de arquivos de um diretório recursivamente. Retorna arquivo, número da linha e conteúdo da linha correspondente.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório base (padrão: diretório atual)" },
        pattern: { type: "string", description: "Padrão de busca (texto ou regex)" },
        include: { type: "string", description: "Filtro de arquivos por extensão/glob (ex: '*.ts' ou 'src/**/*.tsx')" },
      },
      required: ["pattern"],
    },
    run: async (a) => {
      const basePath = toAbs(String(a.path ?? "."));
      const pattern = String(a.pattern);
      const include = a.include ? String(a.include) : undefined;

      try {
        const matches = await searchContent({ basePath, pattern, includePattern: include });
        if (matches.length === 0) {
          return { result: "Nenhuma ocorrência encontrada.", isError: false };
        }
        const output = matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join("\n");
        const processed = await processToolOutput(output);
        return { result: processed, isError: false };
      } catch (e) {
        return { result: `Erro na busca por conteúdo: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "write_file",
    description:
      "Cria ou sobrescreve um arquivo de texto. Cria diretórios pai se necessário. CUIDADO: sobrescreve arquivos existentes sem aviso.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Conteúdo completo do arquivo" },
      },
      required: ["path", "content"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, String(a.content ?? ""), "utf8");
        await log("info", `write_file: ${path} (${String(a.content ?? "").length} bytes)`);
        return { result: `Arquivo escrito: ${path} (${String(a.content ?? "").length} bytes)`, isError: false };
      } catch (e) {
        return { result: `Erro ao escrever ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "edit_file",
    description:
      "Edita um arquivo substituindo a primeira ocorrência de oldText por newText. Use replaceAll=true para substituir todas.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Texto exato a localizar" },
        newText: { type: "string", description: "Texto substituto" },
        replaceAll: { type: "boolean", default: false },
      },
      required: ["path", "oldText", "newText"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      const res = await smartEditFile({
        path,
        oldText: String(a.oldText ?? ""),
        newText: String(a.newText ?? ""),
        replaceAll: Boolean(a.replaceAll),
      });
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "apply_patch",
    description:
      "Aplica múltiplos blocos de substituição de texto (oldText/newText) em um arquivo de forma atômica.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "changes"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      const changes = (a.changes as { oldText: string; newText: string }[]) ?? [];
      if (!Array.isArray(changes) || changes.length === 0) {
        return { result: "Nenhuma alteração fornecida.", isError: true };
      }

      try {
        let content = await readFile(path, "utf8");
        for (let i = 0; i < changes.length; i++) {
          const { oldText, newText } = changes[i];
          const oldTextStr = String(oldText ?? "");
          if (!oldTextStr) {
            return { result: `Erro no bloco ${i + 1}: oldText não pode ser vazio`, isError: true };
          }
          if (!content.includes(oldTextStr)) {
            return { result: `Erro no bloco ${i + 1}: oldText não encontrado em ${path}`, isError: true };
          }
          const idx = content.indexOf(oldTextStr);
          const newTextStr = String(newText ?? "");
          content = content.slice(0, idx) + newTextStr + content.slice(idx + oldTextStr.length);
        }
        await writeFile(path, content, "utf8");
        await log("info", `apply_patch: ${path} (${changes.length} alterações)`);
        return { result: `Patch aplicado com sucesso em ${path} (${changes.length} alterações).`, isError: false };
      } catch (e) {
        return { result: `Erro ao aplicar patch em ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "todowrite",
    description:
      "Cria e atualiza a lista de tarefas da sessão atual. Use para planejar e acompanhar o progresso de tarefas complexas de múltiplos passos.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Descrição da tarefa" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["content", "status", "priority"],
          },
        },
      },
      required: ["todos"],
    },
    run: async (a) => {
      const rawTodos = (a.todos as { content: string; status: any; priority: any }[]) ?? [];
      const formatted: TodoItem[] = rawTodos.map((t, i) => {
        let status: TodoItem["status"] = "pending";
        const st = String(t.status ?? "").toLowerCase();
        if (["completed", "done", "finished"].includes(st)) status = "completed";
        else if (["in_progress", "in-progress", "doing"].includes(st)) status = "in_progress";
        else if (["cancelled", "canceled"].includes(st)) status = "cancelled";
        else if (st === "pending" || st === "todo") status = "pending";

        let priority: TodoItem["priority"] = "medium";
        const pr = String(t.priority ?? "").toLowerCase();
        if (["high", "medium", "low"].includes(pr)) priority = pr as TodoItem["priority"];

        return {
          id: `todo_${i + 1}`,
          content: String(t.content ?? ""),
          status,
          priority,
        };
      });
      setTodos(formatted);
      return { result: `Lista de To-Dos atualizada (${formatted.length} itens).`, isError: false };
    },
  },
  {
    name: "run_task",
    description:
      "Lança um subagente autônomo para executar tarefas complexas, pesquisas ou verificações em paralelo ou em background.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Resumo curto (3-5 palavras) da tarefa" },
        prompt: { type: "string", description: "Instruções completas para o subagente" },
        role: {
          type: "string",
          enum: ["general", "research", "verification", "plan"],
          description: "Especialidade do subagente: general | research | verification | plan",
        },
        runInBackground: { type: "boolean", description: "Executar em background sem bloquear o agente principal" },
      },
      required: ["description", "prompt"],
    },
    run: async (a, ctx) => {
      if (!ctx?.config) {
        return { result: "Configuração indisponível para executar subagente.", isError: true };
      }
      const desc = String(a.description);
      const prompt = String(a.prompt);
      const role = (a.role as any) || "general";
      const runInBackground = Boolean(a.runInBackground);
      const result = await runSubagentTask({
        config: ctx.config,
        description: desc,
        prompt,
        role,
        runInBackground,
      });
      return { result, isError: false };
    },
  },
  {
    name: "list_background_tasks",
    description: "Lista todas as tarefas de subagentes executando ou concluídas em background.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: async () => {
      const tasks = listBackgroundTasks();
      if (tasks.length === 0) return { result: "Nenhuma tarefa em background.", isError: false };
      return { result: JSON.stringify(tasks, null, 2), isError: false };
    },
  },
  {
    name: "repo_map",
    description:
      "Gera um mapa estrutural do repositório exibindo arquivos relevantes e suas assinaturas de funções, classes e tipos.",
    inputSchema: {
      type: "object",
      properties: {
        focusPath: { type: "string", description: "Subdiretório para focar a geração do mapa" },
        maxFiles: { type: "number", description: "Limite máximo de arquivos no mapa (padrão: 50)" },
      },
    },
    run: async (a) => {
      const focusPath = a.focusPath ? String(a.focusPath) : undefined;
      const maxFiles = a.maxFiles ? Number(a.maxFiles) : 50;
      const res = await generateRepoMap(process.cwd(), { focusPath, maxFiles });
      return { result: res.mapText, isError: false };
    },
  },
  {
    name: "find_symbol",
    description: "Busca um símbolo (função, classe, interface ou variável) através de todo o código do repositório.",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: { type: "string", description: "Nome do símbolo a buscar" },
      },
      required: ["symbolName"],
    },
    run: async (a) => {
      const name = String(a.symbolName);
      const matches = await findSymbolInRepo(name, process.cwd());
      if (matches.length === 0) {
        return { result: `Nenhum símbolo encontrado para '${name}'.`, isError: false };
      }
      return { result: JSON.stringify(matches, null, 2), isError: false };
    },
  },
  {
    name: "save_memory",
    description:
      "Salva uma memória persistente (regra de projeto, preferência do usuário ou instrução) que será lembrada em sessões futuras.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Identificador curto da memória" },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Tipo de memória",
        },
        description: { type: "string", description: "Descrição em uma linha do objetivo da memória" },
        content: { type: "string", description: "Conteúdo detalhado da regra ou aprendizado" },
        scope: {
          type: "string",
          enum: ["project", "global"],
          default: "project",
          description: "Escopo: 'project' (apenas neste repositório) ou 'global' (para todos os projetos)",
        },
      },
      required: ["name", "type", "description", "content"],
    },
    run: async (a) => {
      const res = await saveMemory({
        name: String(a.name),
        type: a.type as any,
        description: String(a.description),
        content: String(a.content),
        scope: (a.scope as any) || "project",
      });
      return { result: res.message, isError: false };
    },
  },
  {
    name: "recall_memory",
    description: "Consulta memórias persistentes salvas sobre o usuário ou sobre o projeto.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Termo de busca opcional para filtrar memórias" },
      },
    },
    run: async (a) => {
      const query = a.query ? String(a.query) : undefined;
      const mems = await recallMemories(query, process.cwd());
      if (mems.length === 0) {
        return { result: "Nenhuma memória encontrada.", isError: false };
      }
      return { result: JSON.stringify(mems, null, 2), isError: false };
    },
  },
  {
    name: "forget_memory",
    description: "Remove uma memória persistente antiga ou desatualizada.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome da memória a remover" },
      },
      required: ["name"],
    },
    run: async (a) => {
      const res = await forgetMemory(String(a.name), process.cwd());
      return { result: res.message, isError: res.isError };
    },
  },
  {
    name: "enter_worktree",
    description: "Cria e ativa um Git Worktree temporário e isolado para alterações e testes seguros.",
    inputSchema: {
      type: "object",
      properties: {
        branchName: { type: "string", description: "Nome da nova branch de trabalho isolado" },
      },
      required: ["branchName"],
    },
    run: async (a) => {
      const res = await enterWorktree(String(a.branchName), process.cwd());
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "exit_worktree",
    description: "Remove um Git Worktree temporário.",
    inputSchema: {
      type: "object",
      properties: {
        worktreePath: { type: "string", description: "Caminho do worktree a remover" },
        force: { type: "boolean", description: "Forçar remoção mesmo se houver alterações não salvas" },
      },
      required: ["worktreePath"],
    },
    run: async (a) => {
      const res = await exitWorktree(String(a.worktreePath), Boolean(a.force), process.cwd());
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "list_worktrees",
    description: "Lista todos os Git Worktrees ativos no repositório.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: async () => {
      const trees = await listWorktrees(process.cwd());
      if (trees.length === 0) {
        return { result: "Nenhum worktree ativo encontrado.", isError: false };
      }
      return { result: JSON.stringify(trees, null, 2), isError: false };
    },
  },
  {
    name: "ask_question",
    description:
      "Faz uma pergunta direta ao usuário com opções ou campo aberto para esclarecer dúvidas ou decisões durante a execução.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Pergunta para o usuário" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Opções de escolha sugeridas (opcional)",
        },
      },
      required: ["question"],
    },
    run: async (a) => {
      const q = String(a.question);
      const opts = Array.isArray(a.options) ? a.options.map(String) : undefined;
      const optsStr = opts && opts.length ? ` [Opções: ${opts.join(" | ")}]` : "";
      return { result: `[PERGUNTA AO USUÁRIO]: ${q}${optsStr}`, isError: false };
    },
  },
  {
    name: "read_logs",
    description:
      "Lê as últimas linhas do log do agente. Permite filtrar por nível de log ('error', 'warn', 'info', 'tool') ou termo de busca para diagnosticar problemas rapidamente.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", description: "Número de linhas a retornar (padrão: 50, máx: 200)" },
        level: { type: "string", description: "Filtro de nível: error | warn | info | tool" },
        search: { type: "string", description: "Termo de busca/filtro nos logs" },
      },
    },
    run: async (a) => {
      const rawLines = Number(a.lines);
      const lines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(Math.floor(rawLines), 200) : 50;
      const level = a.level ? String(a.level) : undefined;
      const search = a.search ? String(a.search) : undefined;

      const logs = await tailLogs({ lines, level, search });
      return { result: logs, isError: false };
    },
  },
  {
    name: "list_directory",
    description: "Lista arquivos e pastas de um diretório.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Diretório (padrão: cwd)" } },
      required: [],
    },
    run: async (a) => {
      const path = toAbs(String(a.path ?? "."));
      try {
        const entries = await readdir(path, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE] "}${e.name}`).sort();
        return { result: lines.length ? lines.join("\n") : "(diretório vazio)", isError: false };
      } catch (e) {
        return { result: `Erro ao listar ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "create_directory",
    description: "Cria um diretório (e subdiretórios) se não existir.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        await mkdir(path, { recursive: true });
        return { result: `Diretório criado/confirmado: ${path}`, isError: false };
      } catch (e) {
        return { result: `Erro ao criar diretório ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "move_path",
    description: "Move ou renomeia um arquivo/diretório.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    },
    run: async (a) => {
      const src = toAbs(String(a.source));
      const dst = toAbs(String(a.destination));
      if (isPathBlocked(src) || isPathBlocked(dst)) return { result: `Acesso bloqueado`, isError: true };
      try {
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
        await log("info", `move_path: ${src} -> ${dst}`);
        return { result: `Movido: ${src} -> ${dst}`, isError: false };
      } catch (e) {
        return { result: `Erro ao mover: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "file_info",
    description: "Retorna metadados de um arquivo/diretório (tamanho, datas, tipo).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      try {
        const s = await stat(path);
        return {
          result: JSON.stringify(
            {
              path,
              type: s.isDirectory() ? "directory" : "file",
              size: s.size,
              created: s.birthtime.toISOString(),
              modified: s.mtime.toISOString(),
            },
            null,
            2
          ),
          isError: false,
        };
      } catch (e) {
        return { result: `Erro: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "search_files",
    description: "Busca arquivos por padrão glob (ex: '**/*.ts', '**/*.{ts,tsx}'). Retorna caminhos absolutos.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório base da busca" },
        pattern: { type: "string", description: "Padrão glob, ex: **/*.md" },
        includeHidden: { type: "boolean", default: false, description: "Incluir arquivos e diretórios ocultos (começados com .)" },
      },
      required: ["path", "pattern"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      const includeHidden = Boolean(a.includeHidden);
      try {
        const matches = await search(path, String(a.pattern), includeHidden);
        return { result: matches.length ? matches.slice(0, 200).join("\n") : "(nenhum arquivo encontrado)", isError: false };
      } catch (e) {
        return { result: `Erro na busca: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "delete_path",
    description:
      "DESTRUTIVO: exclui um arquivo ou diretório. Use recursive=true para diretórios não vazios. Requer confirm=true para qualquer exclusão. Confirme a necessidade antes de usar.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", default: false, description: "Necessário para diretórios não vazios" },
        confirm: { type: "boolean", default: false, description: "Obrigatório para confirmar exclusão" },
      },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (isPathBlocked(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      const recursive = Boolean(a.recursive);
      const confirm = Boolean(a.confirm);
      if (!confirm) {
        return {
          result: "Operação destrutiva requer confirmação. Rechame com confirm=true após confirmar com o usuário.",
          isError: true,
        };
      }
      try {
        await access(path);
      } catch {
        return { result: `Caminho não existe: ${path}`, isError: true };
      }
      try {
        await log("warn", `delete_path: ${path} (recursive=${recursive})`);
        await rm(path, { recursive, force: false });
        return { result: `Excluído: ${path}`, isError: false };
      } catch (e) {
        return { result: `Erro ao excluir ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "execute_command",
    description:
      "Executa um comando de sistema no terminal (PowerShell no Windows / Bash no Linux/macOS). Retorna a saída padrão (stdout) e erros (stderr). Use para consultar estado do sistema ou rodar ferramentas CLI.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Comando PowerShell/Bash a ser executado" },
        cwd: { type: "string", description: "Diretório de execução (padrão: diretório atual)" },
        timeout: { type: "number", description: "Tempo limite em ms (padrão: 30000ms)" },
      },
      required: ["command"],
    },
    run: async (a) => {
      const cmd = String(a.command ?? "").trim();
      if (!cmd) return { result: "Nenhum comando fornecido.", isError: true };
      const workDir = a.cwd ? toAbs(String(a.cwd)) : process.cwd();
      const rawTimeout = Number(a.timeout);
      const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 120000) : 30000;
      const isWin = process.platform === "win32";
      const execOptions = {
        cwd: workDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: isWin ? "powershell.exe" : (process.env.SHELL || "/bin/bash"),
        windowsHide: true,
      };
      try {
        await log("info", `execute_command: ${cmd} (cwd=${workDir})`);
        const { stdout, stderr } = await execAsync(cmd, execOptions);
        let output = "";
        if (stdout.trim()) output += stdout.trim();
        if (stderr.trim()) output += (output ? "\n--- STDERR ---\n" : "") + stderr.trim();
        if (!output) output = "(comando executado com sucesso sem saída de texto)";
        const processed = await processToolOutput(output);
        return { result: processed, isError: false };
      } catch (e: any) {
        const stdout = e.stdout ? String(e.stdout).trim() : "";
        const stderr = e.stderr ? String(e.stderr).trim() : "";
        let errMsg = `Erro ao executar comando (${e.code ?? e.signal ?? "erro"}): ${e.message || String(e)}`;
        if (stdout) errMsg += `\n--- STDOUT ---\n${stdout}`;
        if (stderr) errMsg += `\n--- STDERR ---\n${stderr}`;
        const processed = await processToolOutput(errMsg);
        return { result: processed, isError: true };
      }
    },
  },
];

export function builtinToolsAsMcp(): McpTool[] {
  return BUILTIN_TOOLS.map((t) => ({
    server: "builtin",
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function isBuiltin(name: string): boolean {
  return BUILTIN_TOOLS.some((t) => t.name === name);
}

export async function runBuiltin(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext
): Promise<{ result: string; isError: boolean }> {
  const tool = BUILTIN_TOOLS.find((t) => t.name === name);
  if (!tool) return { result: `ferramenta nativa desconhecida: ${name}`, isError: true };

  // Pre-tool hook
  if (ctx?.config?.hooks) {
    await runHook("preTool", ctx.config.hooks);
  }

  const rawTimeout = Number(args?.timeout);
  const toolTimeoutArg = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout + 5000 : 60000;
  const TOOL_TIMEOUT_MS = Math.max(60000, toolTimeoutArg);
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<{ result: string; isError: boolean }>((resolve) => {
    timer = setTimeout(
      () => resolve({ result: `Tempo limite excedido na execução da ferramenta: ${name}`, isError: true }),
      TOOL_TIMEOUT_MS
    );
  });
  try {
    const res = await Promise.race([tool.run(args, ctx), timeoutPromise]);

    // On-edit and Post-tool hooks
    if (ctx?.config?.hooks) {
      if (name === "edit_file" || name === "write_file") {
        await runHook("onEdit", ctx.config.hooks);
      }
      await runHook("postTool", ctx.config.hooks);
    }

    return res;
  } finally {
    clearTimeout(timer!);
  }
}
