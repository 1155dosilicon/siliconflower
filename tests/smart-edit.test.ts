import { describe, expect, test, afterEach } from "bun:test";
import { smartEditFile } from "../src/services/smart-edit.js";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("smart edit service", () => {
  const testFile = join(tmpdir(), `smart_edit_test_${Date.now()}.txt`);

  afterEach(async () => {
    try {
      await rm(testFile, { force: true });
    } catch {}
  });

  test("edits exact matching text in file", async () => {
    const initial = "function add(a, b) {\n  return a + b;\n}\n";
    await writeFile(testFile, initial, "utf8");

    const res = await smartEditFile({
      path: testFile,
      oldText: "return a + b;",
      newText: "return Number(a) + Number(b);",
    });
    expect(res.isError).toBe(false);
    expect(res.matchType).toBe("exact");

    const content = await readFile(testFile, "utf8");
    expect(content).toContain("return Number(a) + Number(b);");
  });

  test("edits matching text with different newline conventions (CRLF vs LF)", async () => {
    const initial = "line 1\r\nline 2\r\nline 3\r\n";
    await writeFile(testFile, initial, "utf8");

    // LLM sends LF only
    const res = await smartEditFile({
      path: testFile,
      oldText: "line 2\nline 3",
      newText: "line 2 modified\nline 3",
    });
    expect(res.isError).toBe(false);

    const content = await readFile(testFile, "utf8");
    expect(content).toContain("line 2 modified");
  });

  test("edits matching text with fuzzy whitespace indentation", async () => {
    const initial = "    const x = 10;\n    const y = 20;\n";
    await writeFile(testFile, initial, "utf8");

    // LLM sends with 2 spaces instead of 4
    const res = await smartEditFile({
      path: testFile,
      oldText: "  const x = 10;\n  const y = 20;",
      newText: "  const x = 100;\n  const y = 200;",
    });
    expect(res.isError).toBe(false);

    const content = await readFile(testFile, "utf8");
    expect(content).toContain("100");
  });

  test("rejects when oldText is not found in file", async () => {
    const initial = "hello world\n";
    await writeFile(testFile, initial, "utf8");

    const res = await smartEditFile({
      path: testFile,
      oldText: "non_existent_text",
      newText: "new text",
    });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("não encontrado");
  });
});
