import { exec, ChildProcess } from "node:child_process";
import { log } from "../logger.js";

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
}

const backgroundTasks = new Map<string, BackgroundTaskRecord>();

export function registerBackgroundTask(task: BackgroundTaskRecord): void {
  backgroundTasks.set(task.id, task);
}

export function startBackgroundCommand(command: string, cwd: string = process.cwd(), timeout = 300000): string {
  const taskId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : process.env.SHELL || "/bin/bash";

  const taskRecord: BackgroundTaskRecord = {
    id: taskId,
    type: "command",
    description: `Comando: ${command}`,
    command,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  let stdoutBuf = "";
  let stderrBuf = "";

  const child = exec(command, { cwd, shell, windowsHide: true, timeout }, (error, stdout, stderr) => {
    taskRecord.completedAt = new Date().toISOString();
    stdoutBuf = stdout ? stdout.trim() : "";
    stderrBuf = stderr ? stderr.trim() : "";

    let finalOutput = stdoutBuf;
    if (stderrBuf) {
      finalOutput += (finalOutput ? "\n--- STDERR ---\n" : "") + stderrBuf;
    }

    if (error) {
      if (taskRecord.status !== "killed") {
        taskRecord.status = "failed";
        taskRecord.result = `Erro (${error.code || error.signal || "falha"}): ${error.message}\n${finalOutput}`;
      }
    } else {
      taskRecord.status = "completed";
      taskRecord.result = finalOutput || "(Comando em background concluído sem saída)";
    }
    log("info", `[Background Task ${taskId}] concluída com status: ${taskRecord.status}`);
  });

  taskRecord.processRef = child;
  backgroundTasks.set(taskId, taskRecord);
  log("info", `[Background Task ${taskId}] iniciada: ${command}`);

  return taskId;
}

export function listBackgroundTasks(): Omit<BackgroundTaskRecord, "processRef">[] {
  return Array.from(backgroundTasks.values()).map(({ processRef, ...rest }) => rest);
}

export function getBackgroundTask(id: string): Omit<BackgroundTaskRecord, "processRef"> | undefined {
  const task = backgroundTasks.get(id);
  if (!task) return undefined;
  const { processRef, ...rest } = task;
  return rest;
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
    try {
      task.processRef.kill("SIGTERM");
      if (process.platform === "win32" && task.processRef.pid) {
        exec(`taskkill /pid ${task.processRef.pid} /T /F`);
      }
    } catch {
      // Best effort kill
    }
  }

  task.status = "killed";
  task.completedAt = new Date().toISOString();
  task.result = "(Processo em background interrompido pelo usuário)";

  return { success: true, message: `Tarefa em background '${id}' foi encerrada com sucesso.` };
}
