import { streamChat } from "./llm.js";
import { McpManager } from "./mcp.js";
import { builtinToolsAsMcp, isBuiltin, runBuiltin } from "./tools.js";
import { loadSkills, readSkillContent, SKILL_TOOL, type Skill } from "./skills.js";
import { buildSystemPrompt, nextMode, type Mode } from "./modes.js";
import { buildMemorySystemPrompt } from "./services/memory.js";
import { onTodosChange } from "./todo.js";
import { estimateTokens, estimateMessagesTokens } from "./context.js";
import { log } from "./logger.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent, TodoItem } from "./types.js";
import { isToolAllowedInMode } from "./tool-policy.js";
import { runHook } from "./core/hooks.js";
import { reasoningLabel, reasoningOptions } from "./reasoning.js";
import { findProject, type ProjectInfo } from "./project.js";

export interface SessionOverrides {
  model?: string;
  reasoning?: ReasoningLevel;
  mode?: Mode;
}

export interface UIMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

export interface SessionQuestion {
  question: string;
  options?: string[];
}

/** Everything a front end needs to draw the session. Replaced (never mutated) on each change. */
export interface SessionState {
  model: string;
  reasoning: ReasoningLevel;
  mode: Mode;
  messages: UIMessage[];
  streaming: boolean;
  liveText: string;
  status: string;
  error: string | null;
  question: SessionQuestion | null;
  todos: TodoItem[];
  project: ProjectInfo | null;
  skillCount: number;
  toolCount: number;
  apiTokens: number;
  /** System prompt + API history + live text. Front ends may add what is being typed. */
  estimatedTokens: number;
}

export interface SessionDeps {
  /** Replaceable in tests, so turns can run without a provider. */
  stream?: typeof streamChat;
}

const STATUS_FLASH_MS = 1200;

/**
 * One agent conversation, independent of any UI: API history, tool dispatch, cancellation
 * and ask_question. Front ends (TUI, web) render `getState()` and call the action methods.
 */
export class AgentSession {
  readonly config: AppConfig;
  private readonly stream: typeof streamChat;
  private state: SessionState;
  private readonly stateListeners = new Set<(state: SessionState) => void>();
  private readonly streamListeners = new Set<(event: StreamEvent) => void>();

  // Full API conversation (including tool calls and tool results), separate from the
  // rendered UI messages, so the model keeps the context of what its tools did.
  private history: ChatMessage[] = [];
  private mcp: McpManager | null = null;
  private skills: Skill[] = [];
  private memoryPrompt = "";
  private abort: AbortController | null = null;
  private pending: { resolve: (answer: string) => void; reject: (err: Error) => void; options?: string[] } | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeTodos: (() => void) | undefined;
  private started = false;
  private closed = false;

  constructor(config: AppConfig, overrides: SessionOverrides = {}, deps: SessionDeps = {}) {
    this.config = config;
    this.stream = deps.stream ?? streamChat;
    const mode = overrides.mode ?? config.mode ?? "programação";
    this.state = {
      model: overrides.model ?? config.model,
      reasoning: overrides.reasoning ?? config.reasoning,
      mode,
      messages: [],
      streaming: false,
      liveText: "",
      status: "pronto",
      error: null,
      question: null,
      todos: [],
      project: findProject(process.cwd()),
      skillCount: 0,
      toolCount: builtinToolsAsMcp().length + 1,
      apiTokens: 0,
      estimatedTokens: 0,
    };
    this.state.estimatedTokens = this.estimateTokens(this.state);
  }

  getState(): SessionState {
    return this.state;
  }

