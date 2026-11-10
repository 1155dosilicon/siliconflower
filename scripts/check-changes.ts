// CI check: a change to the code must come with a CHANGELOG line, and one that touches
// behavior should say whether the docs were reviewed.
//   bun scripts/check-changes.ts <base-ref>
// Fails when src/, desktop/src/ or scripts/ changed since <base-ref> and CHANGELOG.md did not.
// Commits whose message has [skip changelog] (refactors, tests) are allowed through.
import { spawnSync } from "node:child_process";

const CODE = /^(src|desktop\/src|scripts|bin)\//;
const DOCS = /^(README\.md|docs\/|SECURITY\.md|CONTRIBUTING\.md|AGENTS\.md)/;

export interface ChangeReport {
  ok: boolean;
  code: string[];
  docs: string[];
  changelog: boolean;
}

export function checkChanges(files: string[], skip: boolean): ChangeReport {
  const code = files.filter((f) => CODE.test(f));
  const docs = files.filter((f) => DOCS.test(f));
  const changelog = files.includes("CHANGELOG.md");
  return { ok: skip || code.length === 0 || changelog, code, docs, changelog };
}

function git(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { ok: result.status === 0, out: result.stdout.trim() };
}

function main(): void {
  const base = process.argv[2];
  if (!base || /^0+$/.test(base) || !git(["cat-file", "-e", `${base}^{commit}`]).ok) {
    console.log("Sem base para comparar (branch nova ou primeiro push); verificacao pulada.");
    return;
  }
  const files = git(["diff", "--name-only", `${base}...HEAD`]).out.split("\n").filter(Boolean);
  const skip = git(["log", "--format=%B", `${base}..HEAD`]).out.includes("[skip changelog]");
  const report = checkChanges(files, skip);

  if (!report.ok) {
    console.error(
      [
        "O codigo mudou, mas o CHANGELOG.md nao:",
        ...report.code.map((f) => `  ${f}`),
        "",
        "Acrescente uma linha em [Unreleased] e confira se README.md, docs/ e SECURITY.md",
        "continuam certos. Se a mudanca nao afeta ninguem (refatoracao, testes), ponha",
        "[skip changelog] na mensagem do commit.",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (report.code.length > 0 && report.docs.length === 0) {
    // A warning, not a failure: most fixes do not change what the docs say.
    console.log("::warning::O codigo mudou e nenhuma doc foi alterada. Confira README.md, docs/ e SECURITY.md.");
  }
  console.log(`OK: ${report.code.length} arquivo(s) de codigo, CHANGELOG ${report.changelog ? "atualizado" : "dispensado"}.`);
}

if (import.meta.main) main();
