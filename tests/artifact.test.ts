import { describe, expect, test, afterAll } from "bun:test";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact } from "../src/services/artifact.js";

describe("artifacts service", () => {
  const testId = `test_art_${Date.now()}`;

  afterAll(async () => {
    await deleteArtifact(testId);
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
});
