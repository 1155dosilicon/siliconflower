import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigFileError, configFile, loadConfig } from "./config.js";
import { ignoredRepoHooksFile, resolveHooks, workspaceHooksFile } from "./core/hooks.js";
import { ensureDir, getGlobalDataDir, getWorkspaceDataDir } from "./fs-util.js";
import { logFile, redactSecrets } from "./logger.js";
import { McpManager, type McpServerStatus } from "./mcp.js";
import { getDefaultShell, isWindows } from "./platform.js";
import { findProject } from "./project.js";
import { checkProvider } from "./provider-check.js";
import { ConversationStore } from "./services/conversations.js";
import { describeFailure, runShell } from "./shell.js";
import { loadSkills, skillsDir } from "./skills.js";
import type { AppConfig } from "./types.js";
import { APP_VERSION } from "./version.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  /** Stable ASCII name of the check. */
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** A list under the detail: one server, file or event per entry. */
  items?: string[];
  /** How to solve it, when there is something to solve. */
  hint?: string;
  /** `--fix` can solve it by itself. */
  fixable?: boolean;
  /** What `--fix` changed. */
  fixed?: string;
}

export interface DoctorOptions {
  /** Applies the fixes that are safe to make without asking. */
  fix?: boolean;
  /** Skips the checks that contact the provider and the MCP servers. */
  offline?: boolean;
  cwd?: string;
  /**
   * The folders to check in place of `cwd`. The start screen of the app has no project of its
   * own: it reports its recent ones together, and none of them when the list is empty.
   */
  projects?: string[];
  /** What is in use (a running session, the global options of the CLI), tested in place of the saved values. */
  overrides?: { baseURL?: string; apiKey?: string; model?: string };
  /**
   * The servers of a running session, reported as they are: connecting them a second time
   * would start every stdio server twice. "connecting" while the session is still at it.
   */
  mcp?: McpServerStatus[] | "connecting";
  fetchImpl?: typeof fetch;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when a check failed; warnings alone keep it true. */
  ok: boolean;
}

const SHELL_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHELL_MARKER = "siliconflower-doctor";
/** After the marker: an accent decoded in the wrong codepage shows the shell output is corrupted. */
const SHELL_ACCENTS = "ação";
const ENV_NAMES = ["SILICONFLOWER_API_KEY", "SILICONFLOWER_BASE_URL", "SILICONFLOWER_MODEL"] as const;
const DAMAGED_SUFFIX = ".danificada";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function checkSystem(): DoctorCheck {
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
  const check = { id: "system", title: "Sistema", detail: `siliconflower ${APP_VERSION} em ${process.platform}/${process.arch}, ${runtime}` };
  const supported = (isWindows() || process.platform === "linux") && process.arch === "x64";
  if (!supported) {
    return { ...check, status: "warn", hint: "Só Windows e Linux em x86_64 são suportados: nesta plataforma nada é testado." };
  }
  if (!process.versions.bun) {
    return { ...check, status: "warn", hint: "`siliconflower gui` requer o Bun ou o executável compilado; os demais comandos rodam no Node." };
  }
  return { ...check, status: "ok" };
}

