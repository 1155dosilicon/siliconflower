import { describe, expect, test } from "bun:test";
import { builtinToolsAsMcp, isBuiltin, runBuiltin, BUILTIN_TOOLS } from "../src/tools.js";
import { parse } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("tools", () => {
  test("isBuiltin recognizes builtin tools", () => {
    expect(isBuiltin("read_file")).toBe(true);
    expect(isBuiltin("write_file")).toBe(true);
    expect(isBuiltin("execute_command")).toBe(true);
    expect(isBuiltin("unknown_tool")).toBe(false);
  });

  test("builtinToolsAsMcp returns all tools in MCP schema format", () => {
    const list = builtinToolsAsMcp();
    expect(list.length).toBe(BUILTIN_TOOLS.length);
    expect(list.every((t) => t.server === "builtin")).toBe(true);
  });

  test("delete_path enforces confirm requirement", async () => {
    const res = await runBuiltin("delete_path", { path: "some_file.txt", confirm: false });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("confirmação");
  });

  test("delete_path refuses filesystem roots even with confirmation", async () => {
    const res = await runBuiltin("delete_path", { path: parse(process.cwd()).root, recursive: true, confirm: true });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("caminho crítico");
  });

  test("blocked paths prevent access to system directories", async () => {
    const blocked = process.platform === "win32"
      ? "C:\\Windows\\System32\\config\\SAM"
      : "/etc/passwd";
    const res = await runBuiltin("read_file", { path: blocked });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("bloqueado");
  });

  test("recursive search tools cannot bypass sensitive path guards", async () => {
    const sensitivePath = join(tmpdir(), ".ssh");
    const grepRes = await runBuiltin("grep_content", { path: sensitivePath, pattern: "secret" });
    const listRes = await runBuiltin("list_directory", { path: sensitivePath });
    expect(grepRes.isError).toBe(true);
    expect(listRes.isError).toBe(true);
  });

  test("execute_command runs shell commands and returns output", async () => {
    const cmd = process.platform === "win32"
      ? "Write-Output 'hello siliconflower'"
      : "echo 'hello siliconflower'";
    const res = await runBuiltin("execute_command", { command: cmd });
    expect(res.isError).toBe(false);
    expect(res.result).toContain("hello siliconflower");
  });

  test("edit_file rejects empty oldText", async () => {
    const res = await runBuiltin("edit_file", { path: "package.json", oldText: "", newText: "foo" });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("oldText não pode ser vazio");
  });

  test("apply_patch rejects empty oldText in changes", async () => {
    const res = await runBuiltin("apply_patch", { path: "package.json", changes: [{ oldText: "", newText: "foo" }] });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("oldText não pode ser vazio");
  });

  test("memory and artifact check the fields of each action", async () => {
    for (const [name, args, expected] of [
      ["memory", { action: "save", name: "x" }, "type, description, content"],
      ["memory", { action: "forget" }, "name"],
      ["memory", { action: "apagar" }, "action inválida"],
      ["memory", {}, "action inválida"],
      ["artifact", { action: "create", id: "x" }, "title, type, content, summary"],
      ["artifact", { action: "read" }, "id"],
      ["artifact", { action: "delete" }, "id"],
      ["artifact", {}, "action inválida"],
    ] as const) {
      const res = await runBuiltin(name, args);
      expect(res.isError).toBe(true);
      expect(res.result).toContain(expected);
    }
  });

  test("artifact goes through its whole cycle in one tool", async () => {
    const id = `teste_${Date.now()}`;
    const fields = { id, title: "T", type: "markdown", content: "corpo do artefato", summary: "S", scope: "global" };
    expect((await runBuiltin("artifact", { action: "create", ...fields })).isError).toBe(false);
    expect((await runBuiltin("artifact", { action: "read", id })).result).toContain("corpo do artefato");
    expect((await runBuiltin("artifact", { action: "list" })).result).toContain(id);
    expect((await runBuiltin("artifact", { action: "delete", id, scope: "global" })).isError).toBe(false);
    expect((await runBuiltin("artifact", { action: "read", id })).isError).toBe(true);
  });

  test("memory goes through its whole cycle in one tool", async () => {
    const name = `teste_${Date.now()}`;
    const fields = { name, type: "reference", description: "D", content: "conteudo da memoria", scope: "global" };
    expect((await runBuiltin("memory", { action: "save", ...fields })).isError).toBe(false);
    expect((await runBuiltin("memory", { action: "recall", query: name })).result).toContain("conteudo da memoria");
    expect((await runBuiltin("memory", { action: "forget", name, scope: "global" })).isError).toBe(false);
    expect((await runBuiltin("memory", { action: "recall", query: name })).result).toContain("Nenhuma memória");
  });

  describe("onEdit hook", () => {
    const win = process.platform === "win32";
    const config = (onEdit: string) => ({ baseURL: "http://x/v1", apiKey: "k", model: "m", reasoning: "none" as const, hooks: { onEdit } });
    const write = (onEdit: string) =>
      runBuiltin("write_file", { path: join(tmpdir(), `sf-hook-${Date.now()}.txt`), content: "x" }, { config: config(onEdit) });

    test("its output reaches the model", async () => {
      const res = await write(win ? "Write-Output 'erro de tipo na linha 3'" : "echo 'erro de tipo na linha 3'");
      expect(res.isError).toBe(false);
      expect(res.result).toContain("Arquivo escrito");
      expect(res.result).toContain("--- Hook onEdit ---");
      expect(res.result).toContain("erro de tipo na linha 3");
    });

    test("a failing check does not turn the edit into an error", async () => {
      const res = await write(win ? "Write-Output 'falhou aqui'; exit 3" : "echo 'falhou aqui'; exit 3");
      expect(res.isError).toBe(false);
      expect(res.result).toContain("Hook onEdit falhou");
      expect(res.result).toContain("falhou aqui");
    });

    test("a silent check adds nothing", async () => {
      const res = await write(win ? "$null = 1" : "true");
      expect(res.result).not.toContain("Hook onEdit");
    });

    test("a long output is cut", async () => {
      const res = await write(win ? "'y' * 20000" : "head -c 20000 /dev/zero | tr '\\0' y");
      expect(res.result.length).toBeLessThan(9000);
      expect(res.result).toContain("TRUNCADA");
    });
  });

  test("todowrite normalizes status and priority synonyms", async () => {
    const res = await runBuiltin("todowrite", {
      todos: [
        { content: "Task 1", status: "done", priority: "HIGH" },
        { content: "Task 2", status: "in-progress", priority: "LOW" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.result).toContain("2 itens");
  });
});
