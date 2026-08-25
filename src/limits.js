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
  },
  pro: {
    capture: { max: 100, hours: 24 },   // invisible ceilings, machines only
    summary: { max: 100, hours: 168 },
    save:    { max: 100, hours: 24 },
  },
};

function limitMessage(tier, kind, rule) {
  if (tier === 'pro') {
    return 'Unusually high activity — please try again in a bit.';
  }
  // NOTE: this message doesn't reference rule.max — change the cap and the
  // copy won't follow.
  if (kind === 'summary') {
    return 'That\'s both for this week — Pro has no limits :)';
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
  const u = await db.query(`SELECT is_subscribed FROM users WHERE id = $1`, [userId]);
  if (u.rows.length === 0) throw new Error(`Rate limit check for unknown user: ${userId}`);
  const tier = u.rows[0].is_subscribed ? 'pro' : 'free';
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