import type { ChildProcess } from "node:child_process";
import { log } from "../logger.js";
import { startShell, killProcessTree, describeFailure } from "../shell.js";

export type BackgroundTaskType = "command" | "subagent";
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTaskRecord {
  id: string;
  type: BackgroundTaskType;
  description: string;
  command?: string;
  role?: string;
  status: BackgroundTaskStatus;
  result?: string;
  startedAt: string;
  completedAt?: string;
  processRef?: ChildProcess;
  cancel?: () => void;
}

const backgroundTasks = new Map<string, BackgroundTaskRecord>();

/** What a running command has printed so far is kept up to here (its end, the newest part). */
const MAX_PARTIAL_CHARS = 16_000;

const changeListeners = new Set<() => void>();

/** Called when a task starts, ends or is killed. Returns the unsubscribe function. */
export function onBackgroundTasksChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // A listener of the interface must never break a task.
    }
  }
}

// Finished (non-running) records are never removed otherwise, so a long-lived session
// running many background commands/subagents would grow this map without bound.
const MAX_FINISHED_TASKS = 200;

function pruneFinishedTasks(): void {
  const finishedIds = [...backgroundTasks.entries()]
    .filter(([, t]) => t.status !== "running")
    .map(([id]) => id);
  const excess = finishedIds.length - MAX_FINISHED_TASKS;
  if (excess <= 0) return;
  // Map preserves insertion order, so the oldest finished tasks are pruned first.
  for (const id of finishedIds.slice(0, excess)) backgroundTasks.delete(id);
}

export function registerBackgroundTask(task: BackgroundTaskRecord): void {
  backgroundTasks.set(task.id, task);
  notifyChange();
}

export function settleBackgroundTask(
  id: string,
  status: Extract<BackgroundTaskStatus, "completed" | "failed">,
  result: string
): void {
  const task = backgroundTasks.get(id);
  if (!task || task.status !== "running") return;
  task.status = status;
  task.result = result;
  task.completedAt = new Date().toISOString();
  pruneFinishedTasks();
  notifyChange();
}

export function startBackgroundCommand(command: string, cwd: string = process.cwd(), timeout = 300000): string {
  timeout = Number.isFinite(timeout) ? Math.min(3_600_000, Math.max(1_000, Math.floor(timeout))) : 300_000;
  const taskId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const taskRecord: BackgroundTaskRecord = {
    id: taskId,
    type: "command",
    description: `Comando: ${command}`,
    command,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  backgroundTasks.set(taskId, taskRecord);
  let child: ChildProcess;
  try {
    const started = startShell(command, { cwd, timeout });
    child = started.child;
    // A server or a watcher never ends: its output so far must be readable while it runs.
    const keepPartial = (chunk: Buffer) => {
      if (taskRecord.status !== "running") return;
      taskRecord.result = ((taskRecord.result ?? "") + chunk.toString("utf8")).slice(-MAX_PARTIAL_CHARS);
    };
    child.stdout?.on("data", keepPartial);
    child.stderr?.on("data", keepPartial);
    void started.done.then((res) => {
      taskRecord.completedAt = new Date().toISOString();
      // The process handle is no longer useful once it exits; drop it so it can be collected.
      taskRecord.processRef = undefined;
      const stdoutBuf = res.stdout.trim();
      const stderrBuf = res.stderr.trim();

      let finalOutput = stdoutBuf;
      if (stderrBuf) {
        finalOutput += (finalOutput ? "\n--- STDERR ---\n" : "") + stderrBuf;
      }

      if (taskRecord.status === "killed") return;

      const failure = describeFailure(res, timeout);
      if (failure) {
        taskRecord.status = "failed";
        taskRecord.result = `Erro (${failure})\n${finalOutput}`;
      } else {
        taskRecord.status = "completed";
        taskRecord.result = finalOutput || "(Comando em background concluído sem saída)";
      }
      void log("info", `[Background Task ${taskId}] concluída com status: ${taskRecord.status}`);
      pruneFinishedTasks();
      notifyChange();
    });
  } catch (error) {
    taskRecord.status = "failed";
    taskRecord.completedAt = new Date().toISOString();
    taskRecord.result = `Erro ao iniciar processo: ${error instanceof Error ? error.message : String(error)}`;
    notifyChange();
    return taskId;
  }

  taskRecord.processRef = child;
  notifyChange();
  log("info", `[Background Task ${taskId}] iniciada: ${command}`);

  return taskId;
}

export function listBackgroundTasks(): Omit<BackgroundTaskRecord, "processRef" | "cancel">[] {
  return Array.from(backgroundTasks.values()).map(({ processRef, cancel, ...rest }) => rest);
}

export function getBackgroundTask(id: string): Omit<BackgroundTaskRecord, "processRef" | "cancel"> | undefined {
  const task = backgroundTasks.get(id);
  if (!task) return undefined;
  const { processRef, cancel, ...rest } = task;
  return rest;
}

/**
 * Ends every running task, for a front end that is closing: `process.exit` would otherwise
 * leave the commands running as orphans. Resolves when their process trees are gone.
 */
export async function killAllBackgroundTasks(): Promise<void> {
  const kills: Promise<void>[] = [];
  for (const task of backgroundTasks.values()) {
    if (task.status !== "running") continue;
    if (task.processRef) kills.push(killProcessTree(task.processRef));
    try {
      task.cancel?.();
    } catch {
      // Best effort cancellation
    }
    task.status = "killed";
    task.completedAt = new Date().toISOString();
    task.result = "(Processo em background interrompido ao fechar o aplicativo)";
  }
  notifyChange();
  await Promise.allSettled(kills);
}

export function killBackgroundTask(id: string): { success: boolean; message: string } {
  const task = backgroundTasks.get(id);
  if (!task) {
    return { success: false, message: `Tarefa com ID '${id}' não encontrada.` };
  }

  if (task.status !== "running") {
    return { success: false, message: `A tarefa '${id}' já foi concluída/encerrada com status '${task.status}'.` };
  }

  if (task.processRef) {
    // killProcessTree runs `taskkill /T` before killing the parent, so child processes
    // started by the command are not orphaned.
    killProcessTree(task.processRef);
  }
  try {
    task.cancel?.();
  } catch {
    // Best effort cancellation
  }

  task.status = "killed";
  task.completedAt = new Date().toISOString();
  const partial = task.type === "command" && task.result ? `\n${task.result}` : "";
  task.result = `(Processo em background interrompido pelo usuário)${partial}`;
  pruneFinishedTasks();
  notifyChange();

  return { success: true, message: `Tarefa em background '${id}' foi encerrada com sucesso.` };
}
