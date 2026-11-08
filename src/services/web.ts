import { log } from "../logger.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  hellip: "…",
};

/** Lowercases ASCII only, so every index still points to the same character of the original. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

/** Index of the next `<tag` (or `</tag`) that really is that tag, not `<tagname`; -1 if none. */
function findTag(lower: string, tag: string, from: number): number {
  for (let i = lower.indexOf(tag, from); i !== -1; i = lower.indexOf(tag, i + 1)) {
    const next = lower[i + tag.length];
    if (next === undefined || !/[a-z0-9-]/.test(next)) return i;
  }
  return -1;
}

/**
 * Replaces each `<tag ...>inner</tag>` with `render(inner, openingTag)` in one pass over the
 * page; `undefined` keeps the element as it is. Lazy regexes such as `<li>(.*?)</li>` rescan
 * the rest of the page for every element left unclosed, which is quadratic: a 0.3 MB page
 * froze the whole agent for seconds, and web_fetch reads up to 3 MB. An unclosed element is
 * left for the generic tag removal, as the regexes did.
 */
function replaceElements(html: string, tag: string, render: (inner: string, open: string) => string | undefined): string {
  const lower = asciiLower(html);
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const start = findTag(lower, `<${tag}`, pos);
    if (start === -1) break;
    const openEnd = lower.indexOf(">", start);
    if (openEnd === -1) break;
    const close = findTag(lower, `</${tag}`, openEnd + 1);
    if (close === -1) break; // no closing tag anywhere after: nothing else can match
    const closeEnd = lower.indexOf(">", close);
    const after = closeEnd === -1 ? html.length : closeEnd + 1;
    out += html.slice(pos, start) + (render(html.slice(openEnd + 1, close), html.slice(start, openEnd + 1)) ?? html.slice(start, after));
    pos = after;
  }
  return out + html.slice(pos);
}

function removeComments(html: string): string {
  let out = "";
  let pos = 0;
  for (let start = html.indexOf("<!--"); start !== -1; start = html.indexOf("<!--", pos)) {
    out += html.slice(pos, start);
    const end = html.indexOf("-->", start + 4);
    if (end === -1) return out; // an unclosed comment runs to the end, as in a browser
    pos = end + 3;
  }
  return out + html.slice(pos);
}

// Inner tags are removed with [^<>]: with [^>]+, every "<" without a ">" after it made the
// regex rescan the rest of the page (quadratic as well).
const stripTags = (html: string, by = "") => html.replace(/<[^<>]+>/g, by);
const MAX_LINK_TEXT_CHARS = 2_000;

