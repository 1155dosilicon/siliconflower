import { describe, expect, test, afterAll } from "bun:test";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact } from "../src/services/artifact.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, rm } from "node:fs/promises";
import { getWorkspaceDataDir } from "../src/fs-util.js";

describe("artifacts service", () => {
  const testId = `test_art_${Date.now()}`;
  const htmlTestId = `test_html_${Date.now()}`;
  const jsonTestId = `test_json_${Date.now()}`;
  const customWorkspace = join(tmpdir(), `art_ws_${Date.now()}`);

  afterAll(async () => {
    await deleteArtifact(testId);
    await deleteArtifact(htmlTestId);
    await deleteArtifact(jsonTestId);
    try {
      await rm(customWorkspace, { recursive: true, force: true });
    } catch {}
    try {
      await rm(getWorkspaceDataDir(customWorkspace), { recursive: true, force: true });
    } catch {}
  });

  test("creates, reads, lists and deletes artifact in centralized workspace storage", async () => {
    // 1. Create with custom cwd
    const createRes = await createArtifact({
      id: testId,
      title: "Plano de Teste",
      type: "markdown",
      summary: "Resumo do plano de teste",
      content: "# Plano de Teste\n- Item 1\n- Item 2",
      cwd: customWorkspace,
      scope: "project",
    });
    expect(createRes.artifact.id).toBe(testId);
    expect(createRes.artifact.path).toContain(".siliconflower");
    expect(createRes.artifact.path).toContain("workspaces");

    // Check that customWorkspace has NO local .siliconflower directory
    let localExists = false;
    try {
      await access(join(customWorkspace, ".siliconflower"));
      localExists = true;
    } catch {
      localExists = false;
    }
    expect(localExists).toBe(false);

    // 2. Read
    const readRes = await readArtifact(testId, customWorkspace);
    expect(readRes).not.toBeNull();
    expect(readRes?.content).toContain("# Plano de Teste");

    // 3. List
    const listRes = await listArtifacts(customWorkspace);
    expect(listRes.some((a) => a.id === testId)).toBe(true);

    // 4. Delete
    const deleteRes = await deleteArtifact(testId, customWorkspace);
    expect(deleteRes.success).toBe(true);
  });

  test("properly infers type for non-markdown files (HTML, JSON)", async () => {
    // Create HTML artifact
    const htmlRes = await createArtifact({
      id: htmlTestId,
      title: "Página HTML",
      type: "html",
      summary: "Código HTML de teste",
      content: "<html><body><h1>Olá</h1></body></html>",
    });
    expect(htmlRes.artifact.type).toBe("html");

    // Create JSON artifact
    const jsonRes = await createArtifact({
      id: jsonTestId,
      title: "Dados JSON",
      type: "json",
      summary: "Estrutura JSON de teste",
      content: '{"ok": true}',
    });
    expect(jsonRes.artifact.type).toBe("json");

    // List and verify
    const listRes = await listArtifacts();

    const listedHtml = listRes.find((a) => a.id === htmlTestId);
    expect(listedHtml).toBeDefined();
    expect(listedHtml?.type).toBe("html");

    const listedJson = listRes.find((a) => a.id === jsonTestId);
    expect(listedJson).toBeDefined();
    expect(listedJson?.type).toBe("json");

    // Clean up
    await deleteArtifact(htmlTestId);
    await deleteArtifact(jsonTestId);
  });
});
