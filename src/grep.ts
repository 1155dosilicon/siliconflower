import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

interface GrepOptions {
  basePath: string;
  pattern: string;
  includePattern?: string;
  maxMatches?: number;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "bin",
  ".vscode",
  ".idea",
]);

function matchesGlob(filename: string, pattern?: string): boolean {
  if (!pattern || pattern === "*") return true;
  const cleanPattern = pattern.replace(/^\*\./, "");
  return filename.endsWith(`.${cleanPattern}`) || filename.includes(cleanPattern);
}

export async function searchContent(opts: GrepOptions): Promise<GrepMatch[]> {
  const { basePath, pattern, includePattern, maxMatches = 200 } = opts;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, "i");
  }
  const matches: GrepMatch[] = [];

  async function walk(dir: string) {
    if (matches.length >= maxMatches) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (includePattern && !matchesGlob(entry.name, includePattern)) {
          continue;
        }

        // Avoid binary files / large files
        try {
          const st = await stat(fullPath);
          if (st.size > 2 * 1024 * 1024) continue; // Skip files > 2MB

          const content = await readFile(fullPath, "utf8");
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: fullPath,
                line: i + 1,
                content: lines[i].trim().slice(0, 300),
              });
              if (matches.length >= maxMatches) break;
            }
          }
        } catch {
          // Ignore unreadable/binary files
        }
      }
    }
  }

  await walk(resolve(basePath));
  return matches;
}
