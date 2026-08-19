import { join, resolve } from "node:path";
import { writeFile, readFile, readdir, rm, access } from "node:fs/promises";
import { ensureDir, getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";
import { log } from "../logger.js";

export type ArtifactType = "markdown" | "code" | "mermaid" | "html" | "json";

export interface ArtifactMetadata {
  id: string;
  title: string;
  type: ArtifactType;
  summary: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export function getArtifactsDir(cwd: string = process.cwd(), scope: "project" | "global" = "project"): string {
  if (scope === "project") {
    return join(getWorkspaceDataDir(cwd), "artifacts");
  }
  return join(getGlobalDataDir(), "artifacts");
}

export function getLegacyArtifactsDir(cwd: string = process.cwd()): string {
  return join(cwd, ".siliconflower", "artifacts");
}

export async function createArtifact(opts: {
  id: string;
  title: string;
  type: ArtifactType;
  content: string;
  summary: string;
  scope?: "project" | "global";
  cwd?: string;
}): Promise<{ artifact: ArtifactMetadata; message: string }> {
  const scope = opts.scope || "project";
  const dir = getArtifactsDir(opts.cwd, scope);
  await ensureDir(dir);

  const safeId = opts.id.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
  const ext = opts.type === "markdown" || opts.type === "mermaid" ? "md" : opts.type === "html" ? "html" : opts.type === "json" ? "json" : "txt";
  const fileName = `${safeId}.${ext}`;
  const filePath = join(dir, fileName);

  const now = new Date().toISOString();
  
  // Format artifact file content with metadata header
  const header = `---
title: "${opts.title}"
type: "${opts.type}"
summary: "${opts.summary.replace(/"/g, '\\"')}"
updatedAt: "${now}"
---

`;

  const fullContent = opts.type === "markdown" || opts.type === "mermaid" ? header + opts.content : opts.content;
  await writeFile(filePath, fullContent, "utf8");

  const meta: ArtifactMetadata = {
    id: safeId,
    title: opts.title,
    type: opts.type,
    summary: opts.summary,
    path: filePath,
    createdAt: now,
    updatedAt: now,
  };

  await log("ok", `[Artefato criado] ID: ${safeId} (${opts.title})`);
  return { artifact: meta, message: `Artefato '${safeId}' salvo com sucesso em: ${filePath}` };
}

export async function listArtifacts(cwd: string = process.cwd()): Promise<ArtifactMetadata[]> {
  const results: ArtifactMetadata[] = [];
  const seenIds = new Set<string>();

  const projectDir = getArtifactsDir(cwd, "project");
  const globalDir = getArtifactsDir(cwd, "global");
  const legacyDir = getLegacyArtifactsDir(cwd);

  const candidateDirs = [projectDir, globalDir];
  try {
    await access(legacyDir);
    candidateDirs.push(legacyDir);
  } catch {}

  const uniqueDirs = Array.from(new Set(candidateDirs.map((d) => resolve(d))));

  for (const dir of uniqueDirs) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith(".md") || f.endsWith(".html") || f.endsWith(".json") || f.endsWith(".txt")) {
          const safeId = f.replace(/\.[^/.]+$/, "").toLowerCase();
          if (seenIds.has(safeId)) continue;

          const filePath = join(dir, f);
          try {
            const raw = await readFile(filePath, "utf8");
            const matchTitle = /^title:\s*"([^"]+)"/m.exec(raw);
            const matchType = /^type:\s*"([^"]+)"/m.exec(raw);
            const matchSummary = /^summary:\s*"([^"]+)"/m.exec(raw);
            const matchUpdatedAt = /^updatedAt:\s*"([^"]+)"/m.exec(raw);

            const ext = f.split(".").pop()?.toLowerCase();
            let resolvedType: ArtifactType = "markdown";
            if (ext === "json") resolvedType = "json";
            else if (ext === "html") resolvedType = "html";
            else if (ext === "txt") resolvedType = "code";
            else if (matchType) resolvedType = matchType[1] as ArtifactType;

            seenIds.add(safeId);
            results.push({
              id: safeId,
              title: matchTitle ? matchTitle[1] : safeId,
              type: resolvedType,
              summary: matchSummary ? matchSummary[1] : "Artefato do Siliconflower",
              path: filePath,
              createdAt: matchUpdatedAt ? matchUpdatedAt[1] : new Date().toISOString(),
              updatedAt: matchUpdatedAt ? matchUpdatedAt[1] : new Date().toISOString(),
            });
          } catch {
            // Ignore unreadable artifact files
          }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  return results;
}

export async function readArtifact(id: string, cwd: string = process.cwd()): Promise<{ content: string; path: string } | null> {
  const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
  const projectDir = getArtifactsDir(cwd, "project");
  const globalDir = getArtifactsDir(cwd, "global");
  const legacyDir = getLegacyArtifactsDir(cwd);

  const candidateDirs = [projectDir, globalDir];
  try {
    await access(legacyDir);
    candidateDirs.push(legacyDir);
  } catch {}

  const uniqueDirs = Array.from(new Set(candidateDirs.map((d) => resolve(d))));

  for (const dir of uniqueDirs) {
    try {
      const files = await readdir(dir);
      const match = files.find((f) => f.replace(/\.[^/.]+$/, "").toLowerCase() === safeId);
      if (match) {
        const filePath = join(dir, match);
        const content = await readFile(filePath, "utf8");
        return { content, path: filePath };
      }
    } catch {
      // Skip missing dir
    }
  }

  return null;
}

export async function deleteArtifact(
  id: string,
  cwd: string = process.cwd(),
  scope: "project" | "global" | "all" = "project"
): Promise<{ success: boolean; message: string }> {
  const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
  const projectDir = getArtifactsDir(cwd, "project");
  const globalDir = getArtifactsDir(cwd, "global");
  const legacyDir = getLegacyArtifactsDir(cwd);

  const candidateDirs: string[] = [];
  if (scope === "project" || scope === "all") {
    candidateDirs.push(projectDir);
    try {
      await access(legacyDir);
      candidateDirs.push(legacyDir);
    } catch {}
  }
  if (scope === "global" || scope === "all") candidateDirs.push(globalDir);

  const uniqueDirs = Array.from(new Set(candidateDirs.map((d) => resolve(d))));
  let deleted = false;

  for (const dir of uniqueDirs) {
    try {
      const files = await readdir(dir);
      const match = files.find((f) => f.replace(/\.[^/.]+$/, "").toLowerCase() === safeId);
      if (match) {
        const filePath = join(dir, match);
        await rm(filePath);
        deleted = true;
      }
    } catch {
      // Skip missing dir
    }
  }

  if (deleted) {
    return { success: true, message: `Artefato '${safeId}' removido com sucesso do escopo [${scope}].` };
  }

  return { success: false, message: `Artefato '${id}' não foi encontrado.` };
}
