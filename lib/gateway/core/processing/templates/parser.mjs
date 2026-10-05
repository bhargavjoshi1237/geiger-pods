/**
 * Parser: token stream → AST for the S06 Velocity-compatible language.
 *
 * AST nodes: Root, Text, Ref, Set, If, Foreach, Break, Stop. Expression
 * nodes: Literal, Interpolated, Var, Get, Call, Unary, Binary, List, Map,
 * Range. `$!` quiet refs and `${…}` forms are normalized here.
 *
 * @module lib/gateway/core/processing/templates/parser
 */

/** Parse error: configuration failure, caught at deploy (compile step). */
export class TemplateSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateSyntaxError";
    this.code = "TEMPLATE_SYNTAX_ERROR";
  }
}

// ---------------------------------------------------------------------------
// Expression lexer + recursive-descent parser
// ---------------------------------------------------------------------------

function lexExpression(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== ch) {
        if (ch === '"' && source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new TemplateSyntaxError(`Unterminated string in expression: ${source}`);
      tokens.push({ type: "string", value, quoted: ch });
      i = j + 1;
      continue;
    }
    const number = source.slice(i).match(/^(-?\d+(?:\.\d+)?)/);
    if (number) {
      // A leading `-` is unary/a number sign unless it directly follows a
      // value (`)`, `]`, literal, ident), where it is the binary operator.
      const prev = tokens[tokens.length - 1];
      const prevIsValue = prev && (
        prev.type === "number" || prev.type === "string" || prev.type === "ident" || prev.type === "null"
        || (prev.type === "punct" && (prev.value === ")" || prev.value === "]"))
      );
      if (!number[1].startsWith("-") || !prevIsValue) {
        tokens.push({ type: "number", value: Number(number[1]) });
        i += number[1].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      if (word === "true" || word === "false") tokens.push({ type: "number", value: word === "true" });
      else if (word === "null") tokens.push({ type: "null" });
      else if (["and", "or", "not"].includes(word)) tokens.push({ type: "op", value: word });
      else tokens.push({ type: "ident", value: word });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", ".."].includes(two)) {
      tokens.push({ type: two === ".." ? "range" : "op", value: two });
      i += 2;
      continue;
    }
    if (ch === "<" || ch === ">" || ch === "!") {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    if ("+-*/%(),:[]{}=.".includes(ch)) {
      tokens.push({ type: "punct", value: ch });
      i += 1;
      continue;
    }
    if (ch === "$") {
      tokens.push({ type: "dollar" });
      i += 1;
      continue;
    }
    throw new TemplateSyntaxError(`Unexpected character ${JSON.stringify(ch)} in expression: ${source}`);
  }
  return tokens;
}

class ExpressionParser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.source = source;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(value) {
    const token = this.next();
    if (!token || token.value !== value) throw new TemplateSyntaxError(`Expected ${JSON.stringify(value)} in expression: ${this.source}`);
    return token;
  }

  parse() {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) throw new TemplateSyntaxError(`Trailing tokens in expression: ${this.source}`);
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "||" || token.value === "or")) {
        this.next();
        left = { type: "Binary", op: "||", left, right: this.parseAnd() };
        continue;
      }
      return left;
    }
  }

  parseAnd() {
    let left = this.parseEquality();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "&&" || token.value === "and")) {
        this.next();
        left = { type: "Binary", op: "&&", left, right: this.parseEquality() };
        continue;
      }
      return left;
    }
  }

  parseEquality() {
    let left = this.parseRelational();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "==" || token.value === "!=")) {
        this.next();
        left = { type: "Binary", op: token.value, left, right: this.parseRelational() };
        continue;
      }
      return left;
    }
  }

  parseRelational() {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && ["<", ">", "<=", ">="].includes(token.value)) {
        this.next();
        left = { type: "Binary", op: token.value, left, right: this.parseAdditive() };
        continue;
      }
      return left;
    }
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.type === "punct" && (token.value === "+" || token.value === "-")) {
        this.next();
        left = { type: "Binary", op: token.value, left, right: this.parseMultiplicative() };
        continue;
      }
      return left;
    }
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.type === "punct" && (token.value === "*" || token.value === "/" || token.value === "%")) {
        this.next();
        left = { type: "Binary", op: token.value, left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  parseUnary() {
    const token = this.peek();
    if (token?.type === "op" && (token.value === "!" || token.value === "not")) {
      this.next();
      return { type: "Unary", op: "!", arg: this.parseUnary() };
    }
    if (token?.type === "punct" && token.value === "-") {
      this.next();
      return { type: "Unary", op: "-", arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.next();
    if (!token) throw new TemplateSyntaxError(`Unexpected end of expression: ${this.source}`);
    if (token.type === "dollar") return this.parseRefTail();
    let node;
    if (token.type === "string") {
      node = token.quoted === '"' ? parseInterpolatedString(token.value, this.source) : { type: "Literal", value: token.value };
    } else if (token.type === "number") {
      node = { type: "Literal", value: token.value };
    } else if (token.type === "null") {
      node = { type: "Literal", value: null };
    } else if (token.type === "punct" && token.value === "[") {
      node = this.parseListOrRange();
    } else if (token.type === "punct" && token.value === "{") {
      node = this.parseMap();
    } else if (token.type === "punct" && token.value === "(") {
      node = this.parseOr();
      this.expect(")");
    } else {
      throw new TemplateSyntaxError(`Unexpected token ${JSON.stringify(token.value)} in expression: ${this.source}`);
    }
    // Calls and indexing on literals: `"a,b".split(",")[1]`, `[1,2].size()`.
    return this.parseChain(node);
  }

  parseRefTail() {
    const token = this.next();
    if (token?.type === "punct" && token.value === "{") {
      const inner = this.parseOr();
      this.expect("}");
      return inner;
    }
    // `$!quiet` inside expressions: the `!` arrives as an op token.
    if (token?.type === "op" && token.value === "!") {
      const name = this.next();
      if (name?.type !== "ident") throw new TemplateSyntaxError(`Expected identifier after $! in: ${this.source}`);
      return this.parseChain({ type: "Var", name: name.value });
    }
    if (token?.type !== "ident") throw new TemplateSyntaxError(`Expected identifier after $ in: ${this.source}`);
    return this.parseChain({ type: "Var", name: token.value });
  }

  parseChain(node) {
    for (;;) {
      const token = this.peek();
      if (token?.type === "punct" && token.value === ".") {
        this.next();
        const name = this.next();
        if (name?.type !== "ident") throw new TemplateSyntaxError(`Expected property name after . in: ${this.source}`);
        const open = this.peek();
        if (open?.type === "punct" && open.value === "(") {
          this.next();
          const args = this.parseArgList();
          this.expect(")");
          node = { type: "Call", object: node, method: name.value, args };
        } else {
          node = { type: "Get", object: node, key: { type: "Literal", value: name.value } };
        }
        continue;
      }
      if (token?.type === "punct" && token.value === "[") {
        this.next();
        const key = this.parseOr();
        this.expect("]");
        node = { type: "Get", object: node, key };
        continue;
      }
      return node;
    }
  }

  parseArgList() {
    const args = [];
    if (this.peek()?.type === "punct" && this.peek().value === ")") return args;
    for (;;) {
      args.push(this.parseOr());
      const token = this.peek();
      if (token?.type === "punct" && token.value === ",") {
        this.next();
        continue;
      }
      return args;
    }
  }

  parseListOrRange() {
    if (this.peek()?.type === "punct" && this.peek().value === "]") {
      this.next();
      return { type: "List", items: [] };
    }
    const first = this.parseOr();
    if (this.peek()?.type === "range") {
      this.next();
      const last = this.parseOr();
      this.expect("]");
      return { type: "Range", from: first, to: last };
    }
    const items = [first];
    while (this.peek()?.type === "punct" && this.peek().value === ",") {
      this.next();
      items.push(this.parseOr());
    }
    this.expect("]");
    return { type: "List", items };
  }

  parseMap() {
    const entries = [];
    if (this.peek()?.type === "punct" && this.peek().value === "}") {
      this.next();
      return { type: "Map", entries };
    }
    for (;;) {
      const keyToken = this.next();
      let key;
      if (keyToken?.type === "string") key = { type: "Literal", value: keyToken.value };
      else if (keyToken?.type === "ident") key = { type: "Literal", value: keyToken.value };
      else throw new TemplateSyntaxError(`Expected map key in expression: ${this.source}`);
      const colon = this.next();
      if (colon?.type !== "punct" || (colon.value !== ":" && colon.value !== "=")) {
        throw new TemplateSyntaxError(`Expected : after map key in expression: ${this.source}`);
      }
      entries.push({ key, value: this.parseOr() });
      const next = this.peek();
      if (next?.type === "punct" && next.value === ",") {
        this.next();
        continue;
      }
      this.expect("}");
      return { type: "Map", entries };
    }
  }
}

/**
 * Parses an expression string into an expression AST.
 *
 * @param {string} source
 * @returns {object}
 */
export function parseExpression(source) {
  const parser = new ExpressionParser(lexExpression(source), source);
  return parser.parse();
}

/** Splits a `"…"` literal into literal/ref parts for interpolation. */
function parseInterpolatedString(value, source) {
  const parts = [];
  let buffer = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === "$" && /[A-Za-z_!{]/.test(value[i + 1] ?? "")) {
      let j = i + 1;
      if (value[j] === "!") j += 1;
      let raw;
      if (value[j] === "{") {
        const close = value.indexOf("}", j);
        if (close < 0) {
          buffer += value[i];
          i += 1;
          continue;
        }
        raw = value.slice(i, close + 1);
        i = close + 1;
      } else {
        let k = j;
        while (k < value.length && /[A-Za-z0-9_.$[\]'"()\-,\s]/.test(value[k])) {
          // conservative: stop at whitespace or string end for method args
          if (/\s/.test(value[k]) && !value.slice(j, k).includes("(")) break;
          k += 1;
        }
        // Trim trailing characters that cannot end a reference.
        while (k > j && /[.\s,]$/.test(value[k - 1])) k -= 1;
        raw = value.slice(i, k);
        i = k;
      }
      if (buffer) {
        parts.push({ type: "Literal", value: buffer });
        buffer = "";
      }
      const refNode = parseReference(raw);
      parts.push({ type: "RefExpr", expr: refNode, quiet: raw.startsWith("$!"), raw });
      continue;
    }
    buffer += value[i];
    i += 1;
  }
  if (buffer) parts.push({ type: "Literal", value: buffer });
  if (parts.length === 1 && parts[0].type === "Literal") return parts[0];
  return { type: "Interpolated", parts };
}

/**
 * Parses a raw `$…` reference (tokenizer output) into an expression AST.
 *
 * @param {string} raw - Including leading `$`/`$!`, maybe `${…}`.
 * @returns {object}
 */
export function parseReference(raw) {
  const inner = raw.startsWith("$!") ? raw.slice(2) : raw.slice(1);
  if (inner.startsWith("{") && inner.endsWith("}")) {
    // `${…}` holds a full expression (`${"a,b".split(",")[1]}`); a bare
    // variable path (`${context.name}`) gets its `$` back.
    const body = inner.slice(1, -1);
    try {
      return parseExpression(body);
    } catch (error) {
      if (error?.name !== "TemplateSyntaxError") throw error;
      return parseExpression(`$${body}`);
    }
  }
  // Dots inside brackets (e.g. `$a['k']`) must not split the base ident.
  return parseExpression(`$${inner}`);
}

/**
 * Parses a token stream into a template AST.
 *
 * @param {Array<object>} tokens
 * @returns {{ type: "Root", body: Array<object> }}
 */
export function parseTokens(tokens) {
  const root = { type: "Root", body: [] };
  const stack = [{ node: root, body: root.body, kind: "root" }];
  const current = () => stack[stack.length - 1];

  function append(node) {
    current().body.push(node);
  }

  for (const token of tokens) {
    if (token.type === "text") {
      append({ type: "Text", value: token.value });
      continue;
    }
    if (token.type === "ref") {
      append({ type: "Ref", expr: parseReference(token.raw), quiet: token.quiet, raw: token.raw });
      continue;
    }
    const { name, args } = token;
    if (name === "set") {
      append(parseSet(args));
      continue;
    }
    if (name === "if") {
      const node = { type: "If", branches: [{ test: parseExpression(args), body: [] }], elseBody: null };
      append(node);
      stack.push({ node, body: node.branches[0].body, kind: "if" });
      continue;
    }
    if (name === "elseif") {
      const top = current();
      if (top.kind !== "if" && top.kind !== "elseif") throw new TemplateSyntaxError("#elseif without #if");
      const branch = { test: parseExpression(args), body: [] };
      top.node.branches.push(branch);
      top.body = branch.body;
      top.kind = "elseif";
      continue;
    }
    if (name === "else") {
      const top = current();
      if (top.kind !== "if" && top.kind !== "elseif") throw new TemplateSyntaxError("#else without #if");
      if (top.node.elseBody) throw new TemplateSyntaxError("duplicate #else");
      top.node.elseBody = [];
      top.body = top.node.elseBody;
      top.kind = "else";
      continue;
    }
    if (name === "foreach") {
      const match = args.match(/^\s*\$!?\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s+in\s+(.+)$/s);
      if (!match) throw new TemplateSyntaxError(`Invalid #foreach arguments: ${args}`);
      const node = { type: "Foreach", item: match[1], list: parseExpression(match[2].trim()), body: [] };
      append(node);
      stack.push({ node, body: node.body, kind: "foreach" });
      continue;
    }
    if (name === "break") {
      append({ type: "Break" });
      continue;
    }
    if (name === "stop") {
      append({ type: "Stop" });
      continue;
    }
    if (name === "end") {
      if (stack.length <= 1) throw new TemplateSyntaxError("Unmatched #end");
      stack.pop();
      continue;
    }
  }
  if (stack.length !== 1) throw new TemplateSyntaxError("Unclosed directive (missing #end)");
  return root;
}

function parseSet(args) {
  const eqIndex = findSetEquals(args);
  const targetText = args.slice(0, eqIndex).trim().replace(/^\$!?/, "").replace(/^\{/, "").replace(/\}$/, "");
  const valueSource = args.slice(eqIndex + 1).trim();
  if (!targetText || !valueSource) throw new TemplateSyntaxError(`Invalid #set: ${args}`);
  return {
    type: "Set",
    target: parseSetTarget(targetText, args),
    value: parseExpression(valueSource),
  };
}

function findSetEquals(args) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "=" && depth === 0 && args[i + 1] !== "=") return i;
  }
  throw new TemplateSyntaxError(`Invalid #set (missing =): ${args}`);
}

