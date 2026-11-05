import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MAX_RECENTS = 20;

export interface RecentProject {
  path: string;
  lastOpened: string;
}

/** Identifies a folder. Windows paths are case-insensitive; Unix paths are not. */
export function folderKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const key = resolve(folder).replace(/[\\/]+$/, "");
  return platform === "win32" ? key.toLowerCase() : key;
}

/** A damaged file only costs the list: it must never keep the app from opening. */
export function loadRecents(file: string): RecentProject[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is RecentProject => typeof p?.path === "string" && typeof p?.lastOpened === "string")
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function save(file: string, recents: RecentProject[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(recents, null, 2), "utf8");
  renameSync(temp, file);
}

export function addRecent(file: string, folder: string, now = new Date()): RecentProject[] {
  const key = folderKey(folder);
  const recents = [
    { path: resolve(folder), lastOpened: now.toISOString() },
    ...loadRecents(file).filter((p) => folderKey(p.path) !== key),
  ].slice(0, MAX_RECENTS);
  save(file, recents);
  return recents;
}

export function removeRecent(file: string, folder: string): RecentProject[] {
  const key = folderKey(folder);
  const recents = loadRecents(file).filter((p) => folderKey(p.path) !== key);
  save(file, recents);
  return recents;
}