/**
 * Converts raw HTML into clean readable Markdown/text, in time linear in the size of the page.
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove scripts, styles, head, noscript, svg, canvas, iframe, and comments
  for (const tag of ["script", "style", "noscript", "svg", "canvas", "iframe", "head"]) {
    text = replaceElements(text, tag, () => "");
  }
  text = removeComments(text);

  // Convert code blocks: <pre>, with or without <code> inside, then inline <code>
  text = replaceElements(text, "pre", (code) => `\n\`\`\`\n${stripTags(code).trim()}\n\`\`\`\n`);
  text = replaceElements(text, "code", (code) => {
    if (code.includes("\n")) return undefined; // not inline code
    const clean = stripTags(code).trim();
    return clean ? `\`${clean}\`` : "";
  });

  // Convert headers (one line each, so links inside them still convert below)
  for (let level = 1; level <= 6; level++) {
    const marks = "#".repeat(Math.min(level, 4));
    text = replaceElements(text, `h${level}`, (inner) => `\n\n${marks} ${inner.replace(/\s*\n\s*/g, " ").trim()}\n`);
  }

  // Convert blockquotes
  text = replaceElements(text, "blockquote", (bq) => `\n> ${stripTags(bq, " ").trim()}\n`);

  // Convert bold and italic: opening and closing tags separately, which is linear
  text = text.replace(/<\/?(?:strong|b)\b[^<>]*>/gi, "**");
  text = text.replace(/<\/?(?:em|i)\b[^<>]*>/gi, "*");

  // Convert paragraph and break tags
  text = text.replace(/<p\b[^<>]*>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Convert links: <a href="url">text</a> -> [text](url)
  text = replaceElements(text, "a", (content, open) => {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(open)?.[1];
    if (!href || content.length > MAX_LINK_TEXT_CHARS) return undefined;
    const cleanContent = stripTags(content).replace(/\s+/g, " ").trim();
    if (!cleanContent || href.startsWith("javascript:") || href.startsWith("#")) return cleanContent;
    return `[${cleanContent}](${href})`;
  });

  // Convert list items (</li> is optional in HTML)
  text = text.replace(/<li\b[^<>]*>/gi, "\n* ");
  text = text.replace(/<\/li\s*>/gi, "");

  // Remove remaining HTML tags
  text = stripTags(text, " ");

  // Decode common HTML entities
  // Single pass so "&amp;lt;" becomes the literal "&lt;" instead of being decoded twice.
  text = text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });

  // Clean up excess whitespace and blank lines
  const lines = text.split("\n").map((line) => line.trim());
  const cleanLines: string[] = [];
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

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

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
      const response = await fetchPublicWithRedirects(targetUrl, controller.signal, BROWSER_HEADERS);

      targetUrl = response.url || targetUrl;
      if (!response.ok) {
        return {
          url: targetUrl,
          content: `Erro HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const isHtml = contentType.includes("html");
      // maxChars bounds the *converted* output. Raw HTML is mostly <head>, scripts and
      // navigation, so cutting it at maxChars would drop the actual page content.
      const rawLimit = isHtml ? Math.max(RAW_HTML_LIMIT, maxChars) : maxChars;
      const { text: rawText, truncated } = await readResponseTextLimited(response, rawLimit, controller.signal);

      let extractedTitle = "";
      replaceElements(rawText.slice(0, 200_000), "title", (inner) => {
        extractedTitle ||= stripTags(inner).trim();
        return undefined;
      });

      let markdown = isHtml ? htmlToMarkdown(rawText) : rawText;

      if ((truncated && !isHtml) || markdown.length > maxChars) {
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
    const errorMsg = err.name !== "AbortError"
      ? err.message || String(err)
      : options.signal?.aborted ? "cancelado pelo usuário" : `Tempo limite de ${timeoutMs}ms excedido`;
    await log("error", `[web_fetch erro] ${targetUrl}: ${errorMsg}`);
    return {
      url: targetUrl,
      content: `Erro ao buscar URL '${targetUrl}': ${errorMsg}`,
      isError: true,
    };
  }
}

const RAW_HTML_LIMIT = 3_000_000;

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
    await assertPublicUrl(current, signal);
    const response = await fetch(current, { signal, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirect === 5) throw new Error("Limite de redirecionamentos excedido");
    current = new URL(location, current);
  }
  throw new Error("Limite de redirecionamentos excedido");
}

/**
 * dns.lookup takes no signal: without this race a slow resolver (offline machine, captive
 * portal) outlived both the timeout of web_fetch and the cancel of the turn.
 */
export function lookupAll(
  hostname: string,
  signal: AbortSignal,
  resolver: (hostname: string, options: { all: true }) => Promise<{ address: string }[]> = lookup
): Promise<{ address: string }[]> {
  if (signal.aborted) return Promise.reject(new DOMException("Abortado", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Abortado", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    resolver(hostname, { all: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function assertPublicUrl(url: URL, signal: AbortSignal): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Protocolo não permitido: ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Acesso a localhost não é permitido");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookupAll(hostname, signal);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Acesso a endereço de rede privado ou reservado não é permitido");
  }
}

/**
 * Extracts the embedded IPv4 address from IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1),
 * IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) IPv6 forms. WHATWG URL serializes
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so the hex form must be handled too.
 */
