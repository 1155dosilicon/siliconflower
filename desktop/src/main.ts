import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AgentStartError, startAgentProcess, type AgentExit, type AgentProcess } from "./agent-process.js";
import { runAgentDoctor, type DoctorResult } from "./doctor.js";
import { addRecent, folderKey, loadRecents, removeRecent } from "./projects.js";
import { isConfigured, parseInput, readSettings, reasoningChoices, testConnection, writeSettings } from "./settings.js";

const BACKGROUND = "#15141a";

interface Project {
  key: string;
  folder: string;
  window: BrowserWindow;
  agent?: AgentProcess;
  closing: boolean;
}

const projects = new Map<string, Project>();
const stopping = new Set<Promise<void>>();
/** The only origin each window may show. A window that is not here navigates nowhere. */
const allowedOrigins = new WeakMap<WebContents, string>();
let home: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;
let settingsThen: (() => void) | undefined;
let quitting = false;
let nextPartition = 1;

const recentsFile = () => join(app.getPath("userData"), "projects.json");
// Not __dirname: the bundler replaces it with the folder of the source file.
const buildPath = (...parts: string[]) => join(app.getAppPath(), "build", ...parts);

/** Name of the agent built by `bun run build`: with .exe only on Windows. */
const AGENT_EXE = process.platform === "win32" ? "siliconflower.exe" : "siliconflower";

