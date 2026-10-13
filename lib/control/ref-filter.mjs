// Tables keyed by a uuid `id` plus a short `public_id` accept either as a ref.
// A public id (e.g. "hgltfr3viw") must not be compared against the uuid column:
// PostgREST casts it and fails the whole query.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST `.or()` filter matching `ref` by id or public_id. Callers validate `ref` first. */
export const refFilter = (ref) => (UUID.test(ref) ? `id.eq.${ref},public_id.eq.${ref}` : `public_id.eq.${ref}`);
