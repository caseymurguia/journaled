# Architecture

## The Shape

```
Browser
   ↓  session cookie only — never the internal key
Vercel (Next.js pages + route-handler proxies)
   ↓  x-internal-key + x-user-id + HMAC assertion, server-to-server
API Gateway (REST, TLS 1.3, throttled)
   ↓  Lambda authorizer: timing-safe key compare, fails closed
AWS Lambda (Node 22, outside the VPC — business logic)
   ↓  IAM auth, 15-minute tokens, least-privilege database user
PostgreSQL 18 on RDS (system of record, encrypted, force_ssl)
```

Everything runs in one region. Lambdas sit **outside** the VPC deliberately, so calls to Secrets Manager, SES, and the model API work without a NAT gateway — a real monthly cost avoided in exchange for a database gated by network rules, forced TLS, a least-privilege user, and token-only authentication rather than by network isolation alone. Moving the functions into the VPC is a documented, trigger-based upgrade rather than a someday-maybe.

## Why a Proxy Layer Exists at All

The browser never holds the internal API key. Every call from the client goes to a Next.js route handler, which attaches the key server-side and forwards to API Gateway. This is the single most load-bearing boundary in the system, and it's why the frontend is a BFF rather than a pure static client.

Beside the key, the proxy sends the caller's user id — and that id used to be taken on trust upstream, meaning a leaked header set could impersonate any account. It's now bound with an HMAC over `v1:{userId}:{timestamp}`, verified with a timing-safe compare and a 300-second skew window.

The honest scope of that binding, which is easy to over-read: **the signing key is the internal key, and it rides on the same request.** A capture that includes *that* header still mints assertions for anyone. What the binding actually defeats is the *partial* capture — the log line or error report that redacts an obvious secret like `x-internal-key` but passes `x-user-id` through untouched. That's the common shape, which is why it's worth having, but it is narrower than "captured requests are now harmless." Closing the full-capture case needs a signing secret that isn't also the bearer token on the wire.

See [`src/proxy.ts`](../src/proxy.ts) for the implementation and its path-validation guard, which exists because Next.js hands dynamic route segments over **URL-decoded** — an id of `..%2fexport` arrives as `../export` and collapses onto a different upstream endpoint.

## Data Model

**Work events are the system of record.** Everything else derives from them.

```
users ──┬── work_sessions ── work_events
        ├── summary_jobs        (async range reports; saved = it's a Report)
        ├── usage_events        (rate-limit ledger, one row per attempt)
        └── email_tokens        (single-use, hashed, reset + verification)
```

A **work event** carries a description, an activity type, a timestamp, and optionally a client, a project, and a duration in minutes. Duration is optional by design — salaried professionals ignore it, contractors fill it, and one schema serves both.

A **session** is one capture: the summary plus the entries beneath it, filed under a date. That choice came from a product decision — *this is not a ticketing system* — and it's what makes reports possible, because a date range returns real rows, not prose.

Two details that matter more than they look:

- **`original_summary`** stores the model's first draft and is never updated. User edits write to `summary` only, so the evaluation signal survives every later edit *by construction* rather than by anyone remembering not to clobber it.
- **Every child table cascades on delete.** Account deletion is one statement against `users`; nine foreign keys clear everything beneath it. Verified against the live schema and destructively tested before shipping.

## Async Report Generation

API Gateway REST caps a request at 29 seconds and won't budge. Long-range report generation exceeded it unpredictably, so generation became a job:

```
POST /range-summary  →  insert a pending job row
                     →  async-invoke the worker (300s budget)
                     →  return the job id immediately
GET /summary-job/{id} →  client polls every 3s
```

The worker re-reads its own row and returns early unless the status is still `pending`, so a duplicate async delivery cannot double-generate. That's idempotency for retry safety — worth distinguishing from request deduplication, which this system deliberately does *not* have.

## Scheduled Maintenance

An EventBridge rule runs a retention sweep daily, after the database backup window. Every window it enforces is derived from an enforcement window elsewhere in the code, plus slack, expressed in **explicit hours** so no timezone or DST arithmetic can silently narrow it.

The operational details are the interesting part: batched deletes by `ctid`, each in its own committed transaction so a months-deep first run never holds a long lock; `statement_timeout` and `lock_timeout` set per invocation so a sweep can't hold the live rate limiters hostage; and a time guard that **throws** with 20 seconds left rather than returning cleanly — completed batches stay deleted, and Lambda's async retry picks up the remainder. Double delivery is harmless, since both runs apply the same age predicates.

See [`src/retention-sweep.js`](../src/retention-sweep.js).

## The AI Layer

One file knows which provider is in use. Business logic calls `parseFreeText`, `generateSummary`, or `generateRangeSummary`; none of them import a provider SDK. Switching providers is a rewrite of a single function and zero changes anywhere else — a boundary that was tested when moving to a different provider was seriously evaluated and ultimately declined for independence reasons.

Prompts live in that same file, versioned in git, composed from a shared `CORE` block plus a mode-specific block. See [prompt-system.md](prompt-system.md).
