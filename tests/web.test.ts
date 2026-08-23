import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, isPrivateAddress, parseDuckDuckGoHtml, webFetch } from "../src/services/web.js";

describe("web fetch and markdown conversion", () => {
  test("converts basic HTML to clean markdown", () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Main Title</h1>
          <p>This is a paragraph with <a href="https://example.com">a link</a> and <b>bold text</b>.</p>
          <blockquote>Important quote</blockquote>
          <pre><code>console.log("hello world");</code></pre>
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
    expect(md).toContain("**bold text**");
    expect(md).toContain("> Important quote");
    expect(md).toContain('console.log("hello world");');
    expect(md).toContain("* Item 1");
  });

  test("handles invalid web urls gracefully", async () => {
    const res = await webFetch("https://invalid-nonexistent-domain-12345.org", { timeoutMs: 1000 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Erro ao buscar URL");
  });

  test("blocks local and private network destinations while allowing public IPs", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("192.168.1.50")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    
    // Public CDN / Cloud IPs must NOT be blocked (e.g. Automattic/WordPress VIP, Google DNS, Cloudflare)
    expect(isPrivateAddress("192.0.66.220")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);

    const res = await webFetch("http://127.0.0.1/internal");
    expect(res.isError).toBe(true);
    expect(res.content).toContain("não é permitido");
  });

  test("parses duckduckgo html search results properly", () => {
    const sampleHtml = `
      <div class="results">
        <div class="result results_links results_links_deep web-result">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=123">
                Example <b>Article</b> Title
              </a>
            </h2>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">
              This is the snippet description for example article.
            </a>
          </div>
        </div>
      </div>
    `;

    const results = parseDuckDuckGoHtml(sampleHtml, 5);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Example Article Title");
    expect(results[0].url).toBe("https://example.com/article");
    expect(results[0].snippet).toContain("This is the snippet description");
  });
});
