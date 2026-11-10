import { buildOpenAITools, streamChat } from "./llm.js";
import { McpManager } from "./mcp.js";
import { builtinToolsAsMcp, isBuiltin, runBuiltin } from "./tools.js";
import { loadSkills, readSkillContent, SKILL_TOOL, type Skill } from "./skills.js";
import { buildSystemPrompt, nextMode, type Mode } from "./modes.js";
import { buildMemorySystemPrompt } from "./services/memory.js";
import { onTodosChange, setTodos } from "./todo.js";
import { basename, join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  cleanTitle,
  conversationTitle,
  newConversationId,
  newRevision,
  type ConversationStore,
  type ConversationSummary,
  type ToolActivity,
} from "./services/conversations.js";
import { isToolMediaMessage, loadMedia, pruneMedia, stripMediaData, MAX_MEDIA_BYTES } from "./services/media.js";
import { killBackgroundTask, listBackgroundTasks, onBackgroundTasksChange } from "./services/background-tasks.js";
import { ensureDir, getWorkspaceDataDir } from "./fs-util.js";
import { estimateTokens, estimateMessagesTokens } from "./context.js";
import { log } from "./logger.js";
import type { AppConfig, ChatMessage, McpTool, MediaAttachment, ReasoningLevel, StreamEvent, TodoItem, ToolResult } from "./types.js";
import { isToolAllowedInMode } from "./tool-policy.js";
import { resolveHooks, runHook } from "./core/hooks.js";
import { isXiaomiMimoEndpoint, reasoningLabel, reasoningOptions } from "./reasoning.js";
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

/** A file the user attached in the interface: its name and its content in Base64. */
export interface SessionUpload {
  name: string;
  data: string;
}

/** A command or subagent still running in the background, for the interface to show and stop. */
export interface SessionBackgroundTask {
  id: string;
  type: "command" | "subagent";
  description: string;
  startedAt: string;
}

export const MAX_UPLOADS = 4;
const EMPTY_RESPONSE_NOTE = "[O modelo encerrou a resposta sem escrever nada. Envie a mensagem de novo ou reformule o pedido.]";

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
  /** The open conversation; null until its first turn ends. Only with a store. */
  conversationId: string | null;
  conversations: ConversationSummary[];
  /** Only what is still running: "Parar" ends the turn, not these. */
  backgroundTasks: SessionBackgroundTask[];
}

export interface SessionDeps {
  /** Replaceable in tests, so turns can run without a provider. */
  stream?: typeof streamChat;
  /** Where conversations are kept. Without it, they end with the session (e.g. tests). */
  store?: ConversationStore;
}