function agentExe(): string {
  return app.isPackaged
    ? join(process.resourcesPath, AGENT_EXE)
    : join(app.getAppPath(), "..", "dist", AGENT_EXE);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---- Security -------------------------------------------------------------------------

const hardenedSessions = new WeakSet<Session>();

function hardenSession(target: Session): void {
  if (hardenedSessions.has(target)) return;
  hardenedSessions.add(target);
  // Writing to the clipboard is the "Copiar" button of code blocks. Everything else is denied.
  target.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
  target.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");
  target.on("will-download", (event) => event.preventDefault());
}

function openExternally(rawUrl: string): void {
  try {
    const { protocol } = new URL(rawUrl);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(rawUrl);
  } catch {
    // not a URL: nothing to open
  }
}

function isAllowedNavigation(contents: WebContents, target: string): boolean {
  try {
    return new URL(target).origin === allowedOrigins.get(contents);
  } catch {
    return false;
  }
}

function showContextMenu(contents: WebContents, flags: Electron.EditFlags, hasSelection: boolean, editable: boolean): void {
  const items: MenuItemConstructorOptions[] = editable
    ? [
        { role: "cut", label: "Recortar", enabled: flags.canCut },
        { role: "copy", label: "Copiar", enabled: flags.canCopy },
        { role: "paste", label: "Colar", enabled: flags.canPaste },
        { type: "separator" },
        { role: "selectAll", label: "Selecionar tudo" },
      ]
    : hasSelection
      ? [{ role: "copy", label: "Copiar" }]
      : [];
  if (items.length) {
    const owner = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(items).popup(owner ? { window: owner } : undefined);
  }
}

app.on("web-contents-created", (_event, contents) => {
  // Links use target=_blank: they go to the default browser, never to a window of ours.
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  const guard = (event: { preventDefault: () => void }, target: string) => {
    if (!isAllowedNavigation(contents, target)) event.preventDefault();
  };
  contents.on("will-navigate", (event) => guard(event, event.url));
  contents.on("will-redirect", (event) => guard(event, event.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("context-menu", (_e, params) => {
    showContextMenu(contents, params.editFlags, params.selectionText.length > 0, params.isEditable);
  });
});

// ---- Project windows ------------------------------------------------------------------

function startFailureMessage(error: unknown): string {
  if (error instanceof AgentStartError) {
    switch (error.failure) {
      case "config_required":
        return "O provedor de IA não está configurado. Abra Arquivo > Configurações.";
      case "spawn_failed":
        return `Não consegui iniciar o agente em:\n${agentExe()}\n\n${error.detail}`;
      case "timeout":
        return `O agente não respondeu a tempo.\n\n${error.detail}`.trim();
      case "exited":
        return `O agente encerrou ao iniciar.\n\n${error.detail}`.trim();
    }
  }
  return `Não consegui abrir o projeto.\n\n${String(error)}`;
}

/** Starts the project's agent and shows it in the window. Throws if it cannot start. */
async function connect(project: Project, { resume = false }: { resume?: boolean } = {}): Promise<void> {
  const args = ["gui", "--managed", ...(resume ? ["--resume-latest"] : [])];
  const agent = startAgentProcess({ exe: agentExe(), cwd: project.folder, args });
  project.agent = agent;
  try {
    const url = await agent.ready;
    if (project.closing) return; // closed while starting: the closed handler stops the agent
    allowedOrigins.set(project.window.webContents, new URL(url).origin);
    await project.window.loadURL(url);
  } catch (error) {
    await agent.stop();
    throw error;
  }
  void agent.exited.then((info) => handleAgentExit(project, agent, info));
}

async function handleAgentExit(project: Project, agent: AgentProcess, info: AgentExit): Promise<void> {
  if (project.closing || project.agent !== agent) return;
  const { response } = await dialog.showMessageBox(project.window, {
    type: "error",
    title: "Siliconflower",
    message: `O agente de ${basename(project.folder)} parou de funcionar.`,
    detail: `A conversa está salva, menos a resposta que estava em andamento.\n\n${info.stderr || `Código de saída: ${info.code}`}`.trim(),
    buttons: ["Reabrir", "Fechar"],
    defaultId: 0,
    cancelId: 1,
  });
  if (project.closing) return;
  if (response !== 0) {
    project.window.close();
    return;
  }
  await reconnect(project);
}

/** A new agent for the same window, back in the most recent conversation. */
async function reconnect(project: Project): Promise<void> {
  try {
    await connect(project, { resume: true });
  } catch (error) {
    if (project.closing) return;
    await dialog.showMessageBox(project.window, { type: "error", title: "Siliconflower", message: startFailureMessage(error) });
    if (!project.closing) project.window.close();
  }
}

async function restartProject(project: Project): Promise<void> {
  const previous = project.agent;
  project.agent = undefined; // this exit is expected: see handleAgentExit
  await previous?.stop();
  if (!project.closing) await reconnect(project);
}

/** A running agent keeps the config it started with, so applying a change is a restart. */
async function offerRestart(running: Project[]): Promise<void> {
  const open = running.filter((project) => !project.closing);
  if (!open.length) return;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Siliconflower",
    message: open.length === 1 ? `Reiniciar ${basename(open[0]!.folder)} para usar a nova configuração?` : `Reiniciar os ${open.length} projetos abertos para usar a nova configuração?`,
    detail: "As conversas continuam de onde pararam, mas uma resposta em andamento é interrompida. Se preferir depois, a nova configuração vale quando o projeto for reaberto.",
    buttons: ["Reiniciar agora", "Depois"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = await dialog.showMessageBox(open[0]!.window, options);
  if (response === 0) await Promise.all(open.filter((project) => !project.closing).map(restartProject));
}

async function openProject(folder: string): Promise<boolean> {
  const path = resolve(folder);
  const key = folderKey(path);
  const existing = projects.get(key);
  if (existing) {
    if (existing.window.isVisible()) existing.window.focus();
    return true;
  }
  if (!isDirectory(path)) {
    await dialog.showMessageBox({ type: "error", title: "Siliconflower", message: `Pasta não encontrada:\n${path}` });
    return false;
  }

  // Each project has its own in-memory session: its cookie stays out of the other windows.
  const partition = session.fromPartition(`project-${nextPartition++}`);
  hardenSession(partition);
  const name = basename(path) || path;
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: BACKGROUND,
    title: `${name} - Siliconflower`,
    webPreferences: {
      session: partition,
      // The agent keeps working behind other windows, and its page must keep up.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && !project.closing) window.webContents.reload();
  });

  const project: Project = { key, folder: path, window, closing: false };
  projects.set(key, project);
  window.once("closed", () => {
    project.closing = true;
    if (projects.get(key) === project) projects.delete(key);
    const done = (project.agent?.stop() ?? Promise.resolve()).catch(() => {});
    stopping.add(done);
    void done.finally(() => stopping.delete(done));
  });

  try {
    await connect(project);
  } catch (error) {
    if (project.closing) return false;
    if (error instanceof AgentStartError && error.failure === "config_required") {
      // Opened before destroying the window: closing the last one would quit the app.
      showSettings(() => void openProject(path));
      window.destroy();
      return false;
    }
    showHome();
    await dialog.showMessageBox(home ?? window, { type: "error", title: "Siliconflower", message: startFailureMessage(error) });
    if (!project.closing) window.destroy();
    return false;
  }
  if (project.closing) return false;
  window.show();
  addRecent(recentsFile(), path);
  if (home && !home.isDestroyed()) home.close();
  return true;
}

async function pickAndOpen(parent?: BrowserWindow): Promise<boolean> {
  const options: Electron.OpenDialogOptions = { title: "Abrir pasta do projeto", properties: ["openDirectory"] };
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return canceled || !filePaths[0] ? false : openProject(filePaths[0]);
}

// ---- Start screen ---------------------------------------------------------------------

function showHome(): void {
  if (home && !home.isDestroyed()) {
    if (home.isMinimized()) home.restore();
    home.focus();
    return;
  }
  hardenSession(session.defaultSession);
  const window = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 480,
    minHeight: 400,
    show: false,
    backgroundColor: BACKGROUND,
    title: "Siliconflower",
    webPreferences: {
      preload: buildPath("preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  home = window;
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (home === window) home = undefined;
    // Nobody is left to read the report.
    doctorRun?.abort.abort();
  });
  void window.loadFile(buildPath("renderer", "home.html"));
}

// ---- Diagnosis ------------------------------------------------------------------------

let doctorRun: { result: Promise<DoctorResult>; abort: AbortController } | undefined;

/**
 * The diagnosis button of the start screen: the agent's own `doctor`, over the recent projects
 * that still exist. One run at a time: each starts a shell and calls the provider.
 */
function runHomeDoctor(fix: boolean): Promise<DoctorResult> {
  if (doctorRun) {
    const previous = doctorRun;
    // Cancelled by a start screen that closed: this one is another, and gets its own run.
    return previous.abort.signal.aborted ? previous.result.then(() => runHomeDoctor(fix)) : previous.result;
  }
  const abort = new AbortController();
  const result = runAgentDoctor({
    exe: agentExe(),
    cwd: app.getPath("home"),
    projects: loadRecents(recentsFile()).map((p) => p.path).filter(isDirectory),
    fix,
    signal: abort.signal,
  });
  const run = { result, abort };
  doctorRun = run;
  // Like a closing agent: the app does not quit while it runs.
  const done = result.then(() => {
    if (doctorRun === run) doctorRun = undefined;
  });
  stopping.add(done);
  void done.finally(() => stopping.delete(done));
  return result;
}

// ---- Settings -------------------------------------------------------------------------

/** One window; `then` runs after a successful save, for what was waiting on the config. */
function showSettings(then?: () => void): void {
  if (then) settingsThen = then;
  if (settings && !settings.isDestroyed()) {
    if (settings.isMinimized()) settings.restore();
    settings.focus();
    return;
  }
  hardenSession(session.defaultSession);
  const window = new BrowserWindow({
    width: 640,
    height: 680,
    minWidth: 420,
    minHeight: 400,
    show: false,
    backgroundColor: BACKGROUND,
    title: "Configurações - Siliconflower",
    webPreferences: {
      preload: buildPath("preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  settings = window;
  window.on("page-title-updated", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (settings !== window) return;
    settings = undefined;
    settingsThen = undefined;
  });
  void window.loadFile(buildPath("renderer", "settings.html"));
}

/** Local pages only: a project window has no bridge, but check anyway. */
function sentBy(window: BrowserWindow | undefined, event: IpcMainInvokeEvent): boolean {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!sentBy(home, event)) throw new Error("Remetente não autorizado.");
      return listener(event, ...args);
    });
  };
  const handleSettings = (channel: string, listener: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!sentBy(settings, event)) throw new Error("Remetente não autorizado.");
      return listener(...args);
    });
  };
  handle("settings:open", () => showSettings());
  // The page only says whether to fix: the checks and the folders are chosen here.
  handle("doctor:run", (_event, fix) => runHomeDoctor(fix === true));
  handleSettings("settings:get", () => readSettings());
  handleSettings("settings:reasoning", (baseURL) => reasoningChoices(typeof baseURL === "string" ? baseURL : ""));
  handleSettings("settings:test", (raw) => {
    const input = parseInput(raw);
    return input ? testConnection(input) : { ok: false, message: "Formulário inválido." };
  });
  handleSettings("settings:save", async (raw) => {
    const input = parseInput(raw);
    if (!input) return { ok: false, errors: {} };
    const result = await writeSettings(input);
    if (!result.ok) return result;
    // Taken first: what opens below already starts with the new config.
    const running = [...projects.values()].filter((project) => project.agent);
    const then = settingsThen;
    settingsThen = undefined;
    // Before closing the settings: closing the last window would quit the app.
    if (then) then();
    else if (!projects.size && !home) showHome();
    if (settings && !settings.isDestroyed()) settings.close();
    if (result.changed) void offerRestart(running);
    return result;
  });

  const listRecents = () => loadRecents(recentsFile()).map((p) => ({
    path: p.path,
    name: basename(p.path) || p.path,
    exists: isDirectory(p.path),
  }));
  handle("recents:list", listRecents);
  handle("project:pick", () => pickAndOpen(home));
  handle("project:open-recent", async (_event, path) => {
    // The page can only reopen what the user already chose, never name a new folder.
    if (typeof path !== "string") return false;
    const known = loadRecents(recentsFile()).find((p) => folderKey(p.path) === folderKey(path));
    return known ? openProject(known.path) : false;
  });
  handle("recents:forget", (_event, path) => {
    if (typeof path === "string") removeRecent(recentsFile(), path);
    return listRecents();
  });
}

