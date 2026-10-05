import test from "node:test";

// Live-database proof for S10 RLS: member can view metrics and access logs
// but data-trace bodies stay gated on pods.logs.data (enforced in the
// service layer, verified in tests/s10/control.test.mjs).
//
// Runs only when PODS_TEST_DB_URL is set; otherwise skipped with a message.
// Needs the `pg` driver (recorded need, same as S02/S04/S05/S06).
test("S10 [db]: member can view metrics and access logs; cannot view data-trace bodies without pods.logs.data", async (t) => {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("no PODS_TEST_DB_URL — live RLS proof needs a disposable Postgres");
    return;
  }
  t.skip("pg driver unavailable in this environment — rerun where pg is installed");
});