async function checkDataDir(fix: boolean): Promise<DoctorCheck> {
  const dir = getGlobalDataDir();
  const check = { id: "data-dir", title: "Pasta de dados" };
  const fromEnv = process.env.SILICONFLOWER_DATA_DIR?.trim() ? " (definida por SILICONFLOWER_DATA_DIR)" : "";
  const probe = join(dir, `.doctor-${process.pid}.tmp`);
  try {
    await ensureDir(dir);
    await writeFile(probe, "ok", "utf8");
  } catch (e) {
    return {
      ...check,
      status: "fail",
      detail: `não consigo gravar em ${dir}${fromEnv}: ${reason(e)}`,
      hint: "Confira as permissões da pasta e o espaço em disco. Sem ela, configuração, conversas, memórias e logs não são salvos.",
    };
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
  if (isWindows()) return { ...check, status: "ok", detail: `${dir}${fromEnv}` };

  // Conversations are saved there in plain text and follow the umask (see SECURITY.md).
  const mode = (await stat(dir)).mode & 0o777;
  if ((mode & 0o077) === 0) return { ...check, status: "ok", detail: `${dir}${fromEnv}` };
  const shown = mode.toString(8).padStart(3, "0");
  if (fix) {
    try {
      await chmod(dir, 0o700);
      return { ...check, status: "ok", detail: `${dir}${fromEnv}`, fixed: `permissão da pasta mudou de ${shown} para 700` };
    } catch (e) {
      return { ...check, status: "warn", detail: `${dir}${fromEnv} pode ser lida por outros usuários (permissão ${shown}), e não consegui mudar isso: ${reason(e)}` };
    }
  }
  return {
    ...check,
    status: "warn",
    detail: `${dir}${fromEnv} pode ser lida por outros usuários (permissão ${shown})`,
    hint: "As conversas ficam nela em texto puro. A correção automática deixa a pasta só para o seu usuário (chmod 700).",
    fixable: true,
  };
}

const CONFIG_HINT = `Abra Arquivo > Configurações no app, ou rode \`siliconflower config\`. As variáveis ${ENV_NAMES.join(", ")} valem no lugar dos campos do arquivo.`;

/** The config the agent would run with, or null when there is no config.json that can be used. */
async function checkConfig(overrides: DoctorOptions["overrides"] = {}): Promise<{ check: DoctorCheck; config: AppConfig | null; usable: boolean }> {
  const check = { id: "config", title: "Configuração" };
  let config: AppConfig | null;
  try {
    config = await loadConfig();
  } catch (e) {
    if (!(e instanceof ConfigFileError)) throw e;
    // The message already says where the file is and what to do with it.
    return { check: { ...check, status: "fail", detail: e.message }, config: null, usable: false };
  }
  if (!config) {
    // The agent does not start without the file, even with every variable set.
    return { check: { ...check, status: "fail", detail: `${configFile()} não existe`, hint: CONFIG_HINT }, config: null, usable: false };
  }
  if (overrides.baseURL) config.baseURL = overrides.baseURL;
  if (overrides.apiKey) config.apiKey = overrides.apiKey;
  if (overrides.model) config.model = overrides.model;

  const where = configFile();
  const missing = [
    config.baseURL ? "" : "o endereço base (baseURL)",
    config.apiKey ? "" : "a chave de API (apiKey)",
    config.model ? "" : "o modelo (model)",
  ].filter(Boolean);
  if (missing.length) {
    return { check: { ...check, status: "fail", detail: `${where}; falta ${missing.join(", ")}`, hint: CONFIG_HINT }, config, usable: false };
  }
  let host: string;
  try {
    const url = new URL(config.baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocolo");
    host = url.host;
  } catch {
    return {
      check: {
        ...check,
        status: "fail",
        detail: `${where}; o endereço base "${config.baseURL}" não é uma URL http(s)`,
        hint: "Use o endereço da API do provedor, que normalmente termina em /v1 (por exemplo, https://api.siliconflow.com/v1).",
      },
      config,
      usable: false,
    };
  }
  const active = ENV_NAMES.filter((name) => process.env[name]?.trim());
  const items = active.length ? [`variáveis de ambiente em uso no lugar do arquivo: ${active.join(", ")}`] : undefined;
  return { check: { ...check, status: "ok", detail: `${where}; modelo ${config.model} em ${host}`, items }, config, usable: true };
}

function providerHint(status: number | undefined): string {
  if (status === 401 || status === 403) return "Confira a chave de API (Arquivo > Configurações no app, ou `siliconflower config`) e a variável SILICONFLOWER_API_KEY, se estiver definida.";
  if (status === 404) return "Confira o endereço base (normalmente termina em /v1) e o nome exato do modelo.";
  if (status === 429) return "O provedor recusou por limite de uso ou falta de saldo: confira a sua conta nele.";
  if (status !== undefined && status >= 500) return "O problema está no provedor: tente de novo mais tarde.";
  if (status === undefined) return "Confira a internet, o proxy e o endereço base.";
  return "Confira o endereço base, a chave de API e o nome do modelo.";
}

async function checkProviderAccess(config: AppConfig | null, usable: boolean, offline: boolean, fetchImpl?: typeof fetch): Promise<DoctorCheck> {
  const check = { id: "provider", title: "Provedor de IA" };
  if (!config || !usable) return { ...check, status: "skip", detail: "não testado: a configuração está incompleta" };
  if (offline) return { ...check, status: "skip", detail: "não testado (--offline)" };
  const result = await checkProvider(config, fetchImpl);
  if (result.ok) return { ...check, status: "ok", detail: result.message };
  return { ...check, status: "fail", detail: result.message, hint: providerHint(result.status) };
}

/** Connects every configured server just to see whether it answers, and closes them again. */
async function probeMcpServers(servers: NonNullable<AppConfig["mcpServers"]>): Promise<McpServerStatus[]> {
  const manager = new McpManager();
  try {
    await manager.connectAll(servers);
    return manager.status();
  } finally {
    await manager.close();
  }
}

async function checkMcp(config: AppConfig | null, offline: boolean, known: DoctorOptions["mcp"]): Promise<DoctorCheck> {
  const check = { id: "mcp", title: "Servidores MCP" };
  if (!config) return { ...check, status: "skip", detail: "não testados: não há configuração para ler" };
  const servers = config.mcpServers ?? {};
  const count = Object.keys(servers).length;
  if (!count) return { ...check, status: "ok", detail: "nenhum configurado" };
  if (known === "connecting") return { ...check, status: "skip", detail: "ainda conectando: verifique de novo em instantes" };
  if (!known && offline) return { ...check, status: "skip", detail: `${plural(count, "configurado", "configurados")}, não testados (--offline)` };

  const statuses = known ?? (await probeMcpServers(servers));
  const items = statuses.map((s) =>
    s.error !== undefined ? `${s.server}: não conectou (${redactSecrets(s.error)})` : `${s.server}: ${plural(s.tools, "ferramenta", "ferramentas")}`
  );
  const failed = statuses.filter((s) => s.error !== undefined).length;
  if (!failed) return { ...check, status: "ok", detail: plural(statuses.length, "servidor conectou", "servidores conectaram"), items };
  return {
    ...check,
    // The native tools keep working without them: a warning, not a failure.
    status: "warn",
    detail: `${failed} de ${plural(statuses.length, "servidor", "servidores")} não conectou`,
    items,
    hint: "Um `command` que o agente não acha costuma ser o PATH (comum com `npx` do nvm no app aberto pelo menu): use o caminho completo no config.json. Num servidor por `url`, confira o endereço e os `headers`.",
  };
}

async function checkShell(): Promise<DoctorCheck> {
  const shell = isWindows() ? "powershell.exe" : getDefaultShell();
  const check = { id: "shell", title: "Shell" };
  const res = await runShell(`echo ${SHELL_MARKER}-${SHELL_ACCENTS}`, { timeout: SHELL_TIMEOUT_MS });
  const failure = describeFailure(res, SHELL_TIMEOUT_MS);
  if (failure || !res.stdout.includes(SHELL_MARKER)) {
    return {
      ...check,
      status: "fail",
      detail: `${shell} não executou um comando simples: ${failure ?? "saída inesperada"}${res.stderr.trim() ? ` (${res.stderr.trim().slice(0, 300)})` : ""}`,
      hint: isWindows()
        ? "O agente usa o Windows PowerShell 5.1: confira se powershell.exe existe e está no PATH."
        : "O agente usa o shell da variável SHELL (ou /bin/bash): confira se ela aponta para um shell que aceita `-c`.",
    };
  }
  if (!res.stdout.includes(`${SHELL_MARKER}-${SHELL_ACCENTS}`)) {
    return { ...check, status: "warn", detail: `${shell} responde, mas devolve acentos corrompidos`, hint: "Saídas de comandos com acentos chegarão erradas ao modelo: confira a codificação do terminal (UTF-8)." };
  }
  return { ...check, status: "ok", detail: `${shell} executa comandos e devolve acentos certos` };
}

async function checkGit(): Promise<DoctorCheck> {
  const check = { id: "git", title: "Git" };
  const res = await runShell("git --version", { timeout: SHELL_TIMEOUT_MS });
  const version = res.stdout.trim().split(/\r?\n/)[0] ?? "";
  if (!describeFailure(res, SHELL_TIMEOUT_MS) && /^git version/i.test(version)) return { ...check, status: "ok", detail: version };
  return {
    ...check,
    // Optional: only the worktree tools need it.
    status: "warn",
    detail: "não encontrado: enter_worktree, exit_worktree e list_worktrees não funcionam sem ele",
    hint: "Instale o git e abra um novo terminal (ou reabra o app) para o PATH valer.",
  };
}

async function checkHooks(config: AppConfig | null, folders: string[]): Promise<DoctorCheck> {
  const check = { id: "hooks", title: "Hooks" };
  const events = new Set<string>();
  const ignored: { file: string; target: string }[] = [];
  for (const folder of folders) {
    for (const event of Object.keys((await resolveHooks(config?.hooks, folder)) ?? {})) events.add(event);
    const file = await ignoredRepoHooksFile(folder);
    if (file && !ignored.some((entry) => entry.file === file)) ignored.push({ file, target: workspaceHooksFile(folder) });
  }
  const detail = events.size ? `em vigor: ${[...events].join(", ")}` : "nenhum configurado";
  if (!ignored.length) return { ...check, status: "ok", detail };
  // Never moved by --fix: that would run commands that came with a cloned repository.
  if (ignored.length === 1) {
    const only = ignored[0]!;
    return {
      ...check,
      status: "warn",
      detail: `${detail}; ${only.file} não roda, porque fica dentro do repositório`,
      hint: `Se os comandos desse arquivo são seus, mova-o para ${only.target}.`,
    };
  }
  return {
    ...check,
    status: "warn",
    detail: `${detail}; ${ignored.length} arquivos hooks.json não rodam, porque ficam dentro do repositório`,
    items: ignored.map((entry) => `${entry.file} (para manter, mova para ${entry.target})`),
    hint: "Mova só os arquivos cujos comandos são seus, cada um para o caminho ao lado dele.",
  };
}

function checkProject(cwd: string): DoctorCheck {
  const check = { id: "project", title: "Projeto" };
  const project = findProject(cwd);
  if (project) return { ...check, status: "ok", detail: `${project.root} (${project.markerPath}); dados em ${getWorkspaceDataDir(cwd)}` };
  return { ...check, status: "ok", detail: "esta pasta não é um projeto, então a memória de projeto fica desligada (`siliconflower init` cria um)" };
}

async function checkSkills(): Promise<DoctorCheck> {
  const skills = await loadSkills();
  return { id: "skills", title: "Skills", status: "ok", detail: `${skills.length} em ${skillsDir()}` };
}

/** `recents`: the folders are the recent projects of the app, not the one the agent runs in. */
async function checkConversations(folders: string[], recents: boolean, fix: boolean): Promise<DoctorCheck> {
  const check = { id: "conversations", title: "Conversas salvas" };
  // Two folders of the same project share the data folder.
  const dirs = [...new Set(folders.map((folder) => join(getWorkspaceDataDir(folder), "sessions")))];
  let saved = 0;
  const damaged: string[] = [];
  for (const dir of dirs) {
    const store = new ConversationStore(dir);
    const [{ items }, files] = await Promise.all([store.list(), store.damagedFiles()]);
    saved += items.length;
    damaged.push(...files);
  }
  const detail = recents ? `${saved} em ${plural(dirs.length, "projeto recente", "projetos recentes")}` : `${saved} neste projeto`;
  if (!damaged.length) return { ...check, status: "ok", detail };
  if (!fix) {
    return {
      ...check,
      status: "warn",
      detail: `${detail}; ${plural(damaged.length, "arquivo danificado, que a interface ignora", "arquivos danificados, que a interface ignora")}`,
      items: damaged,
      hint: `Se não der para recuperar o conteúdo, a correção automática renomeia cada um para *.jsonl${DAMAGED_SUFFIX} (nada é apagado) e o aviso some da interface.`,
      fixable: true,
    };
  }
  const moved: string[] = [];
  const failed: string[] = [];
  for (const file of damaged) {
    // Kept, under a name the interface does not list: the user may still want what is in it.
    const target = existsSync(`${file}${DAMAGED_SUFFIX}`) ? `${file}.${Date.now()}${DAMAGED_SUFFIX}` : `${file}${DAMAGED_SUFFIX}`;
    try {
      await rename(file, target);
      moved.push(target);
    } catch (e) {
      failed.push(`${file}: ${reason(e)}`);
    }
  }
  if (failed.length) {
    return { ...check, status: "warn", detail: `${detail}; não consegui renomear ${plural(failed.length, "arquivo danificado", "arquivos danificados")}`, items: failed };
  }
  return { ...check, status: "ok", detail, fixed: `${plural(moved.length, "arquivo danificado renomeado", "arquivos danificados renomeados")} para *.jsonl${DAMAGED_SUFFIX}`, items: moved };
}

/** The ERROR lines the log got in the last 24 hours, oldest first. */
async function recentLogErrors(now: number): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(logFile(), "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => {
    // The stamp is UTC (logger.ts).
    const stamp = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\] ERROR /.exec(line);
    return stamp !== null && Date.parse(`${stamp[1]}T${stamp[2]}Z`) >= now - DAY_MS;
  });
}

