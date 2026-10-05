/**
 * Tokenizer for the S06 Velocity-compatible template language (spec §5).
 *
 * Produces a flat token stream; `parser.mjs` builds the AST and
 * `interpreter.mjs` evaluates it. No `eval`/`Function` anywhere.
 *
 * Tokens: `{type:"text",value}`, `{type:"ref",raw,quiet}`,
 * `{type:"directive",name,args}`. Comments (`##…`, `#*…*#`) are dropped.
 * Escapes `\$`, `\#`, `\\` become literal text.
 *
 * Reference grammar scanned: `$`/`$!` + identifier + chains of `.name`,
 * `.method(…)` (balanced parens, quote-aware) and `[…]` (balanced brackets,
 * quote-aware, may nest `$` refs). `${…}` braced form ends at the matching
 * `}`. A trailing `.` not followed by an identifier char ends the reference.
 *
 * @module lib/gateway/core/processing/templates/tokenizer
 */

/** Maximum template size: 300 KB (spec §5). */
export const MAX_TEMPLATE_BYTES = 300 * 1024;

const DIRECTIVES = new Set(["set", "if", "elseif", "else", "end", "foreach", "break", "stop"]);

function isIdentStart(ch) {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

function readIdentifier(text, pos) {
  let end = pos;
  while (isIdentChar(text[end])) end += 1;
  return end;
}

/** Reads a balanced `(…)` / `[…]` / `{…}` span starting at `pos`. */
function readBalanced(text, pos, open, close) {
  let quote = null;
  let depth = 0;
  let i = pos;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** Scans an unbraced `$` reference starting after `$`/`$!`. Returns end pos or -1. */
function scanReference(text, pos) {
  if (!isIdentStart(text[pos])) return -1;
  let i = readIdentifier(text, pos);
  for (;;) {
    const ch = text[i];
    if (ch === "." && isIdentStart(text[i + 1])) {
      i = readIdentifier(text, i + 1);
      if (text[i] === "(") {
        const end = readBalanced(text, i, "(", ")");
        if (end < 0) return -1;
        i = end;
      }
      continue;
    }
    if (ch === "[") {
      const end = readBalanced(text, i, "[", "]");
      if (end < 0) return -1;
      i = end;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Tokenizes a template string.
 *
 * @param {string} template
 * @returns {Array<object>}
 * @throws {Error} on oversize input (message carries `code: "TEMPLATE_TOO_LARGE"`).
 */
export function tokenize(template) {
  const text = String(template ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BYTES) {
    const error = new Error(`Template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
    error.code = "TEMPLATE_TOO_LARGE";
    throw error;
  }
  const tokens = [];
  let buffer = "";
  let i = 0;

  function flushText() {
    if (buffer.length > 0) {
      tokens.push({ type: "text", value: buffer });
      buffer = "";
    }
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && (text[i + 1] === "$" || text[i + 1] === "#" || text[i + 1] === "\\")) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "#" && text[i + 1] === "*") {
      const close = text.indexOf("*#", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === "#" && text[i + 1] === "#") {
      const newline = text.indexOf("\n", i + 2);
      i = newline < 0 ? text.length : newline;
      continue;
    }
    if (ch === "$" && (isIdentStart(text[i + 1]) || text[i + 1] === "!" || text[i + 1] === "{")) {
      let j = i + 1;
      let quiet = false;
      if (text[j] === "!") {
        quiet = true;
        j += 1;
      }
      if (text[j] === "{") {
        const end = readBalanced(text, j, "{", "}");
        if (end > 0) {
          flushText();
          tokens.push({ type: "ref", raw: text.slice(i, end), quiet });
          i = end;
          continue;
        }
      } else {
        const end = scanReference(text, j);
        if (end > 0) {
          flushText();
          tokens.push({ type: "ref", raw: text.slice(i, end), quiet });
          i = end;
          continue;
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "#" && isIdentStart(text[i + 1])) {
      let j = readIdentifier(text, i + 1);
      const name = text.slice(i + 1, j);
      if (DIRECTIVES.has(name)) {
        let k = j;
        while (text[k] === " " || text[k] === "\t" || text[k] === "\n" || text[k] === "\r") k += 1;
        let args = "";
        if (text[k] === "(") {
          const end = readBalanced(text, k, "(", ")");
          if (end > 0) {
            args = text.slice(k + 1, end - 1);
            j = end;
          }
        }
        flushText();
        tokens.push({ type: "directive", name, args });
        i = j;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flushText();
  return tokens;
}
