import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";
import { BUILTIN_TOOLS } from "../src/tools.js";
import { SKILL_TOOL } from "../src/skills.js";

// Agents (and people) forget to update the docs when the code changes. These checks turn
// the facts that drift most often into failing tests, so CI catches them.

const root = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const toolNames = [...BUILTIN_TOOLS.map((tool) => tool.name), SKILL_TOOL.name];

describe("docs in sync with the code", () => {
  test("README version badge matches package.json", () => {
    const badge = read("README.md").match(/badge\/version-([0-9][^-]*)-/);
    expect(badge?.[1]).toBe(packageJson.version);
  });

  test("CHANGELOG has a section for the current version", () => {
    expect(read("CHANGELOG.md")).toContain(`## [${packageJson.version}]`);
  });

  test("README tool count matches the native tools", () => {
    const count = read("README.md").match(/\*\*(\d+) ferramentas nativas\*\*/);
    expect(Number(count?.[1])).toBe(toolNames.length);
  });

  test("every CLI command is in the README", () => {
    const commands = [...read("src/index.tsx").matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]!);
    const readme = read("README.md");
    const missing = [...new Set(commands)].filter((name) => !new RegExp(`siliconflower[^\\n]*\\b${name}\\b`).test(readme));
    expect(missing).toEqual([]);
  });

  test("every native tool is listed in the README and in ARCHITECTURE", () => {
    const readme = read("README.md");
    const architecture = read("docs/ARCHITECTURE.md");
    const missing = toolNames.filter((name) => !readme.includes(`\`${name}\``) || !architecture.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
