// A small in-memory stand-in for the supabase-js browser client, used only while
// the landing playground is mounted (see ./mode.js). It implements the slice of
// supabase-js the suite's data layers use, over seeded tables:
//
//   from(table)
//     .select("a, b, alias:col, owner:owner_id(name), items:children(count), rel!inner(*)", { count, head })
//     .insert / .upsert({ onConflict, ignoreDuplicates }) / .update / .delete   (+ .select() to return rows)
//     .eq .neq .gt .gte .lt .lte .is .in .not .match .like .ilike .contains
//     .containedBy .overlaps .textSearch .or .filter
//     .order .limit .range .single .maybeSingle .throwOnError
//   schema(name)        "name.table" if seeded, else "table"
//   rpc(name, args)     ./rpc.js handlers
//   auth / storage / functions / channel stand-ins
//
// Writes land in memory, so creating, editing and deleting all work for the
// session and reset on reload. App-specific write rules go through `hooks`,
// never by editing this file — it is kept identical across repos (canonical
// copy: C:\Pro\docs\superpowers\playground-kit\lib\playground\memory_client.js).

const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function singular(table) {
  if (/ies$/.test(table)) return table.replace(/ies$/, "y");
  if (/(ss|us|x|ch|sh)es$/.test(table)) return table.replace(/es$/, "");
  return table.replace(/s$/, "");
}

function plural(word) {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function error(message, code = "PLAYGROUND", status = 400) {
  return { data: null, error: { message, code, details: null, hint: null }, status };
}

// "a, b:c(d,e), f(count)" -> ["a", "b:c(d,e)", "f(count)"]
function splitTopLevel(input, separator = ",") {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of String(input)) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// select() column list -> spec tree. Supports `alias:column`, `column::cast`,
// `json->key` / `json->>key`, and embeds `alias:source!hint(columns)` nested
// to any depth.
export function parseSelect(columns) {
  return splitTopLevel(String(columns || "*").replace(/\s+/g, " ")).map((part) => {
    const embed = part.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\s*\((.*)\)$/s);
    if (embed) {
      const [, alias, source, hint, inner] = embed;
      return {
        kind: "embed",
        alias: alias || source,
        source,
        hint: hint || null,
        inner: hint === "inner",
        columns: parseSelect(inner),
      };
    }
    const aliased = part.match(/^(\w+):(.+)$/);
    const rawName = (aliased ? aliased[2] : part).replace(/::\w+$/, "").trim();
    const path = rawName.split(/->>?/).map((s) => s.replace(/^'|'$/g, ""));
    const alias = aliased ? aliased[1] : path[path.length - 1];
    return { kind: "column", name: path[0], path, alias: rawName === "*" ? "*" : alias };
  });
}

function readPath(row, path) {
  let value = row?.[path[0]];
  for (const key of path.slice(1)) value = value?.[key];
  return value;
}

function isCountOnly(columns) {
  return columns.length === 1 && columns[0].kind === "column" && columns[0].name === "count";
}

// Compares like Postgres would for the types seeds use: numbers numerically,
// everything else as strings (ISO dates sort correctly as strings).
function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// SQL LIKE (and supabase-js's `*` alias for `%`) -> anchored RegExp.
function likeToRegExp(pattern, flags) {
  let source = "";
  for (const ch of String(pattern)) {
    if (ch === "%" || ch === "*") source += ".*";
    else if (ch === "_") source += ".";
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, flags);
}

