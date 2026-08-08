import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

function expandBraces(pattern: string): string {
  return pattern.replace(/\{([^}]+)\}/g, (_, content: string) => {
    const parts = content.split(",");
    return `(?:${parts.join("|")})`;
  });
}

function globToRegex(pattern: string): RegExp {
  const expanded = expandBraces(pattern);
  let re = "^";
  let i = 0;
  while (i < expanded.length) {
    const ch = expanded[i];
    if (ch === "*" && i + 1 < expanded.length && expanded[i + 1] === "*") {
      re += ".*";
      i += 2;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "(" && expanded.startsWith("(?:", i)) {
      const end = expanded.indexOf(")", i);
      if (end !== -1) {
        re += expanded.slice(i, end + 1);
        i = end + 1;
      } else {
        re += "\\(";
        i++;
      }
    } else if (ch === "[") {
      const end = expanded.indexOf("]", i + 1);
      if (end !== -1) {
        re += expanded.slice(i, end + 1);
        i = end + 1;
      } else {
        re += "\\[";
        i++;
      }
    } else if (".+()^$|\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export async function search(root: string, pattern: string, includeHidden = false): Promise<string[]> {
  const base = await safeStat(root);
  if (!base || !base.isDirectory()) {
    return [];
  }
  const results: string[] = [];
  const re = globToRegex(pattern);
  const limit = 1000;

  async function walk(dir: string, depth: number) {
    if (results.length >= limit) return;
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (!includeHidden && e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (re.test(rel)) results.push(full);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return results;
}

async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