function parseSetTarget(targetText, args) {
  const base = targetText.match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/s);
  if (!base) throw new TemplateSyntaxError(`Invalid #set target: ${args}`);
  const [, name, rest] = base;
  const segments = [];
  let remaining = rest.trim();
  while (remaining.length > 0) {
    if (remaining.startsWith(".")) {
      const prop = remaining.slice(1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (!prop) throw new TemplateSyntaxError(`Invalid #set target: ${args}`);
      segments.push({ kind: "prop", name: prop[1] });
      remaining = remaining.slice(1 + prop[1].length);
      continue;
    }
    if (remaining.startsWith("[")) {
      const close = remaining.indexOf("]");
      if (close < 0) throw new TemplateSyntaxError(`Invalid #set target: ${args}`);
      const keySource = remaining.slice(1, close).trim();
      const key = /^['"]/.test(keySource)
        ? { type: "Literal", value: keySource.slice(1, -1) }
        : /^-?\d+$/.test(keySource)
          ? { type: "Literal", value: Number(keySource) }
          : parseExpression(keySource);
      segments.push({ kind: "index", key });
      remaining = remaining.slice(close + 1);
      continue;
    }
    throw new TemplateSyntaxError(`Invalid #set target: ${args}`);
  }
  return { name, segments };
}
