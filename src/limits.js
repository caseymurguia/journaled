// Per-user rate limits, per tier. The realistic threat isn't a breach — it's a
// runaway loop (a script, a stolen session, a retry storm) burning real money
// in model tokens. Attempts are logged to usage_events rather than inferred
// from saved rows: an attacker hammering /parse never SAVES anything, so
// counting work_sessions would miss exactly the case that costs money.
//
// TIER DOCTRINE (Jul 31):
//   FREE — limits are marketed product lines (the pricing page says "10
//   captures a day", "2 reports a week"); 429s name the limit plainly, in
//   report/capture vocabulary ("summary" is reserved for the daily account
//   every capture includes — never a countable thing).
//   PRO — limits are INVISIBLE abuse ceilings; a Pro 429 never says "limit"
//   or "daily", because the page says Unlimited and means it for humans.
//   OWNER — exempt but LOGGED: spend stays visible in usage_events, friction
//   doesn't exist. Test accounts are deliberately NOT owners — they exist to
//   experience the product as free users do.
//
// WINDOWS ARE PER-KIND (Aug 6). Reports moved to 2 per WEEK while captures and
// saves stayed daily, so a single hardcoded 24h interval no longer works. All
// windows are ROLLING, never calendar: no timezone question, no midnight
// stampede, and capacity returns gradually rather than all at once.
//
// REPORTS ARE COUNTED ON GENERATION, NOT SAVES — generation is what costs
// money. The tradeoff is accepted and real: a wasted generation burns a slot,
// which is why the free cap is 2 rather than 1, and why the caller's error
// state matters (a user who generates for the wrong dates must be told what
// happened, not just walled).

const { DEMO_EMAIL } = require('./demo-seed');

const OWNER_USER_IDS = new Set([
  '00000000-0000-4000-8000-000000000001', // owner account (placeholder)
  '00000000-0000-4000-8000-000000000002', // owner account (placeholder)
]);

// max = attempts allowed; hours = the rolling window they're counted over.
const LIMITS = {
  free: {
    capture: { max: 10, hours: 24 },
    summary: { max: 2, hours: 168 },  // report generations — 2 a week
    save:    { max: 10, hours: 24 },
    // Refine is Pro-only (decision Aug 24, superseding the v29 free-launch
    // giveaway). The Lambda's tier gate answers free users with the upsell
    // BEFORE this limiter runs; max 0 is the belt-and-braces backstop so a
    // gate bug still refuses rather than serving a Pro feature for free.
    refine:  { max: 0, hours: 24 },
  },
  pro: {
    capture: { max: 100, hours: 24 },   // invisible ceilings, machines only
    summary: { max: 100, hours: 168 },
    save:    { max: 100, hours: 24 },
    refine:  { max: 200, hours: 24 },   // generous: refines are cheap fixes
  },
  // DEMO (Sep 21) — the shared, publicly-credentialed demo@journaled.io
  // account (lib/demo-seed.js). Its password is in the showcase README, so
  // every visitor on the internet shares these caps. They are sized so the
  // account can show off every Pro feature to a curious visitor and the
  // worst an abusive one can do is a few dollars a day. All windows are
  // 24h, not weekly: the journal itself is reset nightly, and a cap that
  // outlives the reset would confuse the next morning's visitor. The 429
  // copy names the shared account plainly and points at signup — this is
  // the one tier where the limit message is allowed to sell.
  demo: {
    capture: { max: 10, hours: 24 },
    summary: { max: 5,  hours: 24 },
    save:    { max: 20, hours: 24 },
    refine:  { max: 5,  hours: 24 },
  },
};

function limitMessage(tier, kind, rule) {
  if (tier === 'pro') {
    return 'Unusually high activity — please try again in a bit.';
  }
  if (tier === 'demo') {
    return 'The shared demo account has hit its daily limit — it resets overnight. Create your own account to keep going.';
  }
  // NOTE: this message doesn't reference rule.max — change the cap and the
  // copy won't follow.
  if (kind === 'summary') {
    return 'That\'s both for this week — Pro has no limits :)';
  }
  if (kind === 'refine') {
    // Only reachable if the Lambda's own Pro gate is bypassed; still honest.
    return 'Refining summaries is a Pro feature.';
  }
  return `Daily capture limit reached (${rule.max})`;
}

async function checkDailyLimit(db, userId, kind) {
  // Fail CLOSED on an unknown kind: a typo'd caller should blow up in testing,
  // not silently run unlimited.
  if (!LIMITS.free[kind]) throw new Error(`Unknown rate-limit kind: ${kind}`);

  // Owner: exempt but logged — the attempt row keeps spend visible.
  if (OWNER_USER_IDS.has(userId)) {
    await db.query(
      `INSERT INTO usage_events (user_id, kind) VALUES ($1, $2)`,
      [userId, kind]
    );
    return null;
  }

  // Tier is read server-side from the DB, never the JWT (is_subscribed is
  // baked into a 30-day token and goes stale on mid-session upgrades).
  const u = await db.query(`SELECT is_subscribed, email FROM users WHERE id = $1`, [userId]);
  if (u.rows.length === 0) throw new Error(`Rate limit check for unknown user: ${userId}`);
  // Demo is checked FIRST: the account is is_subscribed = TRUE so Refine and
  // the Pro surfaces work for visitors, but it must never inherit Pro's
  // invisible ceilings. Matched by email, not id, so a fresh environment that
  // recreates the account (scripts/create-demo-user.js) needs no code change.
  const tier = u.rows[0].email === DEMO_EMAIL ? 'demo'
             : u.rows[0].is_subscribed        ? 'pro'
             : 'free';
  const rule = LIMITS[tier][kind];

  try {
    await db.query('BEGIN');
    // Serialize check+insert per (user, kind). Without this, N parallel
    // requests can all read the same count and all pass — overshoot bounded
    // only by burst concurrency, not by the cap. Transaction-scoped lock:
    // auto-released on COMMIT/ROLLBACK, contends only with the same user.
    await db.query(
      'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2))',
      [userId, kind]
    );

    const r = await db.query(
      `SELECT count(*)::int AS n FROM usage_events
        WHERE user_id = $1 AND kind = $2
          AND created_at > now() - make_interval(hours => $3::int)`,
      [userId, kind, rule.hours]
    );
    if (r.rows[0].n >= rule.max) {
      await db.query('ROLLBACK');
      return limitMessage(tier, kind, rule);
    }

    // Log the attempt only once it's permitted, so a blocked user doesn't
    // extend their own lockout by retrying.
    await db.query(
      `INSERT INTO usage_events (user_id, kind) VALUES ($1, $2)`,
      [userId, kind]
    );
    await db.query('COMMIT');
    return null;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

module.exports = { checkDailyLimit, LIMITS, OWNER_USER_IDS };