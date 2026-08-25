const { getDb } = require('./lib/db');

// retention-sweep — the scheduled prune the privacy policy has been waiting
// for. Until this existed, every rate-limit and usage row lived forever: the
// limiters only COUNT a recent window, they never delete, so the policy had
// to say "kept indefinitely". This function makes the original promises true
// again. Invoked by EventBridge (journaled-retention-sweep-daily, 05:30 UTC —
// after the RDS backup window at 04:19–04:49) and by nothing else: no API
// Gateway route, no authorizer, no user input of any kind reaches SQL — every
// table name and predicate below is a module constant.
//
// EVERY WINDOW IS DERIVED FROM AN ENFORCEMENT WINDOW IN CODE, with slack, in
// EXPLICIT HOURS so no timezone or DST arithmetic can narrow it:
//   demo_events        48h  — limiter counts 24h (demo-summary).
//   anon_rate_events   48h  — longest window 24h (contact_*; auth kinds 1h).
//   usage_events       840h (35d) — longest window 168h; the master doc calls
//                      35 days a FLOOR (rolling 7-day report window plus the
//                      planned monthly gate). Also the spend-visibility
//                      ledger: 35 days of history is the accepted cost.
//   email_tokens       168h past expires_at — TTL is 15min/24h, consumption
//                      rejects at expiry; a week of slack keeps recent rows
//                      for debugging a reported email problem.
//   summary_jobs       840h, UNSAVED ONLY — an unsaved report is one the user
//                      chose not to keep; it is invisible in the app and was
//                      previously retained forever (audit finding). saved
//                      rows are journal content and are NEVER touched here.
//
// OPERATIONAL SHAPE (per pre-deploy review):
// - Created with --timeout 900 and reserved concurrency 1, so a scheduled run
//   and an async retry can never overlap and contend for the same batches.
// - statement_timeout/lock_timeout set per invocation: a sweep must never
//   hold the live limiters hostage; better to fail a batch and retry.
// - Batched ctid deletes (BATCH rows per statement, each its own committed
//   transaction) so a months-deep first run holds no long locks; the time
//   guard stops with 20s left and THROWS — completed batches stay deleted,
//   and Lambda's async retry (twice, by default) picks up the remainder.
//   Double delivery is harmless: both runs apply the same age predicates.
//
// ⚠️ INDEXES — run once in psql as admin when these tables grow (CONCURRENTLY
// cannot run from here; it needs table privileges this role lacks):
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS demo_events_created_idx      ON demo_events (created_at);
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS anon_rate_events_created_idx ON anon_rate_events (created_at);
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_events_created_idx     ON usage_events (created_at);
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS email_tokens_expires_idx     ON email_tokens (expires_at);
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS summary_jobs_unsaved_idx     ON summary_jobs (created_at) WHERE saved = false;

const BATCH = 5000;
const STOP_WITH_MS_LEFT = 20000;

const SWEEPS = [
  { table: 'demo_events',      predicate: `created_at < now() - interval '48 hours'` },
  { table: 'anon_rate_events', predicate: `created_at < now() - interval '48 hours'` },
  { table: 'usage_events',     predicate: `created_at < now() - interval '840 hours'` },
  { table: 'email_tokens',     predicate: `expires_at < now() - interval '168 hours'` },
  { table: 'summary_jobs',     predicate: `saved = false AND created_at < now() - interval '840 hours'` },
];

exports.handler = async (event, context) => {
  const db = await getDb();
  // Per-invocation: the cached client may carry these from a warm start, but
  // setting them again is free and forgetting them is not.
  await db.query(`SET statement_timeout = '60s'`);
  await db.query(`SET lock_timeout = '5s'`);

  const results = {};
  for (const { table, predicate } of SWEEPS) {
    let total = 0;
    for (;;) {
      if (context && context.getRemainingTimeInMillis() < STOP_WITH_MS_LEFT) {
        console.error(`retention-sweep: out of time at ${table} (${JSON.stringify(results)}, partial ${total}) — throwing for async retry`);
        throw new Error('retention-sweep: timed out, retry will continue');
      }
      const r = await db.query(
        `DELETE FROM ${table} WHERE ctid IN (
           SELECT ctid FROM ${table} WHERE ${predicate} LIMIT ${BATCH}
         )`
      );
      total += r.rowCount;
      if (r.rowCount < BATCH) break;
    }
    results[table] = total;
  }
  console.log('retention-sweep:', JSON.stringify(results));
  return results;
};
