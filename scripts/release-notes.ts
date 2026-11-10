// Prints the CHANGELOG section of a version, used as the body of the GitHub release:
//   bun scripts/release-notes.ts 0.11.0 > notes.md
// Fails when the section is missing or empty, so a release never goes out without notes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionBody } from "./release.js";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const body = sectionBody(readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8"), version);
if (!body) {
  console.error(`CHANGELOG.md nao tem a secao [${version}], ou ela esta vazia.`);
  process.exit(1);
}
console.log(body);
