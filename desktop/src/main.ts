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
import { addRecent, folderKey, loadRecents, removeRecent } from "./projects.js";

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
let quitting = false;
let nextPartition = 1;

const recentsFile = () => join(app.getPath("userData"), "projects.json");
// Not __dirname: the bundler replaces it with the folder of the source file.
const buildPath = (...parts: string[]) => join(app.getAppPath(), "build", ...parts);

function agentExe(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "siliconflower.exe")
    : join(app.getAppPath(), "..", "dist", "siliconflower.exe");
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
        return "O provedor de IA ainda não foi configurado.\n\nAbra um terminal, rode \"siliconflower config\" e tente de novo.";
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
async function connect(project: Project): Promise<void> {
  const agent = startAgentProcess({ exe: agentExe(), cwd: project.folder });
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
    detail: `A conversa desta janela foi perdida.\n\n${info.stderr || `Código de saída: ${info.code}`}`.trim(),
    buttons: ["Reabrir", "Fechar"],
    defaultId: 0,
    cancelId: 1,
  });
  if (project.closing) return;
  if (response !== 0) {
    project.window.close();
    return;
  }
  try {
    await connect(project);
  } catch (error) {
    if (project.closing) return;
    await dialog.showMessageBox(project.window, { type: "error", title: "Siliconflower", message: startFailureMessage(error) });
    if (!project.closing) project.window.close();
  }
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
  window.once("closed", () => { if (home === window) home = undefined; });
  void window.loadFile(buildPath("renderer", "home.html"));
}

/** IPC is only for the start screen: a project window has no bridge, but check anyway. */
function fromHome(event: IpcMainInvokeEvent): boolean {
  return Boolean(home && !home.isDestroyed() && event.sender === home.webContents && event.senderFrame === home.webContents.mainFrame);
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromHome(event)) throw new Error("Remetente não autorizado.");
      return listener(event, ...args);
    });
  };
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
        { label: "Abrir pasta...", accelerator: "CmdOrCtrl+O", click: () => void pickAndOpen(focused()) },
        { label: "Projetos recentes", accelerator: "CmdOrCtrl+Shift+O", click: () => showHome() },
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

/** The folder given on the command line, if any ("siliconflower-desktop C:\pasta"). */
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

app.setName("Siliconflower");
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => openFromArgs(argv, workingDirectory));

  app.whenReady().then(() => {
    app.setAppUserModelId("com.siliconflower.desktop");
    buildMenu();
    registerIpc();
    openFromArgs(process.argv, process.cwd());
  });

  app.on("window-all-closed", () => app.quit());

  // Nothing may outlive the app: wait for every agent to end before really quitting.
  app.on("before-quit", (event) => {
    if (!projects.size && !stopping.size) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const project of [...projects.values()]) project.window.destroy();
    void (async () => {
      while (projects.size || stopping.size) {
        await Promise.race([...stopping, new Promise((done) => setTimeout(done, 50))]);
      }
      app.quit();
    })();
  });
}
