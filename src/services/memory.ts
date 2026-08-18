import { readFile, writeFile, unlink, readdir, access } from "fs/promises";
import { join, resolve } from "path";
import { ensureDir, getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  scope: MemoryScope;
  content: string;
  updatedAt: string;
}

export function getGlobalMemoryDir(): string {
  return join(getGlobalDataDir(), "memory");
}

export function getProjectMemoryDir(cwd: string = process.cwd()): string {
  return join(getWorkspaceDataDir(cwd), "memory");
}

export function getLegacyProjectMemoryDir(cwd: string = process.cwd()): string {
  return join(cwd, ".siliconflower", "memory");
}

/**
 * Saves or updates a persistent memory entry.
 * Project memories are saved in ~/.siliconflower/workspaces/<workspace-id>/memory/
 * Global memories are saved in ~/.siliconflower/memory/
 */
export async function saveMemory(
  entry: Omit<MemoryEntry, "updatedAt">,
  cwd: string = process.cwd()
): Promise<{ message: string; path: string }> {
  const dir = entry.scope === "global" ? getGlobalMemoryDir() : getProjectMemoryDir(cwd);
  await ensureDir(dir);

  const fileName = `${entry.name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}.md`;
  const filePath = join(dir, fileName);
  const now = new Date().toISOString().split("T")[0];

  const fileContent = `---
name: ${entry.name}
type: ${entry.type}
scope: ${entry.scope}
description: ${entry.description}
updatedAt: ${now}
---

${entry.content.trim()}
`;

  await writeFile(filePath, fileContent, "utf8");

  // Update MEMORY.md index
  await updateMemoryIndex(dir);

  return {
    message: `Memória '${entry.name}' salva com sucesso em escopo [${entry.scope}].`,
    path: filePath,
  };
}

/**
 * Updates the MEMORY.md index file in the given memory directory.
 */
async function updateMemoryIndex(dir: string): Promise<void> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

    let indexContent = `# Memórias Ativas\n\n`;
    for (const file of mdFiles) {
      const filePath = join(dir, file);
      const raw = await readFile(filePath, "utf8");
      const nameMatch = raw.match(/^name:\s*(.+)$/m);
      const descMatch = raw.match(/^description:\s*(.+)$/m);
      const typeMatch = raw.match(/^type:\s*(.+)$/m);

      const name = nameMatch ? nameMatch[1].trim() : file;
      const desc = descMatch ? descMatch[1].trim() : "Sem descrição";
      const type = typeMatch ? typeMatch[1].trim() : "general";

      indexContent += `- [${name}](${file}) [${type}] — ${desc}\n`;
    }

    await writeFile(join(dir, "MEMORY.md"), indexContent, "utf8");
  } catch (e) {
    // Ignore index update error
  }
}

/**
 * Recalls all memories matching a search query or scope.
 */
export async function recallMemories(
  query?: string,
  cwd: string = process.cwd()
): Promise<MemoryEntry[]> {
  const memories: MemoryEntry[] = [];
  const seenNames = new Set<string>();

  const globalDir = getGlobalMemoryDir();
  const projectDir = getProjectMemoryDir(cwd);
  const legacyDir = getLegacyProjectMemoryDir(cwd);

  const candidateDirs: { dir: string; scope: MemoryScope }[] = [
    { dir: globalDir, scope: "global" },
    { dir: projectDir, scope: "project" },
  ];

  // Check if legacy directory exists in cwd
  try {
    await access(legacyDir);
    if (resolve(legacyDir) !== resolve(projectDir) && resolve(legacyDir) !== resolve(globalDir)) {
      candidateDirs.push({ dir: legacyDir, scope: "project" });
    }
  } catch {}

  for (const { dir, scope } of candidateDirs) {
    try {
      await ensureDir(dir);
      const files = await readdir(dir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

      for (const file of mdFiles) {
        const raw = await readFile(join(dir, file), "utf8");

        const nameMatch = raw.match(/^name:\s*(.+)$/m);
        const typeMatch = raw.match(/^type:\s*(.+)$/m);
        const descMatch = raw.match(/^description:\s*(.+)$/m);
        const dateMatch = raw.match(/^updatedAt:\s*(.+)$/m);

        const content = raw.replace(/^---[\s\S]*?---/, "").trim();
        const entryName = nameMatch ? nameMatch[1].trim() : file.replace(".md", "");

        // Avoid duplicates across legacy and new workspace directories
        const key = `${scope}:${entryName.toLowerCase()}`;
        if (seenNames.has(key)) continue;
        seenNames.add(key);

        const entry: MemoryEntry = {
          name: entryName,
          type: (typeMatch ? typeMatch[1].trim() : "feedback") as MemoryType,
          description: descMatch ? descMatch[1].trim() : "",
          scope,
          content,
          updatedAt: dateMatch ? dateMatch[1].trim() : "",
        };

        if (query) {
          const q = query.toLowerCase();
          const match =
            entry.name.toLowerCase().includes(q) ||
            entry.description.toLowerCase().includes(q) ||
            entry.content.toLowerCase().includes(q);
          if (match) memories.push(entry);
        } else {
          memories.push(entry);
        }
      }
    } catch (e) {
      // Memory dir doesn't exist yet
    }
  }

  return memories;
}

/**
 * Forgets (deletes) a specific memory.
 */
export async function forgetMemory(
  name: string,
  cwd: string = process.cwd()
): Promise<{ message: string; isError: boolean }> {
  const fileName = `${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}.md`;

  const globalPath = join(getGlobalMemoryDir(), fileName);
  const projectPath = join(getProjectMemoryDir(cwd), fileName);
  const legacyPath = join(getLegacyProjectMemoryDir(cwd), fileName);

  let deleted = false;

  try {
    await unlink(projectPath);
    await updateMemoryIndex(getProjectMemoryDir(cwd));
    deleted = true;
  } catch (e) {}

  try {
    await unlink(globalPath);
    await updateMemoryIndex(getGlobalMemoryDir());
    deleted = true;
  } catch (e) {}

  try {
    await unlink(legacyPath);
    await updateMemoryIndex(getLegacyProjectMemoryDir(cwd));
    deleted = true;
  } catch (e) {}

  if (deleted) {
    return { message: `Memória '${name}' removida com sucesso.`, isError: false };
  } else {
    return { message: `Memória '${name}' não encontrada.`, isError: true };
  }
}

/**
 * Builds the system prompt segment for loaded active memories.
 */
export async function buildMemorySystemPrompt(cwd: string = process.cwd()): Promise<string> {
  const memories = await recallMemories(undefined, cwd);
  if (memories.length === 0) return "";

  let prompt = `\n# Memória Persistente do Usuário e Projeto\n\n`;
  for (const m of memories) {
    prompt += `## [${m.type.toUpperCase()}] ${m.name} (${m.scope})\n`;
    prompt += `${m.content}\n\n`;
  }

  return prompt.trim();
}
