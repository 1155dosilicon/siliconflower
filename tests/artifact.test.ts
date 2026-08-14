import { describe, expect, test, afterAll } from "bun:test";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact } from "../src/services/artifact.js";

describe("artifacts service", () => {
  const testId = `test_art_${Date.now()}`;
  const htmlTestId = `test_html_${Date.now()}`;
  const jsonTestId = `test_json_${Date.now()}`;

  afterAll(async () => {
    await deleteArtifact(testId);
    await deleteArtifact(htmlTestId);
    await deleteArtifact(jsonTestId);
  });

  test("creates, reads, lists and deletes artifact", async () => {
    // 1. Create
    const createRes = await createArtifact({
      id: testId,
      title: "Plano de Teste",
      type: "markdown",
      summary: "Resumo do plano de teste",
      content: "# Plano de Teste\n- Item 1\n- Item 2",
    });
    expect(createRes.artifact.id).toBe(testId);

    // 2. Read
    const readRes = await readArtifact(testId);
    expect(readRes).not.toBeNull();
    expect(readRes?.content).toContain("# Plano de Teste");

    // 3. List
    const listRes = await listArtifacts();
    expect(listRes.some((a) => a.id === testId)).toBe(true);

    // 4. Delete
    const deleteRes = await deleteArtifact(testId);
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
