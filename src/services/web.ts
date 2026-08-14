import { log } from "../logger.js";

/**
 * Converts raw HTML into clean readable Markdown/text.
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove script and style elements
  text = text.replace(/<script\b[^<]*>([\s\S]*?)<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*>([\s\S]*?)<\/style>/gi, "");
  text = text.replace(/<head\b[^<]*>([\s\S]*?)<\/head>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Convert headers
  text = text.replace(/<h1\b[^>]*>(.*?)<\/h1>/gi, "\n\n# $1\n");
  text = text.replace(/<h2\b[^>]*>(.*?)<\/h2>/gi, "\n\n## $1\n");
  text = text.replace(/<h3\b[^>]*>(.*?)<\/h3>/gi, "\n\n### $1\n");
  text = text.replace(/<h[4-6]\b[^>]*>(.*?)<\/h[4-6]>/gi, "\n\n#### $1\n");

  // Convert paragraph and break tags
  text = text.replace(/<p\b[^>]*>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Convert links: <a href="url">text</a> -> [text](url)
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, "").trim();
    if (!cleanContent) return "";
    return `[${cleanContent}](${href})`;
  });

  // Convert list items
  text = text.replace(/<li\b[^>]*>(.*?)<\/li>/gi, "\n* $1");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");

  // Clean up excess whitespace and blank lines
  const lines = text.split("\n").map((line) => line.trim());
  let cleanLines: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (!line) {
      blankCount++;
      if (blankCount <= 2) cleanLines.push("");
    } else {
      blankCount = 0;
      cleanLines.push(line);
    }
  }

  return cleanLines.join("\n").trim();
}

/**
 * Fetches content from a URL and converts HTML to clean markdown.
 */
export async function webFetch(
  url: string,
  options: { timeoutMs?: number; maxChars?: number } = {}
): Promise<{ url: string; title?: string; content: string; isError: boolean }> {
  const timeoutMs = options.timeoutMs || 15000;
  const maxChars = options.maxChars || 15000;

  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }

  try {
    await log("info", `[web_fetch] Requisitando URL: ${targetUrl}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        url: targetUrl,
        content: `Erro HTTP ${response.status}: ${response.statusText}`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text();

    let extractedTitle = "";
    const matchTitle = /<title\b[^>]*>(.*?)<\/title>/gi.exec(rawText);
    if (matchTitle && matchTitle[1]) {
      extractedTitle = matchTitle[1].replace(/<[^>]+>/g, "").trim();
    }

    let markdown = contentType.includes("html") ? htmlToMarkdown(rawText) : rawText;

    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars) + `\n\n... (conteúdo truncado para ${maxChars} caracteres)`;
    }

    return {
      url: targetUrl,
      title: extractedTitle,
      content: markdown,
      isError: false,
    };
  } catch (err: any) {
    const errorMsg = err.name === "AbortError" ? `Tempo limite de ${timeoutMs}ms excedido` : err.message || String(err);
    await log("error", `[web_fetch erro] ${targetUrl}: ${errorMsg}`);
    return {
      url: targetUrl,
      content: `Erro ao buscar URL '${targetUrl}': ${errorMsg}`,
      isError: true,
    };
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Performs web search using DuckDuckGo public HTML endpoint.
 */
export async function webSearch(query: string, maxResults = 8): Promise<{ query: string; results: SearchResult[]; isError: boolean }> {
  try {
    await log("info", `[web_search] Pesquisando web por: '${query}'`);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { query, results: [], isError: true };
    }

    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse DuckDuckGo html search results
    const resultBlocks = html.split(/<div\s+class="[^"]*result[^"]*">/gi).slice(1);

    for (const block of resultBlocks) {
      if (results.length >= maxResults) break;

      const titleMatch = /<a\s+class="result__a"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const snippetMatch = /<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

      if (titleMatch) {
        let rawUrl = titleMatch[1];
        // Clean duckduckgo redirect url if present
        const uddgMatch = /uddg=([^&]+)/i.exec(rawUrl);
        if (uddgMatch) {
          rawUrl = decodeURIComponent(uddgMatch[1]);
        }

        const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

        if (title && rawUrl) {
          results.push({ title, url: rawUrl, snippet });
        }
      }
    }

    return { query, results, isError: false };
  } catch (err: any) {
    await log("error", `[web_search erro] '${query}': ${err.message || String(err)}`);
    return { query, results: [], isError: true };
  }
}