  /** Called after every state change. Returns the unsubscribe function. */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Raw stream events of the current turn (thinking, tool calls and results, usage...). */
  onStreamEvent(listener: (event: StreamEvent) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  /** Loads skills and memory, runs the session hook and connects the MCP servers. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribeTodos = onTodosChange((updated) => this.patch({ todos: [...updated] }));
    const mcp = new McpManager();
    this.mcp = mcp;

    const loaded = await loadSkills();
    if (this.closed) return;
    this.skills = loaded;
    this.patch({ skillCount: loaded.length });
    this.memoryPrompt = await buildMemorySystemPrompt(process.cwd()).catch(() => "");
    this.patch({});
    await log("info", `siliconflower iniciado - model=${this.state.model}`);
    if (this.config.hooks) {
      await runHook("onSessionStart", this.config.hooks, { cwd: process.cwd() });
    }
    this.patch({ status: "conectando MCP..." });
    try {
      const tools = await mcp.connectAll(this.config.mcpServers);
      if (this.closed) return;
      this.patch({ toolCount: builtinToolsAsMcp().length + 1 + tools.length });
      await log("ok", `MCP conectado: ${mcp.serverCount()} servidores, ${tools.length} ferramentas`);
      const failures = mcp.connectFailures();
      if (failures.length) {
        this.patch({
          error: `MCP: falha ao conectar ${failures.map((f) => f.server).join(", ")} (detalhes em siliconflower logs)`,
          status: `pronto (${failures.length} servidor(es) MCP com falha)`,
        });
      } else {
        this.patch({ status: "pronto" });
      }
    } catch (e) {
      await log("error", `MCP indisponivel: ${String(e)}`);
      this.patch({ status: "MCP indisponivel" });
    }
  }

  /** Aborts the running turn, runs the session hook and disconnects the MCP servers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearStatusTimer();
    this.unsubscribeTodos?.();
    this.abort?.abort();
    const pendingWork: Promise<unknown>[] = [];
    if (this.config.hooks) pendingWork.push(runHook("onSessionEnd", this.config.hooks, { cwd: process.cwd() }));
    if (this.mcp) pendingWork.push(this.mcp.close());
    await Promise.allSettled(pendingWork);
  }

  /** Cancels the running turn. Returns false when there was nothing to cancel. */
  cancel(): boolean {
    if (!this.state.streaming) return false;
    this.abort?.abort();
    this.patch({ status: "cancelado" });
    return true;
  }

  setMode(mode: Mode): void {
    if (this.state.streaming || mode === this.state.mode) return;
    this.patch({ mode });
    this.flashStatus(`mode: ${mode}`);
  }

  cycleMode(): void {
    this.setMode(nextMode(this.state.mode));
  }

  /** Levels not offered by the current provider are ignored. */
  setReasoning(level: ReasoningLevel): void {
    if (this.state.streaming || level === this.state.reasoning) return;
    if (!reasoningOptions(this.config.baseURL).includes(level)) return;
    this.patch({ reasoning: level });
    this.flashStatus(`pensamento: ${reasoningLabel(level, this.config.baseURL)}`);
  }

  cycleReasoning(): void {
    const levels = reasoningOptions(this.config.baseURL);
    const idx = levels.indexOf(this.state.reasoning);
    this.setReasoning(levels[(idx + 1) % levels.length]);
  }

  /** Answers the pending ask_question. Returns false when the answer was not accepted. */
  answer(raw: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const text = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (!text) return false;
    // A bare number selects the corresponding option.
    const n = Number(text);
    const answer = pending.options && Number.isInteger(n) && n >= 1 && n <= pending.options.length
      ? pending.options[n - 1]
      : text;
    pending.resolve(answer);
    return true;
  }

  /** Runs one full turn. Ignored while another turn is running or after close(). */
  async send(text: string): Promise<void> {
    // Line breaks and tabs are content (the web front end has a multi-line input).
    const cleanText = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "").trim();
    if (!cleanText || this.state.streaming || this.closed) return;
    this.clearStatusTimer();
    this.patch({
      error: null,
      messages: [...this.state.messages, { role: "user", content: cleanText }],
      streaming: true,
      liveText: "",
      status: "pensando...",
    });

    // Pass the full API history (including tool calls/results from earlier turns) so the
    // model keeps that context; compressHistory in llm.ts applies the token budget.
    const userMsg: ChatMessage = { role: "user", content: cleanText };
    const messages: ChatMessage[] = [...this.history, userMsg];
    const controller = new AbortController();
    this.abort = controller;

    let accText = "";
    let accThinking = "";
    let hadError = false;
    let assistantMsgAdded = false;
    // Commits this turn to the API history exactly once.
    const commitTurn = (turnMessages: ChatMessage[]) => {
      this.history = [...this.history, userMsg, ...turnMessages];
    };

    try {
      this.memoryPrompt = await buildMemorySystemPrompt(process.cwd());
      // The marker file may have been created mid-session (e.g. by the agent itself).
      this.patch({ project: findProject(process.cwd()) });
      const systemPrompt = buildSystemPrompt(this.state.mode, this.config.system, this.skills, this.memoryPrompt);
      const gen = this.stream({
        config: { ...this.config, system: systemPrompt, model: this.state.model },
        messages,
        tools: this.allTools(),
        reasoning: this.state.reasoning,
        signal: controller.signal,
        executeTool: (name, args) => this.executeTool(name, args),
      });

      for await (const ev of gen as AsyncIterable<StreamEvent>) {
        for (const listener of this.streamListeners) listener(ev);
        switch (ev.type) {
          case "thinking":
            accThinking += ev.text;
            this.patch({ status: "🧠 pensando..." });
            break;
          case "text":
            accText += ev.text;
            this.patch({ liveText: accText });
            break;
          case "tool_call":
            this.patch({ status: `🔨 ${ev.name}...` });
            break;
          case "tool_result":
            this.patch({ status: "processando..." });
            break;
          case "usage":
            if (ev.totalTokens) this.patch({ apiTokens: ev.totalTokens });
            break;
          case "error":
            hadError = true;
            this.patch({ error: ev.message });
            await log("error", `Stream error: ${ev.message}`);
            if (!assistantMsgAdded) {
              assistantMsgAdded = true;
              const partial = accText.trim();
              const shown = partial ? `${partial}\n\n[Erro: ${ev.message}]` : `[Erro: ${ev.message}]`;
              this.patch({ messages: [...this.state.messages, { role: "assistant", content: shown }] });
              commitTurn([{ role: "assistant", content: shown }]);
            }
            break;
          case "done": {
            const final = ev.content?.trim() || accText.trim();
            const finalThinking = ev.reasoning?.trim() || accThinking.trim();
            if (final) {
              this.patch({
                messages: [...this.state.messages, { role: "assistant", content: final, reasoning: finalThinking || undefined }],
              });
            }
            assistantMsgAdded = true;
            commitTurn(ev.messages ?? (final ? [{ role: "assistant", content: final }] : []));
            break;
          }
        }
      }
      this.patch({ status: hadError ? "erro" : "pronto" });
    } catch (e) {
      hadError = true;
      const isAbort = (e instanceof Error && e.name === "AbortError") || /abort/i.test(String(e));
      const errMsg = isAbort ? "Operação cancelada pelo usuário" : (e instanceof Error ? e.message : String(e));
      if (!isAbort) {
        await log("error", `Stream failed: ${errMsg}`);
        this.patch({ error: errMsg, status: "erro" });
      } else {
        this.patch({ status: "cancelado" });
      }
      if (!assistantMsgAdded) {
        assistantMsgAdded = true;
        const shown = accText || `[${errMsg}]`;
        this.patch({
          messages: [...this.state.messages, { role: "assistant", content: shown, reasoning: accThinking || undefined }],
        });
        // Partial tool calls of an interrupted turn are not kept (they could be left
        // without their results); the visible text is enough context for the next turn.
        commitTurn([{ role: "assistant", content: isAbort && accText ? `${accText}\n\n[interrompido pelo usuário]` : shown }]);
      }
    } finally {
      this.pending?.reject(new Error("operação encerrada"));
      this.pending = null;
      this.abort = null;
      this.patch({ question: null, streaming: false, liveText: "" });
    }
  }