// ---- Application ----------------------------------------------------------------------

function buildMenu(): void {
  const focused = () => BrowserWindow.getFocusedWindow() ?? undefined;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Arquivo",
      submenu: [
        { label: "Abrir pasta...", accelerator: "Ctrl+O", click: () => void pickAndOpen(focused()) },
        { label: "Projetos recentes", accelerator: "Ctrl+Shift+O", click: () => showHome() },
        { label: "Configurações...", accelerator: "Ctrl+,", click: () => showSettings() },
        { type: "separator" },
        { role: "close", label: "Fechar janela" },
        { role: "quit", label: "Sair" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Desfazer" },
        { role: "redo", label: "Refazer" },
        { type: "separator" },
        { role: "cut", label: "Recortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Colar" },
        { role: "selectAll", label: "Selecionar tudo" },
      ],
    },
    {
      label: "Exibir",
      submenu: [
        { role: "zoomIn", label: "Aumentar" },
        { role: "zoomOut", label: "Diminuir" },
        { role: "resetZoom", label: "Tamanho normal" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Tela cheia" },
        ...(app.isPackaged
          ? []
          : ([{ type: "separator" }, { role: "reload", label: "Recarregar" }, { role: "toggleDevTools", label: "Ferramentas de desenvolvedor" }] as MenuItemConstructorOptions[])),
      ],
    },
  ]));
}

