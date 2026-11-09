import { readFile, writeFile } from "fs/promises";
import { log } from "../logger.js";

export interface EditOptions {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface EditResult {
  result: string;
  isError: boolean;
  matchType?: "exact" | "normalized_newlines" | "fuzzy_whitespace";
}

type Eol = "\r\n" | "\n";

/**
 * Normalizes line endings to \n for consistent comparisons.
 */
function normalizeNewlines(str: string): string {
  return str.replace(/\r\n/g, "\n");
}

/**
 * Normalizes indentation and whitespace per line for fuzzy matching.
 */
function normalizeLineWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** The line ending most lines of the text use. */
function dominantEol(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** The ending the replaced stretch uses; the file's own when the stretch is a single line. */
function eolOf(stretch: string, fallback: Eol): Eol {
  if (stretch.includes("\r\n")) return "\r\n";
  return stretch.includes("\n") ? "\n" : fallback;
}

const withEol = (text: string, eol: Eol) => (eol === "\n" ? normalizeNewlines(text) : normalizeNewlines(text).replace(/\n/g, "\r\n"));

/** Position in `original` of the character at `index` of its newline-normalized form. */
function originalIndex(original: string, index: number): number {
  let o = 0;
  for (let n = 0; n < index; n++) {
    if (original[o] === "\r" && original[o + 1] === "\n") o++;
    o++;
  }
  return o;
}

/**
 * Smart file edit function that handles exact, newline-normalized, and fuzzy whitespace matches.
 * Only the replaced stretch is rewritten: the line endings of the rest of the file stay as
 * they are, also in a file that mixes CRLF and LF.
 */
export async function smartEditFile(options: EditOptions): Promise<EditResult> {
  const { path, oldText, newText, replaceAll = false } = options;

  if (!oldText) {
    return { result: "oldText não pode ser vazio", isError: true };
  }

  try {
    const originalRaw = await readFile(path, "utf8");
    const fileEol = dominantEol(originalRaw);

    // Strategy 1: Exact match
    if (originalRaw.includes(oldText)) {
      // A single-line oldText can match exactly in a CRLF file while newText arrives with
      // bare LF, which would mix line endings.
      const replacement = withEol(newText, eolOf(oldText, fileEol));
      let updated: string;
      if (replaceAll) {
        updated = originalRaw.split(oldText).join(replacement);
      } else {
        const idx = originalRaw.indexOf(oldText);
        updated = originalRaw.slice(0, idx) + replacement + originalRaw.slice(idx + oldText.length);
      }
      if (updated === originalRaw) {
        return { result: `Nenhuma alteração em ${path}`, isError: false };
      }
      await writeFile(path, updated, "utf8");
      await log("info", `smartEditFile (exact): ${path}`);
      return { result: `Editado (correspondência exata): ${path}`, isError: false, matchType: "exact" };
    }

    // Strategy 2: Normalized Newlines (\r\n vs \n)
    const normOriginal = normalizeNewlines(originalRaw);
    const normOld = normalizeNewlines(oldText);

    if (normOriginal.includes(normOld)) {
      const starts: number[] = [];
      for (let idx = normOriginal.indexOf(normOld); idx !== -1; idx = normOriginal.indexOf(normOld, idx + normOld.length)) {
        starts.push(idx);
        if (!replaceAll) break;
      }
      let updated = "";
      let cursor = 0;
      for (const start of starts) {
        const from = originalIndex(originalRaw, start);
        const to = originalIndex(originalRaw, start + normOld.length);
        updated += originalRaw.slice(cursor, from) + withEol(newText, eolOf(originalRaw.slice(from, to), fileEol));
        cursor = to;
      }
      updated += originalRaw.slice(cursor);
      await writeFile(path, updated, "utf8");
      await log("info", `smartEditFile (normalized_newlines): ${path}`);
      return {
        result: `Editado (correspondência de quebras de linha ajustadas): ${path}`,
        isError: false,
        matchType: "normalized_newlines",
      };
    }

    // Strategy 3: Fuzzy Line-by-Line Whitespace Matching
    // Each line keeps its own ending ("" on a last line without one).
    const origLines = normOriginal.split("\n");
    const endings: string[] = [];
    {
      let pos = 0;
      for (const line of origLines) {
        pos += line.length;
        const ending = originalRaw.startsWith("\r\n", pos) ? "\r\n" : originalRaw[pos] === "\n" ? "\n" : "";
        endings.push(ending);
        pos += ending.length;
      }
    }
    const oldLines = normOld.split("\n");

    if (oldLines.length > 0) {
      const targetLength = oldLines.length;
      const normOldLines = oldLines.map(normalizeLineWhitespace);

      const foundIndexes: number[] = [];
      for (let i = 0; i <= origLines.length - targetLength; i++) {
        let match = true;
        for (let j = 0; j < targetLength; j++) {
          if (normalizeLineWhitespace(origLines[i + j]) !== normOldLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundIndexes.push(i);
          i += targetLength - 1; // skip past this block so matches don't overlap
        }
      }

      if (foundIndexes.length > 1 && !replaceAll) {
        return {
          result: `oldText corresponde a ${foundIndexes.length} trechos diferentes em ${path} (linhas: ${foundIndexes
            .map((i) => i + 1)
            .join(", ")}) apenas com espaçamento flexível — ambíguo. Forneça mais contexto em oldText para identificar um único trecho, ou use replaceAll: true se a intenção é editar todas as ocorrências.`,
          isError: true,
        };
      }

      if (foundIndexes.length > 0) {
        const newLines = normalizeNewlines(newText).split("\n");
        const joinLines = (from: number, to: number) => {
          let text = "";
          for (let i = from; i < to; i++) text += origLines[i] + endings[i];
          return text;
        };
        let finalContent = "";
        let cursor = 0;
        for (const idx of foundIndexes) {
          finalContent += joinLines(cursor, idx);
          const last = idx + targetLength - 1;
          const blockEol = (endings.slice(idx, last).find(Boolean) ?? endings[last]) || fileEol;
          // The block ends as the replaced one did: with its line ending, or none at the end of the file.
          finalContent += newLines.join(blockEol) + endings[last];
          cursor = idx + targetLength;
        }
        finalContent += joinLines(cursor, origLines.length);

        await writeFile(path, finalContent, "utf8");
        await log("info", `smartEditFile (fuzzy_whitespace): ${path}`);
        return {
          result:
            foundIndexes.length > 1
              ? `Editado (correspondência flexível de espaçamento, ${foundIndexes.length} ocorrências): ${path}`
              : `Editado (correspondência flexível de espaçamento): ${path}`,
          isError: false,
          matchType: "fuzzy_whitespace",
        };
      }
    }

    // Diagnostics if not found
    const firstLineOld = oldLines[0] ? normalizeLineWhitespace(oldLines[0]) : "";
    const candidateLines = origLines
      .map((line, idx) => ({ line: normalizeLineWhitespace(line), index: idx + 1 }))
      .filter((item) => item.line.length > 3 && (item.line.includes(firstLineOld) || firstLineOld.includes(item.line)))
      .slice(0, 3);

    let diagMsg = `oldText não encontrado em ${path}.`;
    if (candidateLines.length > 0) {
      diagMsg += ` Linhas semelhantes encontradas próximas às linhas: ${candidateLines.map((c) => c.index).join(", ")}.`;
    }

    return { result: diagMsg, isError: true };
  } catch (e) {
    return { result: `Erro ao editar ${path}: ${String(e)}`, isError: true };
  }
}