const STATUS_FLASH_MS = 1200;
const MAX_TOOL_ACTIVITIES = 300;
const MAX_TOOL_TEXT_CHARS = 50_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[... ${text.length - max} caracteres omitidos na interface]` : text;
}

/**
 * One agent conversation, independent of any UI: API history, tool dispatch, cancellation
 * and ask_question. Front ends (web GUI, desktop app) render `getState()` and call the action methods.
 */
export class AgentSession {
  readonly config: AppConfig;
  private readonly stream: typeof streamChat;
  private state: SessionState;
  private readonly stateListeners = new Set<(state: SessionState) => void>();
  private readonly streamListeners = new Set<(event: StreamEvent) => void>();
  private readonly activityListeners = new Set<(activity: ToolActivity) => void>();
  private readonly store: ConversationStore | undefined;
  private activities: ToolActivity[] = [];
  private nextActivityKey = 1;
  /** The running turn, so close() can wait for it to be saved. */
  private turn: Promise<void> | undefined;

  // Full API conversation (including tool calls and tool results), separate from the
  // rendered UI messages, so the model keeps the context of what its tools did.
  private history: ChatMessage[] = [];
  private mcp: McpManager | null = null;
  private skills: Skill[] = [];
  private memoryPrompt = "";
  private schemaTokens?: { toolCount: number; tokens: number };
  private abort: AbortController | null = null;
  private pending: { resolve: (answer: string) => void; reject: (err: Error) => void; options?: string[] } | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeTodos: (() => void) | undefined;
  private unsubscribeTasks: (() => void) | undefined;
  /** Stamp (`rev`) this session last saw in each conversation file: see ConversationStore.save. */
  private readonly stamps = new Map<string, string>();
  private started = false;
  private sending = false;
  private closed = false;

  constructor(config: AppConfig, overrides: SessionOverrides = {}, deps: SessionDeps = {}) {
    this.config = config;
    this.stream = deps.stream ?? streamChat;
    this.store = deps.store;
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
      conversationId: null,
      conversations: [],
      backgroundTasks: [],
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

  /** Tool cards of this conversation, in the order they ran. */
  getActivities(): ToolActivity[] {
    return this.activities;
  }

  /** Called when a tool card appears or gets its result. Returns the unsubscribe function. */
  onActivity(listener: (activity: ToolActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** Lists the saved conversations and, on request, reopens the most recent one. */
  async loadConversations({ resumeLatest = false }: { resumeLatest?: boolean } = {}): Promise<void> {
    const damaged = await this.refreshConversations();
    if (damaged) this.patch({ error: `${damaged} conversa(s) danificada(s) foram ignoradas.` });
    const latest = this.state.conversations[0];
    if (resumeLatest && latest) await this.resumeConversation(latest.id);
  }

  private async refreshConversations(): Promise<number> {
    if (!this.store) return 0;
    const { items, damaged } = await this.store.list();
    this.patch({ conversations: items });
    return damaged;
  }

  /** Starts an empty conversation. The current one is already saved. */
  newConversation(): void {
    if (this.state.streaming || this.closed) return;
    this.showConversation(null, { history: [], messages: [], activities: [], todos: [] });
  }

  /** Reopens a saved conversation. A damaged one becomes a message: the app goes on. */
  async resumeConversation(id: string): Promise<boolean> {
    if (!this.store || this.state.streaming || this.closed) return false;
    try {
      const body = await this.store.load(id);
      const stamp = await this.store.stamp(id);
      if (this.state.streaming || this.closed) return false; // a turn started meanwhile
      if (stamp) this.stamps.set(id, stamp);
      this.showConversation(id, body);
      return true;
    } catch (e) {
      await log("error", `Conversa ${id} não abriu: ${String(e)}`);
      this.patch({ error: "Não consegui abrir essa conversa: o arquivo está danificado ou foi apagado." });
      return false;
    }
  }

  /** Deletes a saved conversation; deleting the open one starts an empty one. */
  async deleteConversation(id: string): Promise<void> {
    if (!this.store || this.state.streaming || this.closed) return;
    try {
      await this.store.remove(id);
    } catch (e) {
      await log("error", `Conversa ${id} não foi apagada: ${String(e)}`);
      this.patch({ error: "Não consegui apagar essa conversa." });
      return;
    }
    this.stamps.delete(id);
    if (id === this.state.conversationId) this.newConversation();
    await this.refreshConversations();
  }

  /** Gives a saved conversation another title. Returns false when nothing changed. */
  async renameConversation(id: string, rawTitle: string): Promise<boolean> {
    const title = cleanTitle(rawTitle);
    if (!this.store || !title || this.closed) return false;
    try {
      await this.store.rename(id, title);
    } catch (e) {
      await log("error", `Conversa ${id} não foi renomeada: ${String(e)}`);
      this.patch({ error: "Não consegui renomear essa conversa." });
      return false;
    }
    await this.refreshConversations();
    return true;
  }

  /** Ends a background command or subagent from the interface. */
  killBackgroundTask(id: string): boolean {
    return killBackgroundTask(id).success;
  }

  private runningTasks(): SessionBackgroundTask[] {
    return listBackgroundTasks()
      .filter((task) => task.status === "running")
      .map(({ id, type, description, startedAt }) => ({ id, type, description, startedAt }));
  }

  private showConversation(id: string | null, body: { history: ChatMessage[]; messages: UIMessage[]; activities: ToolActivity[]; todos: TodoItem[] }): void {
    this.clearStatusTimer();
    this.history = body.history;
    this.activities = body.activities;
    this.nextActivityKey = Math.max(0, ...body.activities.map((a) => a.key)) + 1;
    setTodos(body.todos); // global: another conversation's tasks must not stay on screen
    this.patch({
      conversationId: id,
      messages: body.messages,
      todos: body.todos,
      apiTokens: 0,
      error: null,
      liveText: "",
      status: "pronto",
    });
  }

  /** Only complete turns reach this point: see commitTurn. A failure must not end the turn. */
  private async saveConversation(): Promise<void> {
    if (!this.store || !this.history.length) return;
    // Before writing: the page may open another conversation meanwhile, and an id set after
    // the write would make that conversation save its next turn over this one.
    let id = this.state.conversationId;
    if (!id) {
      id = newConversationId();
      this.patch({ conversationId: id });
    }
    const first = this.state.messages.find((m) => m.role === "user")?.content ?? "";
    // A title the user gave (renameConversation) stays.
    const title = this.state.conversations.find((c) => c.id === id)?.title ?? conversationTitle(first);
    const updatedAt = new Date().toISOString();
    const rev = newRevision();
    try {
      const savedAs = await this.store.save(
        { id, title, updatedAt, messageCount: this.state.messages.length, rev },
        { history: stripMediaData(this.history), messages: this.state.messages, activities: this.activities, todos: this.state.todos },
        this.stamps.get(id)
      );
      this.stamps.set(savedAs, rev);
      if (savedAs !== id) {
        // Another window wrote this conversation meanwhile: ours went on as a copy.
        this.stamps.delete(id);
        if (this.state.conversationId === id) {
          this.patch({ conversationId: savedAs, error: "Outra janela alterou esta conversa. Para não apagar o que ela gravou, esta janela continua numa cópia." });
        }
      }
      await this.refreshConversations();
    } catch (e) {
      await log("error", `Conversa não foi salva: ${String(e)}`);
      this.patch({ error: "Não consegui salvar esta conversa no disco." });
    }
  }

  /** Keeps the cards of the timeline up to date. Returns the card that changed. */
  private trackActivity(event: StreamEvent): ToolActivity | undefined {
    if (event.type === "tool_call") {
      const activity: ToolActivity = {
        key: this.nextActivityKey++,
        id: event.id,
        name: event.name,
        args: clip(event.args, MAX_TOOL_TEXT_CHARS),
        afterMessage: this.state.messages.length,
      };
      this.activities = [...this.activities, activity].slice(-MAX_TOOL_ACTIVITIES);
      return activity;
    }
    if (event.type === "tool_result") {
      // Some providers reuse call ids across steps: the latest unanswered call is the one.
      const activity = [...this.activities].reverse().find((a) => a.id === event.id && a.result === undefined);
      if (activity) {
        activity.result = clip(event.result, MAX_TOOL_TEXT_CHARS);
        activity.isError = event.isError;
      }
      return activity;
    }
    return undefined;
  }

  /** Loads skills and memory, runs the session hook and connects the MCP servers. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribeTodos = onTodosChange((updated) => this.patch({ todos: [...updated] }));
    this.unsubscribeTasks = onBackgroundTasksChange(() => { if (!this.closed) this.patch({ backgroundTasks: this.runningTasks() }); });
    const mcp = new McpManager();
    this.mcp = mcp;

    const loaded = await loadSkills();
    if (this.closed) return;
    this.skills = loaded;
    this.patch({ skillCount: loaded.length });
    this.memoryPrompt = await buildMemorySystemPrompt(process.cwd()).catch(() => "");
    this.patch({});
    await log("info", `siliconflower iniciado - model=${this.state.model}`);
    // config.json first, then hooks.json of the workspace or the global one.
    const hooks = await resolveHooks(this.config.hooks);
    if (hooks) await runHook("onSessionStart", hooks, { cwd: process.cwd() });
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
    this.unsubscribeTasks?.();
    this.abort?.abort();
    const pendingWork: Promise<unknown>[] = [];
    if (this.turn) pendingWork.push(this.turn); // what the aborted turn did must still be saved
    pendingWork.push(resolveHooks(this.config.hooks).then((hooks) => (hooks ? runHook("onSessionEnd", hooks, { cwd: process.cwd() }) : undefined)));
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

  /**
   * Runs one full turn, with the files the user attached, if any. Ignored while another turn
   * is running or after close().
   */
  async send(text: string, uploads: SessionUpload[] = []): Promise<void> {
    // Line breaks and tabs are content (the web front end has a multi-line input).
    const cleanText = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "").trim();
    if ((!cleanText && !uploads.length) || this.state.streaming || this.sending || this.closed) return;
    this.sending = true; // the turn only counts as streaming after the attachments are stored
    const turn = this.runTurn(cleanText, uploads).finally(() => { this.sending = false; });
    this.turn = turn;
    await turn;
  }

  /**
   * Replaces the last message the user sent and runs the turn again with the new text. The old
   * answer, its tool cards and its place in the API history are dropped before anything is
   * awaited, so the caller can redraw right after calling. What the tools of the old turn
   * already did (files written, commands run) is not undone. Files attached to the old
   * message go along again. Returns false when there is nothing to edit.
   */
  editLastMessage(text: string): Promise<void> | false {
    const cleanText = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "").trim();
    if (!cleanText || this.state.streaming || this.sending || this.closed) return false;
    const lastIndex = <T>(list: T[], match: (item: T) => boolean) => {
      for (let i = list.length - 1; i >= 0; i--) if (match(list[i]!)) return i;
      return -1;
    };
    const shownIndex = lastIndex(this.state.messages, (m) => m.role === "user");
    const historyIndex = lastIndex(this.history, (m) => m.role === "user" && !isToolMediaMessage(m));
    if (shownIndex === -1 || historyIndex === -1) return false;

    const media = this.history[historyIndex]!.media ?? [];
    this.history = this.history.slice(0, historyIndex);
    // Cards of the dropped turn were placed after its user message.
    this.activities = this.activities.filter((a) => a.afterMessage <= shownIndex);
    this.patch({ messages: this.state.messages.slice(0, shownIndex), error: null });

    this.sending = true;
    const turn = this.runTurn(cleanText, [], media).finally(() => { this.sending = false; });
    this.turn = turn;
    return turn;
  }

  /**
   * Saves the attached files in the project's data folder and loads them for the model.
   * Saved conversations keep only the path, which read_media can open again later.
   */
  private async storeUploads(uploads: SessionUpload[]): Promise<MediaAttachment[]> {
    if (uploads.length > MAX_UPLOADS) throw new Error(`no máximo ${MAX_UPLOADS} arquivos por mensagem`);
    const dir = join(getWorkspaceDataDir(process.cwd()), "uploads");
    await ensureDir(dir);
    const media: MediaAttachment[] = [];
    for (const [index, upload] of uploads.entries()) {
      const name = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(-80) || "arquivo";
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`${upload.name} tem ${bytes.length} bytes; o limite é ${MAX_MEDIA_BYTES}`);
      const path = join(dir, `${Date.now().toString(36)}-${index}-${name}`);
      await writeFile(path, bytes);
      try {
        media.push(await loadMedia(path, { allowAudioVideo: isXiaomiMimoEndpoint(this.config.baseURL) }));
      } catch (e) {
        throw new Error(`${upload.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return media;
  }

  private async runTurn(text: string, uploads: SessionUpload[], reusedMedia: MediaAttachment[] = []): Promise<void> {
    this.clearStatusTimer();
    let media: MediaAttachment[] = reusedMedia;
    if (uploads.length) {
      try {
        media = await this.storeUploads(uploads);
      } catch (e) {
        // Nothing was sent to the model. The page checks the file type before sending, so
        // this is rare (audio or video on a provider without them, a file too large).
        this.patch({ error: `Anexo não enviado: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      if (this.state.streaming || this.closed) return;
    }
    const cleanText = text || "Veja o anexo.";
    const names = uploads.length ? uploads.map((u) => u.name) : media.map((m) => basename(m.path).replace(/^[a-z0-9]+-\d+-/, "")); // without storeUploads' prefix
    const shown = media.length ? `${cleanText}\n\n${names.map((name) => `[anexo: ${name}]`).join("\n")}` : cleanText;
    this.patch({
      error: null,
      messages: [...this.state.messages, { role: "user", content: shown }],
      streaming: true,
      liveText: "",
      status: "pensando...",
    });

    // Pass the full API history (including tool calls/results from earlier turns) so the
    // model keeps that context; compressHistory in llm.ts applies the token budget.
    const userMsg: ChatMessage = { role: "user", content: cleanText, ...(media.length ? { media } : {}) };
    const messages: ChatMessage[] = [...this.history, userMsg];
    const controller = new AbortController();
    this.abort = controller;

    let accText = "";
    let accThinking = "";
    // Text since the last finished step: what came before is already in `steps`.
    let stepText = "";
    let hadError = false;
    let assistantMsgAdded = false;
    // Finished tool steps, kept even if the turn fails or is cancelled later: otherwise the
    // model would not know what its tools already did (files written, commands run).
    const steps: ChatMessage[] = [];
    // Commits this turn to the API history exactly once.
    const commitTurn = (turnMessages: ChatMessage[]) => {
      // Files that will not be sent again must not stay in memory for the whole conversation.
      this.history = pruneMedia([...this.history, userMsg, ...turnMessages]);
    };
    /** An interrupted turn: its finished steps, then what was being written and why it stopped. */
    const commitInterrupted = (note: string) => {
      const partial = stepText.trim();
      commitTurn([...steps, { role: "assistant", content: partial ? `${partial}\n\n${note}` : note }]);
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
        const activity = this.trackActivity(ev);
        for (const listener of this.streamListeners) listener(ev);
        if (activity) for (const listener of this.activityListeners) listener(activity);
        switch (ev.type) {
          case "thinking":
            accThinking += ev.text;
            this.patch({ status: "🧠 pensando..." });
            break;
          case "text":
            accText += ev.text;
            stepText += ev.text;
            this.patch({ liveText: accText });
            break;
          case "step":
            steps.push(...ev.messages);
            stepText = "";
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
              commitInterrupted(`[Erro: ${ev.message}]`);
            }
            break;
          case "done": {
            const final = ev.content?.trim() || accText.trim();
            const finalThinking = ev.reasoning?.trim() || accThinking.trim();
            // Nothing at all (no text, no tool step): without a note the turn would end in
            // silence, as if the message had never been sent.
            const silent = !final && steps.length === 0;
            const shownFinal = silent ? EMPTY_RESPONSE_NOTE : final;
            if (shownFinal) {
              this.patch({
                messages: [...this.state.messages, { role: "assistant", content: shownFinal, reasoning: finalThinking || undefined }],
              });
            }
            assistantMsgAdded = true;
            const turnMessages = ev.messages ?? (final ? [{ role: "assistant" as const, content: final }] : []);
            // The history keeps user and assistant alternating.
            commitTurn(silent ? [{ role: "assistant", content: EMPTY_RESPONSE_NOTE }] : turnMessages);
            break;
          }
        }
      }
      this.patch({ status: hadError ? "erro" : "pronto" });
    } catch (e) {
      hadError = true;
      // Only the turn's own signal means a cancel: see isCancellation in llm.ts.
      const isAbort = controller.signal.aborted;
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
        // Finished steps are kept (llm.ts closes a step cut by a cancel); tool calls of a
        // response still being received are not, since they never ran.
        commitInterrupted(isAbort ? "[interrompido pelo usuário]" : `[${errMsg}]`);
      }
    } finally {
      this.pending?.reject(new Error("operação encerrada"));
      this.pending = null;
      this.abort = null;
      this.patch({ question: null, streaming: false, liveText: "" });
    }
    await this.saveConversation();
  }

  private allTools(): McpTool[] {
    const list: McpTool[] = [...builtinToolsAsMcp()];
    list.push({ server: "skill", name: SKILL_TOOL.name, description: SKILL_TOOL.description, inputSchema: SKILL_TOOL.inputSchema });
    if (this.mcp) list.push(...this.mcp.allTools());
    return list;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { mode, model } = this.state;
    if (!isToolAllowedInMode(mode, name, args)) {
      return {
        result: `[MODO PLANO ATIVO] Execução de ${name} bloqueada. Apresente o plano ao usuário e peça para alternar para o modo 'programação' (o seletor Modo da interface) para aplicar as alterações.`,
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
      // The same preTool/postTool hooks as the native tools (runBuiltin runs those).
      const signal = this.abort?.signal;
      const hooks = await resolveHooks(this.config.hooks);
      const hookCtx = { toolName: name, toolArgs: args, cwd: process.cwd() };
      if (hooks) {
        await runHook("preTool", hooks, hookCtx, signal);
        if (signal?.aborted) return { result: `Execução de ${name} cancelada pelo usuário.`, isError: true };
      }
      try {
        return await this.mcp.callTool(name, args, signal);
      } catch (e) {
        return { result: String(e), isError: true };
      } finally {
        if (hooks) await runHook("postTool", hooks, hookCtx, signal);
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

  /** Runs on every state change (each stream chunk), so the serialized schemas are cached. */
  private toolSchemaTokens(): number {
    const tools = this.allTools();
    if (this.schemaTokens?.toolCount !== tools.length) {
      this.schemaTokens = { toolCount: tools.length, tokens: estimateTokens(JSON.stringify(buildOpenAITools(tools))) };
    }
    return this.schemaTokens.tokens;
  }

  private estimateTokens(state: SessionState): number {
    return (
      estimateTokens(buildSystemPrompt(state.mode, this.config.system, this.skills, this.memoryPrompt)) +
      this.toolSchemaTokens() +
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