/** The folder given on the command line, if any ("siliconflower-desktop C:\pasta" ou "siliconflower-desktop ~/pasta"). */
function folderFromArgs(argv: string[], workingDirectory: string): string | undefined {
  // Chromium may move switches ahead of the arguments, so positions mean nothing until
  // they are out. In development, the first argument left is the app's own folder.
  const args = argv.slice(1).filter((a) => !a.startsWith("-"));
  const arg = app.isPackaged ? args[0] : args[1];
  return arg ? resolve(workingDirectory, arg) : undefined;
}

function openFromArgs(argv: string[], workingDirectory: string): void {
  const folder = folderFromArgs(argv, workingDirectory);
  if (folder) void openProject(folder);
  else showHome();
}

/** On first use, the settings form comes first and what was asked for follows it. */
async function startApp(): Promise<void> {
  const open = () => openFromArgs(process.argv, process.cwd());
  if (await isConfigured()) open();
  else showSettings(open);
}

app.setName("Siliconflower");
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => openFromArgs(argv, workingDirectory));

  app.whenReady().then(() => {
    // Windows only (taskbar grouping); a no-op on Linux.
    app.setAppUserModelId("com.siliconflower.desktop");
    buildMenu();
    registerIpc();
    return startApp();
  });

  app.on("window-all-closed", () => app.quit());

  // Nothing may outlive the app: wait for every agent to end before really quitting.
  app.on("before-quit", (event) => {
    if (!projects.size && !stopping.size) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    doctorRun?.abort.abort();
    for (const project of [...projects.values()]) project.window.destroy();
    void (async () => {
      while (projects.size || stopping.size) {
        await Promise.race([...stopping, new Promise((done) => setTimeout(done, 50))]);
      }
      app.quit();
    })();
  });
}
