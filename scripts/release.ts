// Prepares a release in one step, so no file is forgotten:
//   bun run release 0.11.0
// Bumps package.json, desktop/package.json, src/version.ts and the README badge, and turns
// CHANGELOG's [Unreleased] into the new version's section. It does not commit nor tag: it
// prints what changed since the last tag, for the docs review, and the commands to run.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SEMVER = /^\d+\.\d+\.\d+$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** Text of the [Unreleased] section, without its heading. */
export function unreleasedBody(changelog: string): string {
  const match = changelog.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m);
  return match ? match[1]!.trim() : "";
}

/** Text of a version's section, without its heading; empty when there is none. */
export function sectionBody(changelog: string, version: string): string {
  const escaped = version.replace(/\./g, "\\.");
  const match = changelog.match(new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |(?![\\s\\S]))`, "m"));
  return match ? match[1]!.trim() : "";
}

/** Moves [Unreleased] into a new section for `version`, leaving [Unreleased] empty. */
export function promoteChangelog(changelog: string, version: string, date: string): string {
  return changelog.replace(/^## \[Unreleased\][^\n]*\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`);
}

export function bumpFiles(files: Record<string, string>, from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    let next = text;
    if (path.endsWith("package.json")) next = text.replace(`"version": "${from}"`, `"version": "${to}"`);
    else if (path.endsWith("version.ts")) next = text.replace(`"${from}"`, `"${to}"`);
    else if (path.endsWith("README.md")) next = text.replace(`badge/version-${from}-`, `badge/version-${to}-`);
    if (next === text) throw new Error(`versao ${from} nao encontrada em ${path}`);
    out[path] = next;
  }
  return out;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function main(): void {
  const root = join(import.meta.dir, "..");
  const to = process.argv[2] ?? "";
  const from = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
  };

  if (!SEMVER.test(to)) fail("Uso: bun run release <versao>, por exemplo 0.11.0");
  if (compareVersions(to, from) <= 0) fail(`A versao nova (${to}) precisa ser maior que a atual (${from}).`);
  if (git(["status", "--porcelain"])) fail("Ha mudancas sem commit. Faca o commit antes de preparar a release.");

  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  if (!unreleasedBody(changelog)) fail("A secao [Unreleased] do CHANGELOG.md esta vazia: nada para lancar.");

  const paths = ["package.json", "desktop/package.json", "src/version.ts", "README.md"];
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(join(root, p), "utf8")]));
  const bumped = bumpFiles(files, from, to);
  for (const [p, text] of Object.entries(bumped)) writeFileSync(join(root, p), text);
  writeFileSync(changelogPath, promoteChangelog(changelog, to, new Date().toISOString().slice(0, 10)));

  const lastTag = git(["describe", "--tags", "--abbrev=0"]);
  console.log(`Versao ${from} -> ${to}: ${[...paths, "CHANGELOG.md"].join(", ")}.`);
  if (lastTag) {
    console.log(`\nCodigo alterado desde ${lastTag}:`);
    console.log(git(["diff", "--stat", lastTag, "HEAD", "--", "src", "desktop/src", "scripts"]) || "(nada)");
    console.log(`\nDocs alteradas desde ${lastTag}:`);
    console.log(git(["diff", "--stat", lastTag, "HEAD", "--", "README.md", "docs", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md"]) || "(nenhuma)");
  }
  console.log(`
Antes do commit, confira se README, docs/ARCHITECTURE.md, docs/PLATAFORMAS.md e SECURITY.md
descrevem o que mudou no codigo acima. Depois:

  bun run typecheck && bun test
  git commit -am "release ${to}"
  git tag v${to} && git push origin main v${to}`);
}

if (import.meta.main) main();
