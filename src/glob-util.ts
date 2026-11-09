import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathBlocked } from "./fs-util.js";

/** Splits `a,b{c,d}` at the commas outside nested braces. */
function splitAlternatives(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Index of the "}" that closes the "{" at `open`, or -1. */
function closingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Regex source for a glob, without anchors. Each alternative inside braces is a glob too. */
function globSource(pattern: string): string {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = closingBrace(pattern, i);
      if (end !== -1) {
        re += `(?:${splitAlternatives(pattern.slice(i + 1, end)).map(globSource).join("|")})`;
        i = end + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      } else {
        re += "\\[";
        i++;
      }
    } else if (".+()^$|\\{}".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return re;
}

export function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`);
}

/** `signal` stops the walk: from a big folder it can take minutes. */
export async function search(root: string, pattern: string, includeHidden = false, signal?: AbortSignal): Promise<string[]> {
  const base = await safeStat(root);
  if (!base || !base.isDirectory()) {
    return [];
  }
  const results: string[] = [];
  const re = globToRegex(pattern);
  const limit = 1000;

  async function walk(dir: string, depth: number) {
    if (results.length >= limit || signal?.aborted) return;
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit || signal?.aborted) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (!includeHidden && e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      // Not even the names inside /etc, .ssh, System32...: the same rule as the path given.
      if (isPathBlocked(full)) continue;
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
