/**
 * REST API resource matcher (pure, `lib/gateway/core/match/`).
 *
 * Walks the resource tree segment by segment: literal child first, then
 * the single variable child, then a greedy child (which consumes the
 * rest), backtracking when a deeper branch fails — so `/a/{b}/c` vs
 * `/a/x/{d}` resolves to the most-specific literal. Method selection on
 * the matched resource is exact method, else `ANY` (`HEAD` never falls
 * back to `GET`; `ANY` covers it). One trailing slash on the request
 * path is ignored (`/pets/` === `/pets`), as in REST APIs.
 *
 * Returns the resource even when no method matches (`methodId: null`);
 * the caller renders `MISSING_AUTHENTICATION_TOKEN` (403), or 404 when
 * `missing_route_behavior` is `not_found`. Returns null when no resource
 * matches at all.
 *
 * @module lib/gateway/core/match/rest-resources
 */

import {
  RoutePatternError,
  decodeParam,
  parsePathPart,
  splitRequestPath,
} from "./path-parts.mjs";

export { RoutePatternError };

/**
 * Parses a stored resource path (`/`, `/pets`, `/pets/{id}`, `/pets/{proxy+}`).
 *
 * @param {string} path full resource path.
 * @returns {Array} segments (root `/` becomes `[]`).
 * @throws {RoutePatternError} when the path is malformed or greedy is not last.
 */
export function parseResourcePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new RoutePatternError(`Invalid resource path "${path}": must start with "/".`);
  }
  if (path === "/") return [];
  const segments = path.slice(1).split("/").map(parsePathPart);
  segments.forEach((segment, index) => {
    if (segment.kind === "greedy" && index !== segments.length - 1) {
      throw new RoutePatternError(
        `Invalid resource path "${path}": greedy segment "${segment.raw}" must be the last segment.`,
      );
    }
  });
  return segments;
}

function newNode() {
  return {
    resourceId: null,
    resourcePath: null,
    literals: new Map(),
    param: null,
    greedy: null,
  };
}

/**
 * Compiles resource + method rows once per artifact into a trie.
 * A second variable child with a different name keeps the first
 * (draft validation forbids it; the engine stays deterministic anyway).
 *
 * @param {Array<{ id: string, path: string }>} resources draft resource rows.
 * @param {Array<{ id: string, resourceId: string, httpMethod: string }>} methods draft method rows.
 * @returns {{ root: object, methodsByResource: Map<string, Map<string, object>> }}
 */
export function compileRestResources(resources, methods) {
  const root = newNode();
  for (const resource of resources ?? []) {
    const segments = parseResourcePath(resource.path);
    let node = root;
    let greedy = false;
    for (const segment of segments) {
      if (segment.kind === "literal") {
        if (!node.literals.has(segment.value)) node.literals.set(segment.value, newNode());
        node = node.literals.get(segment.value);
      } else if (segment.kind === "param") {
        if (!node.param) node.param = { name: segment.name, node: newNode() };
        node = node.param.node;
      } else {
        if (!node.greedy) {
          node.greedy = { name: segment.name, resourceId: resource.id, resourcePath: resource.path };
        }
        greedy = true;
        break;
      }
    }
    if (!greedy) {
      node.resourceId = resource.id;
      node.resourcePath = resource.path;
    }
  }
  const methodsByResource = new Map();
  for (const row of methods ?? []) {
    if (!methodsByResource.has(row.resourceId)) methodsByResource.set(row.resourceId, new Map());
    const byMethod = methodsByResource.get(row.resourceId);
    if (!byMethod.has(row.httpMethod)) byMethod.set(row.httpMethod, row);
  }
  return { root, methodsByResource };
}

function finish(node, captures) {
  if (!node.resourceId) return null;
  return { resourceId: node.resourceId, resourcePath: node.resourcePath, captures: [...captures] };
}

function walk(node, segs, index, captures) {
  if (index === segs.length) return finish(node, captures);
  const segment = segs[index];
  const literal = node.literals.get(segment);
  if (literal) {
    const found = walk(literal, segs, index + 1, captures);
    if (found) return found;
  }
  if (node.param && segment !== "") {
    captures.push({ name: node.param.name, value: segment });
    const found = walk(node.param.node, segs, index + 1, captures);
    captures.pop();
    if (found) return found;
  }
  if (node.greedy && segs.length - index >= 1) {
    return {
      resourceId: node.greedy.resourceId,
      resourcePath: node.greedy.resourcePath,
      captures: [...captures, { name: node.greedy.name, values: segs.slice(index) }],
    };
  }
  return null;
}

/**
 * Matches a REST request against compiled resources and methods.
 *
 * @param {{ root: object, methodsByResource: Map }} compiled from {@link compileRestResources}.
 * @param {string} method request HTTP method.
 * @param {string} path request path without stage/base path or query.
 * @returns {{ resourceId: string, resourcePath: string, methodId: string|null, httpMethod: string|null, pathParameters: Record<string,string> } | null}
 */
export function matchRestResource(compiled, method, path) {
  let clean = String(path ?? "");
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  const segs = splitRequestPath(clean);
  const found = walk(compiled.root, segs, 0, []);
  if (!found) return null;
  const pathParameters = {};
  for (const capture of found.captures) {
    if (Array.isArray(capture.values)) {
      pathParameters[capture.name] = capture.values.map(decodeParam).join("/");
    } else {
      pathParameters[capture.name] = decodeParam(capture.value);
    }
  }
  const byMethod = compiled.methodsByResource.get(found.resourceId);
  const chosen = byMethod?.get(method) ?? byMethod?.get("ANY") ?? null;
  return {
    resourceId: found.resourceId,
    resourcePath: found.resourcePath,
    methodId: chosen?.id ?? null,
    httpMethod: chosen?.httpMethod ?? null,
    pathParameters,
  };
}
