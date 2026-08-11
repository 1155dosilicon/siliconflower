import { describe, expect, test } from "bun:test";
import { search } from "../src/glob-util.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src");

describe("glob-util", () => {
  test("matches files at the root with a simple pattern", async () => {
    const matches = await search(srcDir, "*.ts");
    expect(matches.some((m) => m.endsWith("glob-util.ts"))).toBe(true);
  });

  test("matches files with ** pattern at root level", async () => {
    const matches = await search(srcDir, "**/*.ts");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.endsWith("glob-util.ts"))).toBe(true);
  });

  test("matches files with brace expansion pattern", async () => {
    const matches = await search(srcDir, "*.{ts,tsx}");
    expect(matches.some((m) => m.endsWith("glob-util.ts"))).toBe(true);
    expect(matches.some((m) => m.endsWith("App.tsx"))).toBe(true);
  });

  test("returns empty for non-existent root", async () => {
    const matches = await search("Z:/__nonexistent_dir__", "*.ts");
    expect(matches).toEqual([]);
  });

  test("handles includeHidden flag", async () => {
    const projectRoot = join(srcDir, "..");
    const withoutHidden = await search(projectRoot, ".*");
    const withHidden = await search(projectRoot, ".*", true);
    expect(withHidden.length).toBeGreaterThanOrEqual(withoutHidden.length);
  });
});