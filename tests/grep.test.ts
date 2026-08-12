import { describe, expect, test } from "bun:test";
import { searchContent } from "../src/grep.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src");

describe("grep", () => {
  test("searchContent finds matches with literal text", async () => {
    const matches = await searchContent({
      basePath: srcDir,
      pattern: "siliconflower",
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  test("searchContent handles invalid regex gracefully without throwing", async () => {
    const matches = await searchContent({
      basePath: srcDir,
      pattern: "[invalid(regex*",
    });
    expect(Array.isArray(matches)).toBe(true);
  });
});
