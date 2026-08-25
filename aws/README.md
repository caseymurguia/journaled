# AWS configuration

The infrastructure was built by hand and verified before anything was codified — deliberately, so that the Terraform written later imports resources whose behavior is already understood. What follows is the configuration that carries the interesting decisions, with identifiers replaced by placeholders.

## Federated database access

Two files, and between them there is no long-lived database credential anywhere in the system.

**[`oidc-trust-policy.json`](oidc-trust-policy.json)** — who may assume the role. Vercel issues each deployment a signed OIDC token; AWS is configured with `oidc.vercel.com/<team>` as an identity provider, which makes those tokens *verifiable*. Verifiable isn't sufficient, though — every project on the team gets genuine tokens, previews included. The `sub` condition is what narrows it to one project in one environment, by exact string match.

**[`rds-connect-policy.json`](rds-connect-policy.json)** — what the role may then do. One action, on one database user, on one instance.

Setup order matters, because each step is inert without the one before it:

1. Enable OIDC federation on the Vercel project (issuer mode: team).
2. Create the IAM identity provider in AWS for `https://oidc.vercel.com/<team>`, audience `https://vercel.com/<team>`.
3. Create the role with the trust policy, then attach the permission policy as an inline policy.
4. Set the runtime environment variables — role ARN, region, and the database host, port, name, and user.
5. Deploy with the auth mode still set to the old path, so the code ships without changing behavior.
6. Flip the mode, build a **staged** production deployment the domain doesn't point at, and exercise every flow there.
7. Promote the tested build.
8. Only then remove the old connection string and rotate the password it contained.

> **A failure worth documenting.** The first staged run failed with `AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity`. Provider, trust policy, and permission were all correct — the **role name had a typo**. STS deliberately returns the same error for a role that doesn't exist as for one that refuses you, so you can't enumerate roles by probing. If you hit that error, diff the role ARN character by character *before* re-reading your trust conditions. IAM roles can't be renamed; recreate and delete.

## The database user

The frontend and the Lambda functions both connect as the same least-privilege Postgres user, which holds `GRANT rds_iam`. That grant is doing more work than it looks like:

```sql
GRANT rds_iam TO <db_user>;
```

It makes password authentication **impossible** for that user — not discouraged, not unused. The only accepted credential is a short-lived AWS-signed token. There is no password to leak, rotate, or find in someone's shell history.

The administrative account still has a password, but nothing at runtime uses it. It exists for break-glass psql sessions only.

## Watching database authentication

Functions run outside the VPC so they can reach Secrets Manager and the model API without a NAT gateway, which means their egress addresses are unstable shared space with no narrow range to allowlist. Private networking is a real cost, so it's a triggered upgrade — and in the meantime, authentication failures are monitored.

Postgres logs stream to CloudWatch, and a metric filter feeds an alarm:

```
Filter pattern:  "authentication failed"
Metric:          DBAuthFailures (namespace: Journaled)
Alarm:           Sum over a short window → SNS → email
Missing data:    notBreaching   (a quiet log is a healthy log)
```

Two details that took thought:

**The pattern matches the two-word suffix, not the whole message.** Postgres emits `password authentication failed` for password attempts and `PAM authentication failed` for IAM token attempts. Matching only the first would have left the IAM door unwatched — an attacker's *choice of door* would have decided whether the alarm fired.

**The threshold is tuned so noise doesn't cry wolf and patterns can't hide.** A stray failure shouldn't page anyone; anything systematic should. The whole pipe was verified end to end with deliberate bad logins — log line to filter to metric to alarm to inbox — because an alarm nobody has ever seen fire is a hypothesis, not a control.

## Scheduled maintenance

An EventBridge rule invokes the retention sweep daily at 05:30 UTC, chosen to sit after the RDS backup window rather than during it.

The function is created with a **900-second timeout**, which is the single most important line of its configuration: the default 3 seconds would have died on the first backlog run and looked like a broken function rather than an under-provisioned one. It also carries reserved concurrency of 1 where the account's limits allow, so a scheduled run and an async retry can never contend for the same batches.

See [`../src/retention-sweep.js`](../src/retention-sweep.js) for how it stays inside that budget and hands the remainder to Lambda's retry.

## What isn't here

API Gateway's REST configuration, the Lambda authorizer's key comparison, the Secrets Manager entries, and the SES identity setup all live in the private repositories. The pieces above are the ones that carry decisions worth explaining rather than steps worth copying.
