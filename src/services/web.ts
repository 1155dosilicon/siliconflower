import { log } from "../logger.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  options: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal } = {}
): Promise<{ url: string; title?: string; content: string; isError: boolean }> {
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 120000, 15000);
  const maxChars = clampNumber(options.maxChars, 100, 200000, 15000);

  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }

  try {
    await log("info", `[web_fetch] Requisitando URL: ${targetUrl}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await fetchPublicWithRedirects(targetUrl, controller.signal, {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      });

      targetUrl = response.url || targetUrl;
      if (!response.ok) {
        return {
          url: targetUrl,
          content: `Erro HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const { text: rawText, truncated } = await readResponseTextLimited(response, maxChars, controller.signal);

      let extractedTitle = "";
      const matchTitle = /<title\b[^>]*>(.*?)<\/title>/gis.exec(rawText);
      if (matchTitle && matchTitle[1]) {
        extractedTitle = matchTitle[1].replace(/<[^>]+>/g, "").trim();
      }

      let markdown = contentType.includes("html") ? htmlToMarkdown(rawText) : rawText;

      if (truncated || markdown.length > maxChars) {
        markdown = markdown.slice(0, maxChars) + `\n\n... (conteúdo truncado para ${maxChars} caracteres)`;
      }

      return {
        url: targetUrl,
        title: extractedTitle,
        content: markdown,
        isError: false,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
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

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

async function fetchPublicWithRedirects(
  initialUrl: string,
  signal: AbortSignal,
  headers: Record<string, string>
): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirect = 0; redirect <= 5; redirect++) {
    await assertPublicUrl(current);
    const response = await fetch(current, { signal, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirect === 5) throw new Error("Limite de redirecionamentos excedido");
    current = new URL(location, current);
  }
  throw new Error("Limite de redirecionamentos excedido");
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Protocolo não permitido: ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Acesso a localhost não é permitido");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Acesso a endereço de rede privado ou reservado não é permitido");
  }
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19));
}

async function readResponseTextLimited(
  response: Response,
  maxChars: number,
  signal: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Abortado", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    if (!truncated) text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    maxResults = clampNumber(maxResults, 1, 20, 8);
    await log("info", `[web_search] Pesquisando web por: '${query}'`);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      return { query, results: [], isError: true };
    }

    const html = (await readResponseTextLimited(res, 2_000_000, controller.signal)).text;
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
  } finally {
    if (timer) clearTimeout(timer);
  }
}
