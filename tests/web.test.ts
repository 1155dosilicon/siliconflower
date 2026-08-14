import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, webFetch } from "../src/services/web.js";

describe("web fetch and markdown conversion", () => {
  test("converts basic HTML to clean markdown", () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Main Title</h1>
          <p>This is a paragraph with <a href="https://example.com">a link</a>.</p>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
          </ul>
        </body>
      </html>
    `;

    const md = htmlToMarkdown(html);
    expect(md).toContain("# Main Title");
    expect(md).toContain("[a link](https://example.com)");
    expect(md).toContain("* Item 1");
  });

  test("handles invalid web urls gracefully", async () => {
    const res = await webFetch("https://invalid-nonexistent-domain-12345.org", { timeoutMs: 1000 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Erro ao buscar URL");
  });
});
