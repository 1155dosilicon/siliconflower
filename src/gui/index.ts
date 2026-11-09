import { AgentSession, type SessionOverrides } from "../session.js";
import { runShell, describeFailure } from "../shell.js";
import { isWindows } from "../platform.js";
import { killAllBackgroundTasks } from "../services/background-tasks.js";
import { ConversationStore } from "../services/conversations.js";
import { getWorkspaceDataDir } from "../fs-util.js";
import { join } from "node:path";
import { log } from "../logger.js";
import type { AppConfig } from "../types.js";
import { startGuiServer } from "./server.js";
import { emitManagedEvent } from "./managed.js";

const CLOSE_TIMEOUT_MS = 5_000;

export interface GuiOptions {
  port?: number;
  open: boolean;
  /** Controlled by another program: see managed.ts. The parent decides when to close. */
  managed?: boolean;
  /** Reopens the project's most recent conversation instead of starting an empty one. */
  resumeLatest?: boolean;
}

/** Runs the web front end until the page is closed or the terminal is interrupted. */
export async function startGui(config: AppConfig, overrides: SessionOverrides, options: GuiOptions): Promise<void> {
  const store = new ConversationStore(join(getWorkspaceDataDir(process.cwd()), "sessions"));
  const session = new AgentSession(config, overrides, { store });
  // Before the server: the first page must already see the conversation.
  await session.loadConversations({ resumeLatest: options.resumeLatest });
  const managed = options.managed ?? false;
  let shuttingDown = false;
  let finish = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!managed) console.log("Encerrando o siliconflower...");
    server.stop();
    // A hook that never ends must not keep the app alive with no way to close it.
    await Promise.race([
      Promise.allSettled([session.close(), killAllBackgroundTasks()]),
      new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
    finish();
  };

  const server = startGuiServer(session, {
    port: options.port,
    // A window with a crashed page still exists: only the parent can tell it is gone.
    onIdle: managed ? undefined : () => void shutdown(),
  });
  void session.start().catch((e) => log("error", `GUI: falha ao iniciar a sessão: ${String(e)}`));

  const signals: NodeJS.Signals[] = isWindows() ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, () => void shutdown());
  }

  if (managed) {
    process.stdin.once("end", () => void shutdown());
    process.stdin.once("close", () => void shutdown());
    process.stdin.resume();
    emitManagedEvent({ event: "ready", url: server.url });
  } else {
    console.log(`Siliconflower aberto em:\n  ${server.url}`);
    console.log("Essa URL dá acesso ao agente: não a compartilhe. Feche a aba ou tecle Ctrl+C aqui para encerrar.");
  }
  if (options.open) {
    // The URL is built by the server (fixed host, numeric port, hex token): safe to quote.
    const res = await runShell(openUrlCommand(server.url), { timeout: 15_000 });
    const failure = describeFailure(res);
    if (failure) {
      await log("warn", `GUI: navegador não abriu: ${failure}`);
      console.log("Não consegui abrir o navegador: copie a URL acima para o Firefox ou outro navegador.");
    }
  }

  await finished;
  // Background tasks and MCP handles could otherwise keep the process running.
  process.exit(0);
}

/** Opens the default browser. Windows: Start-Process; Linux: xdg-open. */
export function openUrlCommand(url: string): string {
  if (isWindows()) return `Start-Process '${url}'`;
  return `xdg-open '${url}' >/dev/null 2>&1`;
}
