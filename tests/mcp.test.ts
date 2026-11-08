import { describe, expect, test } from "bun:test";
import { mcpContentText, qualifyMcpToolName } from "../src/mcp.js";

describe("MCP tool names", () => {
  test("qualifies names deterministically without collisions", () => {
    const first = qualifyMcpToolName("filesystem", "read_file");
    expect(first).toBe(qualifyMcpToolName("filesystem", "read_file"));
    expect(first).not.toBe(qualifyMcpToolName("other", "read_file"));
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
  });
});

describe("MCP tool results", () => {
  // A screenshot came to the model as megabytes of Base64 text.
  test("images and audio become a short note; text and text resources stay", () => {
    const image = "iVBORw0KGgo".repeat(100_000);
    const text = mcpContentText([
      { type: "text", text: "linha 1" },
      { type: "image", data: image, mimeType: "image/png" },
      { type: "audio", data: "UklGR", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///a.txt", text: "conteúdo do recurso" } },
      { type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA", mimeType: "application/octet-stream" } },
    ]);
    expect(text).toContain("linha 1");
    expect(text).toContain("conteúdo do recurso");
    expect(text).toContain("imagem omitido(a) (image/png");
    expect(text).toContain("áudio omitido(a) (audio/wav");
    expect(text).toContain("file:///b.bin");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text.length).toBeLessThan(1_000);
  });
});
