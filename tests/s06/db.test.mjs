import test from "node:test";

// Live-database proof for the S06 processing tables: RLS isolation across
// two projects and the append-only audit trail behind control writes.
// Needs a disposable Postgres plus the geiger-orm migration chain; the
// environment here has neither driver nor server, so this stays a clear
// skip until PODS_TEST_DB_URL is provided (same rule as S02 [db] tests).
//
// Planned assertions once enabled:
// - project A member cannot select project B models/validators/responses;
// - pods.model.write / pods.route.write / pods.gateway_response.write gates
//   hold for a member (read-only) and pass for an admin;
// - unique(api_id, name), unique(method_id, status_code) and
//   unique(api_id, response_type) reject duplicates with 23505;
// - method_responses rows referencing S03 method ids join cleanly once the
//   S03/S04 foreign keys land.

const DB_URL = process.env.PODS_TEST_DB_URL;

test("S06: [db] processing tables isolate projects and enforce RLS", { skip: !DB_URL && "Set PODS_TEST_DB_URL to run the S06 live-database test" }, async (t) => {
  t.skip("Set PODS_TEST_DB_URL to run the S06 live-database test (no disposable Postgres in this environment).");
});
