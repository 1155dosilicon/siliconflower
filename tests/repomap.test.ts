import { describe, expect, test, afterEach } from "bun:test";
import { generateRepoMap, findSymbolInRepo, extractSymbols } from "../src/services/repomap.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("repomap service", () => {
  const testDir = join(tmpdir(), `repomap_test_${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  test("extractSymbols extracts function, class, and interface signatures", () => {
    const code = `
export interface UserConfig {
  name: string;
}

export class AgentManager {
  constructor() {}
}

export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`;
    const symbols = extractSymbols(code, "test.ts");
    expect(symbols.length).toBe(3);

    const names = symbols.map((s) => s.name);
    expect(names).toContain("UserConfig");
    expect(names).toContain("AgentManager");
    expect(names).toContain("calculateTotal");
  });

  test("generateRepoMap builds a structural overview of repository files", async () => {
    await mkdir(join(testDir, "src"), { recursive: true });
    await writeFile(
      join(testDir, "src", "index.ts"),
      `export function mainApp(): void { console.log("running"); }`,
      "utf8"
    );

    const map = await generateRepoMap(testDir);
    expect(map.fileCount).toBeGreaterThanOrEqual(1);
    expect(map.mapText).toContain("index.ts");
    expect(map.mapText).toContain("mainApp");
  });

  test("findSymbolInRepo finds matching symbols across files", async () => {
    await mkdir(join(testDir, "src"), { recursive: true });
    await writeFile(
      join(testDir, "src", "math.ts"),
      `export function complexMathFormula(x: number): number { return x * 2; }`,
      "utf8"
    );

    const results = await findSymbolInRepo("complexMathFormula", testDir);
    expect(results.length).toBe(1);
    expect(results[0].symbols[0].name).toBe("complexMathFormula");
    expect(results[0].symbols[0].kind).toBe("function");
  });
});