async function checkLogs(): Promise<DoctorCheck> {
  const check = { id: "logs", title: "Log" };
  const errors = await recentLogErrors(Date.now());
  if (!errors.length) return { ...check, status: "ok", detail: `sem erros nas últimas 24 h (${logFile()})` };
  return {
    ...check,
    status: "warn",
    detail: `${plural(errors.length, "erro", "erros")} nas últimas 24 h; o mais recente:`,
    items: [errors.at(-1)!.slice(0, 400)],
    hint: `Um erro que já foi resolvido pode ser ignorado. O log completo fica em ${logFile()}.`,
  };
}

/** A check that throws is a finding too: the report must still come out. */
async function guarded(id: string, title: string, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (e) {
    return { id, title, status: "fail", detail: `a verificação falhou: ${reason(e)}` };
  }
}

/**
 * Checks what the agent needs to work (`siliconflower doctor`) and says how to solve what is
 * wrong. Nothing is changed without `fix`, and `fix` only makes changes that lose no data.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const fix = options.fix ?? false;
  const offline = options.offline ?? false;
  const recents = options.projects !== undefined;
  const folders = options.projects ?? [cwd];

  // Before the other checks: a server that does not connect is logged as an error by them.
  const logs = await guarded("logs", "Log", checkLogs);
  const dataDir = await guarded("data-dir", "Pasta de dados", () => checkDataDir(fix));
  const { check: configCheck, config, usable } = await checkConfig(options.overrides).catch((e) => ({
    check: { id: "config", title: "Configuração", status: "fail", detail: `a verificação falhou: ${reason(e)}` } satisfies DoctorCheck,
    config: null,
    usable: false,
  }));

  const rest = await Promise.all([
    guarded("provider", "Provedor de IA", () => checkProviderAccess(config, usable, offline, options.fetchImpl)),
    guarded("mcp", "Servidores MCP", () => checkMcp(config, offline, options.mcp)),
    guarded("shell", "Shell", checkShell),
    guarded("git", "Git", checkGit),
    // Per project: left out when there is no project to look at.
    ...(folders.length ? [guarded("hooks", "Hooks", () => checkHooks(config, folders))] : []),
    ...(recents ? [] : [guarded("project", "Projeto", () => checkProject(cwd))]),
    guarded("skills", "Skills", checkSkills),
    ...(folders.length ? [guarded("conversations", "Conversas salvas", () => checkConversations(folders, recents, fix))] : []),
  ]);

  const checks = [checkSystem(), dataDir, configCheck, ...rest, logs];
  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "[ok]", warn: "[aviso]", fail: "[falha]", skip: "[--]" };
const INDENT = " ".repeat(8);

/** The report as text for the terminal. The markers are ASCII: they must read in any console. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Diagnóstico do siliconflower", ""];
  for (const check of report.checks) {
    lines.push(`${STATUS_LABEL[check.status].padEnd(INDENT.length)}${check.title}: ${check.detail}`);
    for (const item of check.items ?? []) lines.push(`${INDENT}- ${item}`);
    if (check.fixed) lines.push(`${INDENT}Corrigido: ${check.fixed}`);
    if (check.hint) lines.push(`${INDENT}Como resolver: ${check.hint}`);
  }
  lines.push("", summarizeDoctorReport(report));
  if (report.checks.some((c) => c.fixable)) {
    lines.push("`siliconflower doctor --fix` aplica a correção automática; o resto depende de você.");
  }
  return lines.join("\n");
}

/** One line for the whole report, shared by the terminal and the interface. */
export function summarizeDoctorReport(report: DoctorReport): string {
  const failures = report.checks.filter((c) => c.status === "fail").length;
  const warnings = report.checks.filter((c) => c.status === "warn").length;
  if (!failures && !warnings) return "Tudo certo.";
  return `${plural(failures, "problema", "problemas")} e ${plural(warnings, "aviso", "avisos")}.`;
}