// PostgREST list literal "(a,b,"c d")" -> ["a", "b", "c d"].
function parseList(value) {
  if (Array.isArray(value)) return value;
  const inner = String(value).replace(/^\(|\)$/g, "").replace(/^\{|\}$/g, "");
  return inner === "" ? [] : inner.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

function parseLiteral(value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function containsValue(haystack, needle) {
  if (Array.isArray(haystack)) {
    const list = Array.isArray(needle) ? needle : parseList(needle);
    return list.every((v) => haystack.some((h) => looseEqual(h, v)));
  }
  if (haystack && typeof haystack === "object" && needle && typeof needle === "object") {
    return Object.entries(needle).every(([k, v]) =>
      v && typeof v === "object" ? containsValue(haystack[k], v) : looseEqual(haystack[k], v));
  }
  return false;
}

// One comparison -> predicate over a column value.
export function makeTest(op, value) {
  switch (op) {
    case "eq": return (v) => looseEqual(v, value);
    case "neq": return (v) => !looseEqual(v, value);
    case "gt": return (v) => v != null && compare(v, value) > 0;
    case "gte": return (v) => v != null && compare(v, value) >= 0;
    case "lt": return (v) => v != null && compare(v, value) < 0;
    case "lte": return (v) => v != null && compare(v, value) <= 0;
    case "is": {
      const target = typeof value === "string" ? parseLiteral(value) : value;
      return (v) => (target === null ? v == null : v === target);
    }
    case "in": {
      const list = parseList(value);
      return (v) => list.some((item) => looseEqual(v, item));
    }
    case "like": {
      const re = likeToRegExp(value, "");
      return (v) => re.test(String(v ?? ""));
    }
    case "ilike": {
      const re = likeToRegExp(value, "i");
      return (v) => re.test(String(v ?? ""));
    }
    case "cs":
    case "contains": return (v) => containsValue(v, value);
    case "cd":
    case "containedBy": {
      const list = parseList(value);
      return (v) => Array.isArray(v) && v.every((item) => list.some((l) => looseEqual(l, item)));
    }
    case "ov":
    case "overlaps": {
      const list = parseList(value);
      return (v) => Array.isArray(v) && v.some((item) => list.some((l) => looseEqual(l, item)));
    }
    case "fts":
    case "plfts":
    case "phfts":
    case "wfts":
    case "textSearch": {
      const words = String(value).toLowerCase().replace(/['&|!:*()]/g, " ").split(/\s+/).filter(Boolean);
      return (v) => {
        const text = String(v ?? "").toLowerCase();
        return words.every((w) => text.includes(w));
      };
    }
    default:
      // Unknown operators pass through rather than hiding seeded rows.
      return () => true;
  }
}

// PostgREST `or` / `and` expression -> row predicate:
// "status.eq.live,name.ilike.%kestrel%,and(price.gte.10,price.lte.50)".
export function parseLogic(expression, joiner = "or") {
  const tests = splitTopLevel(expression).map((term) => {
    const group = term.match(/^(not\.)?(and|or)\((.*)\)$/s);
    if (group) {
      const inner = parseLogic(group[3], group[2]);
      return group[1] ? (row) => !inner(row) : inner;
    }
    const segments = term.split(".");
    const column = segments.shift();
    const negate = segments[0] === "not";
    if (negate) segments.shift();
    const op = segments.shift();
    const raw = segments.join(".");
    const test = makeTest(op, op === "in" || op === "cs" || op === "cd" || op === "ov" ? raw : parseLiteral(raw));
    const path = column.split(/->>?/);
    return (row) => (negate ? !test(readPath(row, path)) : test(readPath(row, path)));
  });
  return joiner === "and"
    ? (row) => tests.every((t) => t(row))
    : (row) => tests.some((t) => t(row));
}

class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.db = client.db;
    this.table = table;
    this.op = "select";
    this.selectSpec = parseSelect("*");
    this.returning = false;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.offset = 0;
    this.mode = "many";
    this.countOnly = false;
    this.payload = null;
    this.onConflict = "id";
    this.ignoreDuplicates = false;
    this.shouldThrow = false;
  }

  select(columns = "*", opts = {}) {
    this.selectSpec = parseSelect(columns);
    if (this.op !== "select") this.returning = true;
    if (opts.head) this.countOnly = true;
    return this;
  }

  insert(payload) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload, opts = {}) {
    this.op = "upsert";
    this.payload = payload;
    if (opts.onConflict) this.onConflict = opts.onConflict;
    if (opts.ignoreDuplicates) this.ignoreDuplicates = true;
    return this;
  }

  update(patch) {
    this.op = "update";
    this.payload = patch;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  where(column, test) {
    const path = String(column).split(/->>?/);
    this.filters.push((row) => test(readPath(row, path)));
    return this;
  }

  filter(column, op, value) {
    const negate = String(op).startsWith("not.");
    const bare = negate ? op.slice(4) : op;
    const test = makeTest(bare, value);
    return this.where(column, negate ? (v) => !test(v) : test);
  }

  eq(column, value) { return this.filter(column, "eq", value); }
  neq(column, value) { return this.filter(column, "neq", value); }
  gt(column, value) { return this.filter(column, "gt", value); }
  gte(column, value) { return this.filter(column, "gte", value); }
  lt(column, value) { return this.filter(column, "lt", value); }
  lte(column, value) { return this.filter(column, "lte", value); }
  is(column, value) { return this.filter(column, "is", value); }
  in(column, values) { return this.filter(column, "in", values); }
  like(column, pattern) { return this.filter(column, "like", pattern); }
  ilike(column, pattern) { return this.filter(column, "ilike", pattern); }
  contains(column, value) { return this.filter(column, "contains", value); }
  containedBy(column, value) { return this.filter(column, "containedBy", value); }
  overlaps(column, value) { return this.filter(column, "overlaps", value); }
  textSearch(column, query) { return this.filter(column, "textSearch", query); }

  not(column, op, value) {
    const test = makeTest(op, value);
    return this.where(column, (v) => !test(v));
  }

  match(obj) {
    for (const [column, value] of Object.entries(obj || {})) this.eq(column, value);
    return this;
  }

  or(expression, { foreignTable, referencedTable } = {}) {
    // Filters on an embedded table can't narrow the parent; let rows through.
    if (foreignTable || referencedTable) return this;
    this.filters.push(parseLogic(expression, "or"));
    return this;
  }

  order(column, { ascending = true, foreignTable, referencedTable } = {}) {
    if (!foreignTable && !referencedTable) this.orders.push({ path: String(column).split(/->>?/), ascending });
    return this;
  }

  limit(count, { foreignTable, referencedTable } = {}) {
    if (!foreignTable && !referencedTable) this.limitCount = count;
    return this;
  }

  range(from, to) {
    this.offset = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }
  throwOnError() { this.shouldThrow = true; return this; }

  // supabase-js modifiers with no meaning here.
  abortSignal() { return this; }
  returns() { return this; }
  overrideTypes() { return this; }
  csv() { return this; }
  explain() { return this; }

  matches(row) {
    return this.filters.every((test) => test(row));
  }

  rows() {
    return this.db.table(this.client.resolveTable(this.table));
  }

  write() {
    const tableName = this.client.resolveTable(this.table);
    const rows = this.db.table(tableName);
    const hooks = this.client.hooks;
    const now = new Date().toISOString();

    if (this.op === "insert" || this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(clone);
      const keys = this.onConflict.split(",").map((k) => k.trim());
      const blocked = hooks.beforeWrite?.({ op: this.op, table: tableName, input: list, db: this.db });
      if (blocked?.error) return { blocked };
      const written = [];
      for (const input of list) {
        const existing = this.op === "upsert"
          ? rows.find((r) => keys.every((k) => input[k] !== undefined && looseEqual(r[k], input[k])))
          : null;
        if (existing) {
          if (this.ignoreDuplicates) continue;
          Object.assign(existing, input, "updated_at" in existing ? { updated_at: now } : {});
          written.push(existing);
        } else {
          const row = this.client.defaults(tableName, input);
          rows.unshift(row);
          written.push(row);
        }
      }
      hooks.afterWrite?.({ op: this.op, table: tableName, rows: written, db: this.db });
      return { written, status: 201 };
    }

    const matched = rows.filter((row) => this.matches(row));

    if (this.op === "update") {
      const patch = clone(this.payload) || {};
      const blocked = hooks.beforeWrite?.({ op: "update", table: tableName, rows: matched, patch, db: this.db });
      if (blocked?.error) return { blocked };
      for (const row of matched) {
        Object.assign(row, patch, "updated_at" in row && !("updated_at" in patch) ? { updated_at: now } : {});
      }
      hooks.afterWrite?.({ op: "update", table: tableName, rows: matched, patch, db: this.db });
      return { written: matched, status: 200 };
    }

    // delete
    const blocked = hooks.beforeWrite?.({ op: "delete", table: tableName, rows: matched, db: this.db });
    if (blocked?.error) return { blocked };
    this.db.replaceTable(tableName, rows.filter((row) => !matched.includes(row)));
    hooks.afterWrite?.({ op: "delete", table: tableName, rows: matched, db: this.db });
    return { written: matched, status: 200 };
  }

  execute() {
    const tableName = this.client.resolveTable(this.table);
    let result;
    let status = 200;

    if (this.op === "select") {
      result = this.rows().filter((row) => this.matches(row));
    } else {
      const outcome = this.write();
      if (outcome.blocked) {
        const { message, code, status: blockedStatus } = outcome.blocked.error;
        return error(message, code || "PLAYGROUND_RULE", blockedStatus || 409);
      }
      if (!this.returning) return { data: null, error: null, count: null, status: outcome.status };
      result = outcome.written;
      status = outcome.status;
    }

    // `rel!inner(...)` drops parents whose embed is empty.
    const innerSpecs = this.selectSpec.filter((s) => s.kind === "embed" && s.inner);
    if (innerSpecs.length) {
      result = result.filter((row) =>
        innerSpecs.every((spec) => {
          const value = this.client.resolveEmbed(tableName, row, spec);
          return Array.isArray(value) ? value.length > 0 : value != null;
        }));
    }

    if (this.orders.length) {
      result = [...result].sort((a, b) => {
        for (const { path, ascending } of this.orders) {
          const diff = compare(readPath(a, path), readPath(b, path));
          if (diff !== 0) return ascending ? diff : -diff;
        }
        return 0;
      });
    }

    const count = result.length;
    if (this.countOnly) return { data: null, count, error: null, status };

    if (this.offset) result = result.slice(this.offset);
    if (this.limitCount != null) result = result.slice(0, this.limitCount);

    const data = result.map((row) => this.client.project(tableName, row, this.selectSpec));

    if (this.mode === "single") {
      if (data.length !== 1) {
        return {
          ...error("JSON object requested, multiple (or no) rows returned", "PGRST116", 406),
          count: null,
        };
      }
      return { data: data[0], error: null, count: null, status };
    }
    if (this.mode === "maybeSingle") {
      if (data.length > 1) {
        return { ...error("JSON object requested, multiple rows returned", "PGRST116", 406), count: null };
      }
      return { data: data[0] ?? null, error: null, count: null, status };
    }
    return { data, count, error: null, status };
  }

  then(resolve, reject) {
    let out;
    try {
      out = this.execute();
    } catch (e) {
      out = error(e?.message || "playground query failed", "PLAYGROUND_FAILURE", 500);
    }
    if (this.shouldThrow && out.error) return Promise.reject(out.error).then(resolve, reject);
    return Promise.resolve(out).then(resolve, reject);
  }

  catch(reject) {
    return this.then(undefined, reject);
  }

  finally(fn) {
    return this.then().finally(fn);
  }
}

// supabase.rpc() returns a builder too; support the modifiers code chains on it.
class RpcCall {
  constructor(run) {
    this.run = run;
    this.mode = "many";
  }

  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }
  select() { return this; }
  abortSignal() { return this; }
  throwOnError() { return this; }
  returns() { return this; }

  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.run())
      .then((out) => {
        if (out?.error || this.mode === "many" || !Array.isArray(out?.data)) return out;
        return { ...out, data: out.data[0] ?? null };
      })
      .catch((e) => error(e?.message || "playground rpc failed", "PLAYGROUND_FAILURE", 500))
      .then(resolve, reject);
  }
}

