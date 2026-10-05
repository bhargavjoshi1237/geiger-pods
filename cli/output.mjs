// Shared CLI output: human tables by default, `--output json|yaml`.
//
// @module cli/output
const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

function plain(text) {
  return process.env.NO_COLOR ? String(text) : String(text);
}

/**
 * Renders rows as an aligned human table.
 *
 * @param {Array<string>} columns
 * @param {Array<Array<unknown>>} rows
 * @returns {string}
 */
export function table(columns, rows) {
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...rows.map((row) => String(row[index] ?? "").length),
  ));
  const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  const out = [plain(`${BOLD}${line(columns)}${RESET}`)];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function toYamlValue(value, indent) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (/^[\w .:/@+-]*$/.test(value) && value !== "") return value;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `\n${value.map((entry) => `${" ".repeat(indent)}- ${toYamlValue(entry, indent + 2)}`).join("\n")}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `\n${entries.map(([key, entry]) => `${" ".repeat(indent)}${key}: ${toYamlValue(entry, indent + 2)}`).join("\n")}`;
  }
  return JSON.stringify(value);
}

/**
 * Formats a result for terminal output.
 *
 * @param {unknown} data
 * @param {{ output?: string }} [opts={}]
 * @returns {string}
 */
export function format(data, opts = {}) {
  const mode = opts.output ?? "human";
  if (mode === "json") return JSON.stringify(data, null, 2);
  if (mode === "yaml") {
    if (data && typeof data === "object") {
      return Object.entries(data).map(([key, value]) => `${key}: ${toYamlValue(value, 2)}`).join("\n");
    }
    return toYamlValue(data, 0);
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return "No results.";
    const columns = [...new Set(data.flatMap((row) => Object.keys(row ?? {})))].slice(0, 6);
    return table(columns, data.map((row) => columns.map((column) => row?.[column] ?? "")));
  }
  if (data && typeof data === "object") {
    return table(["field", "value"], Object.entries(data).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value ?? "")]));
  }
  return String(data ?? "");
}