  private allTools(): McpTool[] {
    const list: McpTool[] = [...builtinToolsAsMcp()];
    list.push({ server: "skill", name: SKILL_TOOL.name, description: SKILL_TOOL.description, inputSchema: SKILL_TOOL.inputSchema });
    if (this.mcp) list.push(...this.mcp.allTools());
    return list;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }> {
    const { mode, model } = this.state;
    if (!isToolAllowedInMode(mode, name, args)) {
      return {
        result: `[MODO PLANO ATIVO] Execução de ${name} bloqueada. Apresente o plano ao usuário e peça para alternar para o modo 'programação' (Ctrl+O no terminal ou o seletor Modo na interface gráfica) para aplicar as alterações.`,
        isError: true,
      };
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
      return runBuiltin(name, args, {
        // Carry CLI overrides (e.g. --model) so subagents use the same model.
        config: { ...this.config, model },
        mode,
        signal: this.abort?.signal,
        askUser: (q, options, signal) => this.askUser(q, options, signal),
      });
    }
    if (this.mcp) {
      try {
        return await this.mcp.callTool(name, args, this.abort?.signal);
      } catch (e) {
        return { result: String(e), isError: true };
      }
    }
    return { result: `tool not found: ${name}`, isError: true };
  }

  private askUser(question: string, options: string[] | undefined, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("operação cancelada"));
      const onAbort = () => {
        this.pending = null;
        this.patch({ question: null });
        reject(new Error("operação cancelada"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        options,
        resolve: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          this.pending = null;
          this.patch({ question: null, status: "processando..." });
          resolve(answer);
        },
        reject,
      };
      this.patch({ question: { question, options }, status: "aguardando sua resposta..." });
    });
  }

  private flashStatus(status: string): void {
    this.clearStatusTimer();
    this.patch({ status });
    this.statusTimer = setTimeout(() => this.patch({ status: "pronto" }), STATUS_FLASH_MS);
  }

  private clearStatusTimer(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
  }

  private estimateTokens(state: SessionState): number {
    return (
      estimateTokens(buildSystemPrompt(state.mode, this.config.system, this.skills, this.memoryPrompt)) +
      estimateMessagesTokens(this.history) +
      estimateTokens(state.liveText)
    );
  }

  private patch(changes: Partial<SessionState>): void {
    const next = { ...this.state, ...changes };
    next.estimatedTokens = this.estimateTokens(next);
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}
