// Markdown to a plain tree of nodes. The page turns these nodes into DOM elements with a
// fixed set of tags and textContent: model output never reaches the page as HTML.

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_DEPTH = 8;

/** Returns the URL when it is safe to link to, otherwise null (javascript:, data: etc.). */
export function safeHref(raw) {
  try {
    const url = new URL(raw.trim());
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const SPANS = [
  { mark: "**", type: "strong" },
  { mark: "__", type: "strong" },
  { mark: "~~", type: "del" },
  { mark: "*", type: "em" },
];

export function parseInline(text, depth = 0) {
  const nodes = [];
  let plain = "";
  const pushPlain = () => {
    if (plain) nodes.push({ type: "text", text: plain });
    plain = "";
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && /[\\`*_~[\]()!#>-]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        pushPlain();
        nodes.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (depth < MAX_DEPTH && (ch === "[" || (ch === "!" && text[i + 1] === "["))) {
      const open = ch === "!" ? i + 1 : i;
      const close = text.indexOf("](", open);
      const end = close === -1 ? -1 : text.indexOf(")", close);
      if (close !== -1 && end !== -1) {
        const label = text.slice(open + 1, close);
        const href = safeHref(text.slice(close + 2, end).split(/\s/)[0] ?? "");
        pushPlain();
        // Images are shown as links: loading them would send data to third parties.
        const children = parseInline(label || (ch === "!" ? "imagem" : ""), depth + 1);
        nodes.push(href ? { type: "link", href, children } : { type: "span", children });
        i = end + 1;
        continue;
      }
    }

    if (ch === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i))) {
      let end = i;
      while (end < text.length && !/[\s<>]/.test(text[end])) end++;
      while (end > i && /[.,;:!?)\]'"]/.test(text[end - 1])) end--;
      const href = safeHref(text.slice(i, end));
      if (href) {
        pushPlain();
        nodes.push({ type: "link", href, children: [{ type: "text", text: text.slice(i, end) }] });
        i = end;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      const span = SPANS.find((s) => text.startsWith(s.mark, i));
      if (span) {
        const start = i + span.mark.length;
        const end = text.indexOf(span.mark, start);
        // "2 * 3 * 4" and "snake__case" stay as text.
        const opens = start < text.length && !/\s/.test(text[start]);
        const wordBefore = i > 0 && /\w/.test(text[i - 1]);
        if (end > start && opens && !/\s/.test(text[end - 1]) && !(span.mark === "__" && wordBefore)) {
          pushPlain();
          nodes.push({ type: span.type, children: parseInline(text.slice(start, end), depth + 1) });
          i = end + span.mark.length;
          continue;
        }
      }
    }

    plain += ch;
    i++;
  }
  pushPlain();
  return nodes;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => parseInline(cell.trim()));
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s{0,3}>/.test(line) ||
    (line.includes("|") && next !== undefined && next.includes("-") && TABLE_DIVIDER.test(next))
  );
}

function parseList(lines, start, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || match[1].length > baseIndent + 1 || /\d/.test(match[2]) !== ordered) break;
    const itemLines = [match[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        const next = lines[i + 1];
        const continues = next !== undefined && next.length - next.trimStart().length > baseIndent;
        if (!continues) break;
        itemLines.push("");
        i++;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) break;
      itemLines.push(line.slice(Math.min(indent, baseIndent + 2)));
      i++;
    }
    items.push(parseBlocks(itemLines, depth + 1));
    // A blank line between items keeps the list going.
    if (lines[i]?.trim() === "" && lines[i + 1] !== undefined && LIST_ITEM.test(lines[i + 1])) i++;
  }
  return { node: { type: "list", ordered, items }, next: i };
}

function parseBlocks(lines, depth) {
  if (depth > MAX_DEPTH) return [{ type: "paragraph", children: [{ type: "text", text: lines.join("\n") }] }];
  const blocks = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      const closing = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      // While streaming the fence may still be open: everything so far is code.
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: "codeblock", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, i, depth);
      blocks.push(node);
      i = next;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ type: "quote", children: parseBlocks(body, depth + 1) });
      continue;
    }

    if (line.includes("|") && lines[i + 1] !== undefined && lines[i + 1].includes("-") && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) rows.push(tableCells(lines[i++]));
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const body = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) body.push(lines[i++]);
    blocks.push({ type: "paragraph", children: parseInline(body.map((l) => l.trim()).join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(text) {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}
