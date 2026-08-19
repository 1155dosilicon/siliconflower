import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

/**
 * Lists all active git worktrees for the current repository.
 */
export async function listWorktrees(cwd: string = process.cwd()): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd, windowsHide: true });
    const lines = stdout.split("\n");
    const worktrees: WorktreeInfo[] = [];

    let currentPath = "";
    let currentHead = "";
    let currentBranch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.substring(9).trim();
      } else if (line.startsWith("HEAD ")) {
        currentHead = line.substring(5).trim();
      } else if (line.startsWith("branch ")) {
        currentBranch = line.substring(7).trim().replace("refs/heads/", "");
      } else if (line.trim() === "") {
        if (currentPath) {
          worktrees.push({ path: currentPath, head: currentHead, branch: currentBranch });
          currentPath = "";
          currentHead = "";
          currentBranch = "";
        }
      }
    }

    if (currentPath) {
      worktrees.push({ path: currentPath, head: currentHead, branch: currentBranch });
    }

    return worktrees;
  } catch (e) {
    return [];
  }
}

/**
 * Creates and enters a new git worktree for isolated work.
 */
export async function enterWorktree(
  branchName: string,
  cwd: string = process.cwd()
): Promise<{ result: string; isError: boolean; worktreePath?: string }> {
  const safeBranch = branchName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeBranch || !/[a-zA-Z0-9]/.test(safeBranch)) {
    return { result: "Nome de branch inválido para criação do worktree.", isError: true };
  }
  const targetDir = join(cwd, ".worktrees", safeBranch);

  try {
    await execFileAsync("git", ["worktree", "add", "-b", safeBranch, targetDir], { cwd, windowsHide: true });
    await log("info", `enterWorktree: ${targetDir}`);

    return {
      result: `Worktree criado e ativado com sucesso em: ${targetDir} na branch: ${safeBranch}`,
      isError: false,
      worktreePath: targetDir,
    };
  } catch (e: any) {
    return {
      result: `Erro ao criar worktree: ${e.message || String(e)}`,
      isError: true,
    };
  }
}

/**
 * Removes an active git worktree.
 */
export async function exitWorktree(
  worktreePath: string,
  force: boolean = false,
  cwd: string = process.cwd()
): Promise<{ result: string; isError: boolean }> {
  try {
    const requestedPath = resolve(cwd, worktreePath);
    const worktrees = await listWorktrees(cwd);
    const registered = worktrees.find((tree) => resolve(tree.path).toLowerCase() === requestedPath.toLowerCase());
    if (!registered) {
      return { result: `Worktree não registrado neste repositório: ${requestedPath}`, isError: true };
    }
    const args = ["worktree", "remove", requestedPath];
    if (force) args.push("--force");
    await execFileAsync("git", args, { cwd, windowsHide: true });
    await log("info", `exitWorktree: ${requestedPath}`);

    return {
      result: `Worktree ${requestedPath} removido com sucesso.`,
      isError: false,
    };
  } catch (e: any) {
    return {
      result: `Erro ao remover worktree: ${e.message || String(e)}`,
      isError: true,
    };
  }
}
