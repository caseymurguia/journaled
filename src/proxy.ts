import { createHmac } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Route handlers build `path` by interpolating their dynamic segments
// (session/[id], summary-job/[id]) straight into it, and Next hands those
// segments over URL-DECODED: an id of "..%2fexport" arrives as "../export"
// and the URL parser collapses it onto a different upstream endpoint, while
// "123%3Fadmin=1" arrives as "123?admin=1" and smuggles query parameters onto
// the call. Whatever path comes out the far side, this function signs it with
// the internal key and the user's identity — so the shape is checked here,
// once, instead of trusted from every caller.
const SAFE_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

// The only endpoints that legitimately arrive with a query string. /search and
// /export carry the browser's own URLSearchParams; the period collections carry
// the caller's local calendar date (and, for events, its UTC offset) so the
// backend anchors "today" on the user's day instead of the database's UTC one.
// A "?" anywhere else came from an interpolated segment.
//
// Widening to the period collections keeps the guard's point intact. What it
// exists to stop is a free-form dynamic segment carrying a "?" — /session/{id}
// and /summary-job/{id}, whose ids are whatever the URL bar says; those stay
// out of both lists. The segment after /sessions/ and /events/ is checked
// against a fixed period whitelist in the route handler before proxy() is ever
// called, so there is no free-form segment here to smuggle through.
const QUERY_PATHS = new Set(['/search', '/export']);
const PERIOD_QUERY_PATH = /^\/(?:sessions|events)\/[a-z]+$/;

// x-internal-key proves only "this request came from the BFF" — beside it,
// x-user-id used to name whoever the caller pleased, so a leaked header set
// impersonated ANY account. This binds the two: an HMAC only a holder of the
// key could produce, over one specific user id and a timestamp the authorizer
// ages out.
//
// Be precise about what that buys, because it is easy to over-read. The signing
// key IS the internal key, and it rides in x-internal-key on this very request.
// So a capture that includes THAT header — or the env var itself — still mints
// assertions for anyone, and gains nothing from the binding. What the binding
// actually defeats is the PARTIAL capture: the log line, error report or proxy
// trace that redacts an obvious secret like x-internal-key but passes
// x-user-id straight through, against an upstream that used to take that id on
// trust. That is the common shape, which is why this is worth having — but it
// is a narrower win than "captured requests are now harmless".
//
// Closing the full-capture case needs a signing secret that is NOT also the
// bearer token on the wire (or the NextAuth JWT verified upstream) — a bigger
// change, deliberately not this one.
//
// The canonical string is rebuilt byte-for-byte by
// journaled-backend/functions/authorizer/index.js. Keep the two in lockstep:
//
//     v1:<x-user-id verbatim>:<x-assertion-ts verbatim>
//     e.g.  v1:a1b2c3d4-0000-4000-8000-000000000000:1755648000
//
// HMAC-SHA256, key = the raw INTERNAL_API_KEY string, lowercase hex digest.
//
// Shipped behind a backward-compatible shim: the authorizer temporarily
// allowed key-only requests so the two repos didn't have to deploy in the same
// instant. The shim was removed once both sides were live, and the signed
// assertion is now the only path to an Allow.
function signUserAssertion(userId: string, key: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const assertion = createHmac('sha256', key).update(`v1:${userId}:${ts}`).digest('hex');
  return { ts, assertion };
}

// opts.requireVerified: the email-verification partial gate. Journal and
// Reports routes pass true; capture routes don't. Enforced HERE, not only in
// the pages, because a wall the API doesn't hold is decoration — the pages
// render the friendly version, this returns the honest 403.
export async function proxy(
  path: string,
  init: RequestInit = {},
  opts: { requireVerified?: boolean } = {}
) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;

  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  if (opts.requireVerified && !(session?.user as any)?.email_verified) {
    return Response.json({ error: 'Verify your email to use this.' }, { status: 403 });
  }

  const queryAt = path.indexOf('?');
  const endpoint = queryAt === -1 ? path : path.slice(0, queryAt);
  const queryOk = QUERY_PATHS.has(endpoint) || PERIOD_QUERY_PATH.test(endpoint);
  if (!SAFE_PATH.test(endpoint) || (queryAt !== -1 && !queryOk)) {
    console.error(`Proxy refused path: ${path}`);
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  try {
    // Inside the try on purpose: a missing INTERNAL_API_KEY throws out of
    // createHmac, and a 502 is a better answer than an unhandled 500.
    const key = process.env.INTERNAL_API_KEY!;
    const { ts, assertion } = signUserAssertion(userId, key);

    const r = await fetch(`${process.env.API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': key,
        'x-user-id': userId,
        'x-user-email': session!.user!.email!,
        'x-assertion-ts': ts,
        'x-user-assertion': assertion,
        ...(init.headers || {}),
      },
    });
    return Response.json(await r.json(), { status: r.status });
  } catch (err) {
    console.error(`Proxy error (${path}):`, err);
    return Response.json({ error: 'Upstream request failed' }, { status: 502 });
  }
}
