const { getDb } = require('./lib/db');
const { resetDemo } = require('./lib/demo-seed');
const {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} = require('@aws-sdk/client-cloudwatch-logs');

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
// THE SIXTH SWEEP IS NOT A TABLE. The policy's log clause is universal —
// "Operational logs expire after 30 days. Every log group carries that
// retention policy." — and AWS creates every new log group with NO expiry, so
// the sentence goes false the moment a Lambda is born and nothing anywhere
// says so. It happened: journaled-refine's group sat unbounded from creation
// until it was noticed by hand. A promise that depends on remembering a
// console step is a promise that breaks, so the job that exists to make the
// retention clauses true now enforces that one too — self-healing, at most a
// day of exposure, instead of forever. Logs matter here for the same reason
// rows do: error text can carry fragments of a person's work.
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
// The number the privacy policy commits to for operational logs. Changing it
// here without changing Section 7 makes the policy false; they move together.
const LOG_RETENTION_DAYS = 30;

const SWEEPS = [
  { table: 'demo_events',      predicate: `created_at < now() - interval '48 hours'` },
  { table: 'anon_rate_events', predicate: `created_at < now() - interval '48 hours'` },
  { table: 'usage_events',     predicate: `created_at < now() - interval '840 hours'` },
  { table: 'email_tokens',     predicate: `expires_at < now() - interval '168 hours'` },
  { table: 'summary_jobs',     predicate: `saved = false AND created_at < now() - interval '840 hours'` },
];

// Bring every log group up to the policy's ceiling. Sets retention when a
// group has NONE (the AWS default for a newly created group) or when it is
// LONGER than promised. A shorter retention is left alone: it keeps less than
// the policy allows, which breaks nothing, and overwriting it would stomp a
// deliberate choice. Paginated because DescribeLogGroups is.
async function sweepLogRetention() {
  const logs = new CloudWatchLogsClient({});
  const fixed = [];
  let nextToken;
  do {
    const page = await logs.send(new DescribeLogGroupsCommand({ nextToken }));
    for (const g of page.logGroups || []) {
      const current = g.retentionInDays;
      if (current == null || current > LOG_RETENTION_DAYS) {
        await logs.send(
          new PutRetentionPolicyCommand({
            logGroupName: g.logGroupName,
            retentionInDays: LOG_RETENTION_DAYS,
          })
        );
        fixed.push(`${g.logGroupName} (was ${current == null ? 'never' : current + 'd'})`);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return fixed;
}

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

  // DEMO RESET (Sep 21). The shared demo@journaled.io account is wiped and
  // re-seeded here, on the same nightly schedule, because this is the one
  // function that already runs unattended against the journal tables. It
  // sits AFTER the sweeps (so a slow reset can't starve them of the time
  // budget) and BEFORE the log-retention step (which is allowed to throw and
  // must not take the reset down with it). Its own failure is CAUGHT and
  // logged rather than thrown: an un-reset demo account is a cosmetic
  // problem for tomorrow's visitor, not a policy breach, and it must never
  // trip the errors alarm that exists for the retention promises above.
  // resetDemo is transactional — a failure leaves yesterday's fixture
  // intact, never an empty account. Seeded summaries carry a NULL
  // prompt_version on purpose: a human wrote them, no model did, and the
  // provenance column should say so. See lib/demo-seed.js.
  try {
    const demo = await resetDemo(db);
    results.demo_reset = demo.present ? demo : 'absent';
    console.log('retention-sweep: demo reset', JSON.stringify(demo));
  } catch (e) {
    results.demo_reset = 'failed';
    console.error('retention-sweep: demo reset FAILED (journal left as-is):', e.message);
  }

  // LAST, and after the row results are already logged: a CloudWatch failure
  // must never cost us the record of the database work that succeeded. This is
  // deliberately allowed to THROW — a persistent failure here trips the
  // journaled-retention-sweep-errors alarm, which is the whole point. Lambda's
  // async retry re-runs the sweeps above, which is safe: they are idempotent
  // and the second pass finds nothing left to delete.
  const fixedGroups = await sweepLogRetention();
  if (fixedGroups.length) {
    // WARN, not log: a group needing this means something was created without
    // its retention set, and the policy was briefly false. Worth seeing.
    console.warn(
      `retention-sweep: set ${LOG_RETENTION_DAYS}d retention on ${fixedGroups.length} log group(s): ${fixedGroups.join(', ')}`
    );
  }
  results.log_groups_fixed = fixedGroups.length;

  console.log('retention-sweep complete:', JSON.stringify(results));
  return results;
};