function createStorage(objects, { publicBase = "" } = {}) {
  const key = (bucket, path) => `${bucket}/${path}`;
  return {
    from(bucket) {
      return {
        async upload(path, file) {
          const url = typeof URL !== "undefined" && URL.createObjectURL && file instanceof Blob
            ? URL.createObjectURL(file)
            : "";
          objects.set(key(bucket, path), { url, size: file?.size ?? 0, type: file?.type ?? "", created_at: new Date().toISOString() });
          return { data: { path, fullPath: key(bucket, path), id: key(bucket, path) }, error: null };
        },
        async update(path, file) {
          return this.upload(path, file);
        },
        getPublicUrl(path) {
          const stored = objects.get(key(bucket, path));
          const publicUrl = stored?.url || (/^https?:/.test(path) ? path : `${publicBase}${path}`);
          return { data: { publicUrl } };
        },
        async createSignedUrl(path) {
          return { data: { signedUrl: this.getPublicUrl(path).data.publicUrl }, error: null };
        },
        async createSignedUrls(paths) {
          return {
            data: paths.map((path) => ({ path, signedUrl: this.getPublicUrl(path).data.publicUrl, error: null })),
            error: null,
          };
        },
        async createSignedUploadUrl(path) {
          return { data: { signedUrl: "", token: "playground", path }, error: null };
        },
        async uploadToSignedUrl(path, _token, file) {
          return this.upload(path, file);
        },
        async download(path) {
          const stored = objects.get(key(bucket, path));
          if (!stored?.url) return { data: null, error: { message: "Not available in the playground" } };
          const blob = await fetch(stored.url).then((r) => r.blob());
          return { data: blob, error: null };
        },
        async remove(paths) {
          for (const path of paths) objects.delete(key(bucket, path));
          return { data: paths.map((name) => ({ name })), error: null };
        },
        async move(from, to) {
          const stored = objects.get(key(bucket, from));
          if (stored) {
            objects.set(key(bucket, to), stored);
            objects.delete(key(bucket, from));
          }
          return { data: { message: "moved" }, error: null };
        },
        async copy(from, to) {
          const stored = objects.get(key(bucket, from));
          if (stored) objects.set(key(bucket, to), stored);
          return { data: { path: to }, error: null };
        },
        async list(prefix = "") {
          const start = key(bucket, prefix ? `${prefix.replace(/\/$/, "")}/` : "");
          const data = [...objects.entries()]
            .filter(([k]) => k.startsWith(start))
            .map(([k, v]) => ({ name: k.slice(start.length), id: k, created_at: v.created_at, metadata: { size: v.size, mimetype: v.type } }));
          return { data, error: null };
        },
      };
    },
  };
}

