# Security

This started where a lot of solo projects start: a database password in shell history and port 5432 open to the internet. This is the arc from there to here, including the parts I got wrong.

## The finding

An audit of the running infrastructure turned up a database network rule far broader than it should have been — the kind that leaves a login prompt reachable by people who have no business reaching it.

That rule wasn't carelessness, which is what made it interesting. The Lambda functions run **outside** the VPC — the default — so their egress addresses come from unstable shared AWS space with no narrow range to allowlist. Tightening the rule properly means moving the functions into the VPC, which means a NAT gateway and a Secrets Manager endpoint, which means real monthly cost. That's the classic serverless-plus-RDS trap.

## The decision: make the credential worthless, then close the door on a schedule

Rather than pay for private networking on day one of a pre-revenue project, the call was to make reaching the port useless first, and treat the networking spend as a triggered upgrade rather than a someday-maybe:

1. **IAM database authentication.** The application database user was granted `rds_iam`, which makes password login *impossible* for that user — it accepts only short-lived, AWS-signed tokens. There is no password to steal.
2. **Forced TLS.** `rds.force_ssl = 1`, with the RDS CA bundled and certificate verification on, so plaintext connections are refused outright.
3. **An intrusion tripwire, live-fire tested.** Postgres logs already streamed to CloudWatch, so a metric filter on `"authentication failed"` feeds an alarm wired to email.

The filter pattern is the detail I'm proudest of: it matches the **two-word suffix**, not the full message, so it catches both `password authentication failed` *and* `PAM authentication failed`. IAM token failures route through PAM — matching only the password variant would have left a door the alarm couldn't see. It was verified end to end with six deliberate bad logins: log → filter → metric → alarm → inbox.

And the honest limit, worth stating: **the alarm catches guessing, not theft.** A correct stolen credential logs in silently on the first try. Defense in depth means knowing which layer covers which threat.

## Finishing the job: zero standing credentials

IAM auth covered the Lambda path, but four Next.js routes still connected directly with a password, because they run before a session exists — sign-in and registration can't authenticate through the authenticated API. Worse, the connection string had drifted over time from the least-privilege user to the **administrative** one.

That was closed with OIDC federation:

- Vercel issues each deployment a signed identity token.
- AWS trusts that issuer, via an OpenID Connect identity provider.
- An IAM role accepts the token **only** when its subject matches this project's production environment exactly, and carries exactly one permission — `rds-db:connect` as the least-privilege user.
- The app trades the token for temporary credentials and mints a fresh 15-minute database token per connection.

Rollout was staged deliberately: ship the code with production still on the old path, flip the mode, deploy to a **staged production build that the domain doesn't point at**, exercise every flow there, then promote the exact tested build. Two flows couldn't be honestly tested on the staged URL and were verified after promotion — Google sign-in, because the OAuth redirect is registered against the real domain, and account deletion, because that route's own origin allowlist correctly refuses foreign origins.

Then the administrative password was deleted from the hosting provider and rotated at the source, verified dead by probing the old value.

**Two lessons from the rollout**, both cheap to laugh at and expensive to hit:

- The first staged attempt failed with `AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity`. The trust policy, the provider, and the permission were all character-perfect. The **role name had a typo**. STS returns the same error for a nonexistent role as for a refused one — deliberately, so you can't enumerate roles — which means that error should send you to diff the ARN before re-reading claims.
- A rotated password containing `@` and `?` broke the local connection string, because those characters are structural in a URL and the password tail parsed as a hostname. Connection-string passwords are now letters and digits only, at a length where the character pool contributes nothing anyway.

## The rest of the posture

**Rate limiting** as the primary cost control — see [`src/limits.js`](../src/limits.js). The threat model here was never a breach; it was a script burning model tokens.

**Headers**: HSTS, `nosniff`, frame-deny, a referrer policy, a permissions policy, and a Content-Security-Policy shipped report-only first, then enforced. The framework's `x-powered-by` fingerprint is scrubbed.

**Auth**: bcrypt at cost 12; email verification and password reset through single-use hashed tokens consumed with `UPDATE ... WHERE used_at IS NULL ... RETURNING`, so two simultaneous clicks can't both win. JWT sessions are made revocable by a `sessions_valid_from` column re-read on every session read — a password reset bumps it, and every token minted before it dies on its next request. That read costs a query per request, deliberately: a self-contained token is otherwise unkillable for its full lifetime.

**Registration is timing-safe.** A missing account is hashed against a dummy bcrypt hash so a miss can't be measured as faster than a wrong password, and a taken address and a fresh one leave by the same line with the same status code — closing an enumeration oracle that an earlier version had.

## What a dual-model audit found

Late in the project, every repository was audited twice — once by me, once by an independent model with no access to my findings — with each finding adversarially verified before it counted. Eighty-eight survived verification and were fixed.

The most valuable output wasn't a fix, though. It was **two recommended fixes that were refused** after being tested against the live system: one would have written a status value the production `CHECK` constraint rejects, and the other would have been silently swallowed by a query-string guard added the same week. Both typechecked cleanly. Neither would have worked.

That's the line worth carrying forward: *a green typecheck proves nothing about a fix that violates live schema or a guard someone added on Tuesday.*