function embeddedIPv4(ipv6: string): string | undefined {
  const m = ipv6.match(/^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const version = isIP(normalized);
  if (version === 6) {
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // Unique local (RFC 4193)
    if (/^fe[89ab]/.test(normalized)) return true; // Link-local
    if (normalized.startsWith("ff")) return true; // Multicast
  }
  const mapped = version === 6 ? embeddedIPv4(normalized) : undefined;
  const ipv4 = mapped ?? (version === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const [a, b, c] = ipv4.split(".").map(Number);
  return (
    a === 0 || // Current network (RFC 1122)
    a === 10 || // Private network RFC 1918
    a === 127 || // Loopback (RFC 1122)
    (a === 100 && b >= 64 && b <= 127) || // Shared Address Space CGNAT (RFC 6598)
    (a === 169 && b === 254) || // Link-Local (RFC 3927)
    (a === 172 && b >= 16 && b <= 31) || // Private network RFC 1918
    (a === 192 && b === 168) || // Private network RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // Protocol Assignments / TEST-NET-1 (RFC 6890, RFC 5737)
    (a === 198 && (b === 18 || b === 19)) || // Benchmarking (RFC 2544)
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2 (RFC 5737)
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3 (RFC 5737)
    (a >= 224) // Multicast & Reserved (Class D/E, RFC 1112 / RFC 5771)
  );
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

export function parseDuckDuckGoHtml(html: string, maxResults = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split(/<div\s+[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;

    const titleMatch =
      /<a\s+[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);

    const snippetMatch =
      /<a\s+[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
      /<[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(block);

    if (titleMatch) {
      let rawUrl = titleMatch[1];
      const uddgMatch = /uddg=([^&]+)/i.exec(rawUrl);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      } else if (rawUrl.startsWith("//")) {
        rawUrl = "https:" + rawUrl;
      }

      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      if (title && rawUrl && rawUrl.startsWith("http")) {
        results.push({ title, url: rawUrl, snippet });
      }
    }
  }

  // Fallback: if blocks split didn't yield results, search all <a> tags with uddg= parameter
  if (results.length === 0) {
    const linkMatches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']*uddg=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const seenUrls = new Set<string>();
    for (const match of linkMatches) {
      if (results.length >= maxResults) break;
      let rawUrl = match[1];
      const uddgMatch = /uddg=([^&]+)/i.exec(rawUrl);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      }
      if (!rawUrl.startsWith("http") || seenUrls.has(rawUrl)) continue;
      seenUrls.add(rawUrl);

      const title = match[2].replace(/<[^>]+>/g, "").trim();
      if (title && title.length > 2 && !title.startsWith("http")) {
        results.push({ title, url: rawUrl, snippet: "" });
      }
    }
  }

  return results;
}

/**
 * Performs web search using DuckDuckGo public HTML endpoint with fallback parsing.
 */
export async function webSearch(
  query: string,
  maxResults = 8,
  signal?: AbortSignal
): Promise<{ query: string; results: SearchResult[]; isError: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    maxResults = clampNumber(maxResults, 1, 20, 8);
    await log("info", `[web_search] Pesquisando web por: '${query}'`);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await fetch(searchUrl, {
        signal: controller.signal,
        headers: BROWSER_HEADERS,
      });

      if (res.status === 202) {
        // Anti-bot challenge returned by DuckDuckGo
        await log("warn", `[web_search] DuckDuckGo retornou HTTP 202 (desafio anti-bot detectado)`);
        return {
          query,
          results: [],
          isError: true,
          error: "O motor de busca retornou proteção anti-bot (HTTP 202). Tente reformular o termo de busca.",
        };
      }

      if (!res.ok) {
        return {
          query,
          results: [],
          isError: true,
          error: `Erro HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const html = (await readResponseTextLimited(res, 2_000_000, controller.signal)).text;
      const results = parseDuckDuckGoHtml(html, maxResults);

      await log("info", `[web_search] Encontrados ${results.length} resultados para '${query}'`);
      return { query, results, isError: false };
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
    }
  } catch (err: any) {
    const errorMsg = err.name === "AbortError" ? "Tempo limite de busca excedido" : err.message || String(err);
    await log("error", `[web_search erro] '${query}': ${errorMsg}`);
    return { query, results: [], isError: true, error: errorMsg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