function createAuth(getUser) {
  const session = () => ({ user: getUser(), access_token: "playground", refresh_token: "playground", expires_at: 4102444800 });
  const unavailable = async () => ({ data: { user: null, session: null }, error: { message: "Sign-in isn't available in the playground" } });
  return {
    getSession: async () => ({ data: { session: session() }, error: null }),
    getUser: async () => ({ data: { user: getUser() }, error: null }),
    getClaims: async () => ({
      data: { claims: { sub: getUser().id, email: getUser().email, role: "authenticated" } },
      error: null,
    }),
    refreshSession: async () => ({ data: { session: session(), user: getUser() }, error: null }),
    onAuthStateChange: (callback) => {
      queueMicrotask(() => {
        try {
          callback?.("INITIAL_SESSION", session());
        } catch {
          // A listener throwing must not break the playground.
        }
      });
      return { data: { subscription: { unsubscribe() {} } } };
    },
    updateUser: async (attrs = {}) => {
      const user = getUser();
      if (attrs.data) user.user_metadata = { ...(user.user_metadata || {}), ...attrs.data };
      if (attrs.email) user.email = attrs.email;
      return { data: { user }, error: null };
    },
    signOut: async () => ({ error: null }),
    signInWithPassword: unavailable,
    signInWithOAuth: unavailable,
    signInWithOtp: unavailable,
    signUp: unavailable,
    verifyOtp: unavailable,
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    exchangeCodeForSession: unavailable,
    setSession: async () => ({ data: { session: session(), user: getUser() }, error: null }),
    mfa: {
      listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }),
    },
  };
}

function createChannel(name) {
  const channel = {
    topic: name,
    on: () => channel,
    subscribe: (callback) => {
      queueMicrotask(() => {
        try {
          callback?.("SUBSCRIBED");
        } catch {
          // ignore
        }
      });
      return channel;
    },
    unsubscribe: async () => "ok",
    send: async () => "ok",
    track: async () => "ok",
    untrack: async () => "ok",
    presenceState: () => ({}),
  };
  return channel;
}

/**
 * createMemoryClient({
 *   getDb,       () => { table(name) -> rows[], replaceTable(name, rows), has(name) }
 *   user,        Supabase-shaped auth user { id, email, user_metadata }
 *   fkTables,    { owner_id: "profiles" }  embed-by-FK-column targets that don't follow `<thing>_id -> <things>`
 *   childFks,    { "galleries.gallery_items": "gallery_id" }  one-to-many FKs that aren't `<singular parent>_id`
 *   rpc,         { name: ({ db, args, user }) => data | { data, error } }
 *   functions,   { name: ({ db, body, user }) => data | { data, error } }   for functions.invoke
 *   hooks,       { beforeWrite({op, table, input|rows, patch, db}) -> {error}?, afterWrite({op, table, rows, patch, db}) }
 *   defaults,    (table, row) => row   extra columns for inserted rows
 *   storageBase, prefix for storage paths that aren't full URLs (e.g. a public CDN base)
 * })
 */
export function createMemoryClient({
  getDb,
  user,
  fkTables = {},
  childFks = {},
  rpc = {},
  functions = {},
  hooks = {},
  defaults,
  storageBase = "",
}) {
  const db = getDb();
  const objects = new Map();

  const core = {
    db,
    hooks,
    defaults(table, row) {
      const now = new Date().toISOString();
      const base = { id: globalThis.crypto.randomUUID(), created_at: now, updated_at: now };
      const merged = { ...base, ...row };
      return defaults ? defaults(table, merged) : merged;
    },
    resolveTable(table) {
      return table;
    },
    // Many-to-one / one-to-many embed resolution for one row.
    resolveEmbed(table, row, spec) {
      const shape = (found, target) => (found ? core.project(target, found, spec.columns) : null);

      // `owner:profiles!owner_id(name)` -> FK column named by the hint.
      if (spec.hint && !spec.inner && spec.hint in row) {
        const found = row[spec.hint] ? db.table(spec.source).find((r) => looseEqual(r.id, row[spec.hint])) : null;
        return shape(found, spec.source);
      }
      // `asset:asset_id(id, name)` -> embed named by its FK column.
      if (spec.source in fkTables || (spec.source.endsWith("_id") && spec.source in row)) {
        const target = fkTables[spec.source] || plural(spec.source.replace(/_id$/, ""));
        const id = row[spec.source];
        const found = id ? db.table(target).find((r) => looseEqual(r.id, id)) : null;
        return shape(found, target);
      }
      // `assets(name)` on a row with `asset_id` -> many-to-one by table name.
      const fk = `${singular(spec.source)}_id`;
      if (fk in row) {
        const found = row[fk] ? db.table(spec.source).find((r) => looseEqual(r.id, row[fk])) : null;
        return shape(found, spec.source);
      }
      // `items:collection_assets(count)` -> one-to-many.
      const childFk = childFks[`${table}.${spec.source}`] || `${singular(table)}_id`;
      const children = db
        .table(spec.source)
        .filter((r) => looseEqual(r[childFk], row.id) && r.deleted_at == null);
      if (isCountOnly(spec.columns)) return [{ count: children.length }];
      return children.map((c) => core.project(spec.source, c, spec.columns));
    },
    project(table, row, selectSpec) {
      const hasStar = selectSpec.some((s) => s.kind === "column" && s.name === "*");
      const out = hasStar ? clone(row) : {};
      for (const spec of selectSpec) {
        if (spec.kind === "column") {
          if (spec.name !== "*") out[spec.alias] = clone(readPath(row, spec.path)) ?? null;
        } else {
          out[spec.alias] = core.resolveEmbed(table, row, spec);
        }
      }
      return out;
    },
  };

  function scoped(schemaName) {
    const view = Object.create(core);
    view.resolveTable = (table) => {
      const qualified = schemaName ? `${schemaName}.${table}` : null;
      return qualified && db.has?.(qualified) ? qualified : table;
    };
    return view;
  }

  function makeClient(schemaName = null) {
    const view = scoped(schemaName);
    const client = {
      auth,
      storage,
      functions: functionsApi,
      realtime: { setAuth() {} },
      from: (table) => new QueryBuilder(view, table),
      schema: (name) => makeClient(name),
      rpc: (name, args) =>
        new RpcCall(async () => {
          const handler = rpc[name];
          if (!handler) {
            console.warn(`[playground] unhandled rpc ${name}`);
            return error("Not available in the playground", "PLAYGROUND_UNAVAILABLE", 501);
          }
          const out = await handler({ db, args: args || {}, user });
          return out && typeof out === "object" && ("data" in out || "error" in out)
            ? { data: out.data ?? null, error: out.error ?? null, status: out.error ? 400 : 200 }
            : { data: out ?? null, error: null, status: 200 };
        }),
      channel: (name) => createChannel(name),
      removeChannel: async () => "ok",
      removeAllChannels: async () => [],
      getChannels: () => [],
    };
    return client;
  }

  const auth = createAuth(() => user);
  const storage = createStorage(objects, { publicBase: storageBase });
  const functionsApi = {
    async invoke(name, { body } = {}) {
      const handler = functions[name];
      if (!handler) {
        console.warn(`[playground] unhandled function ${name}`);
        return { data: null, error: { message: "Not available in the playground" } };
      }
      const out = await handler({ db, body, user });
      return out && typeof out === "object" && ("data" in out || "error" in out)
        ? { data: out.data ?? null, error: out.error ?? null }
        : { data: out ?? null, error: null };
    },
  };

  return makeClient(null);
}

/**
 * The playground's in-memory database: every seeded table, built lazily the
 * first time the playground queries it and kept for the rest of the page
 * session, so edits survive tab switches but a reload starts fresh.
 *
 *   export const getPlaygroundDb = createMemoryDb(() => ({ forms: [...], responses: [...] }));
 */
export function createMemoryDb(buildTables) {
  let tables = null;
  const db = {
    table(name) {
      if (!tables[name]) tables[name] = [];
      return tables[name];
    },
    replaceTable(name, rows) {
      tables[name] = rows;
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(tables, name);
    },
    tableNames() {
      return Object.keys(tables);
    },
  };
  return function getDb() {
    if (!tables) tables = buildTables();
    return db;
  };
}
