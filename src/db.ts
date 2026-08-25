// The one place this app connects to Postgres. auth.ts, register, profile,
// and account all draw from the single pool built here — previously each
// carried its own module-scope Pool, four pools for one database.
//
// Two modes, chosen EXPLICITLY by DB_AUTH_MODE — never inferred, never
// fallen back to. An IAM failure that silently retried as the static
// password would defeat the reason iam mode exists, so an unset or unknown
// mode throws instead of guessing.
//
//   static — DATABASE_URL connection string, the original path.
//   iam    — Vercel OIDC token → STS AssumeRoleWithWebIdentity
//            (journaled-vercel-db, production deployments only) → a fresh
//            15-minute RDS auth token per new connection, as journaled_app.
//            No long-lived database credential exists on this path.
//
// The pool is built lazily on first use: `next build` evaluates route
// modules, and nothing OIDC- or env-dependent may run at import time.
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import { attachDatabasePool } from '@vercel/functions';
import fs from 'fs';
import path from 'path';

// Mandated shape for serverless: each function instance holds at most two
// sockets and gives them up after 5s idle, so N warm instances can't pin
// N×10 connections open against a t4g.micro's ~85-connection ceiling.
// attachDatabasePool() below closes idle sockets when the instance suspends.
const POOL_SHAPE = {
  max: 2,
  min: 0,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`db.ts: ${name} is required in DB_AUTH_MODE=iam`);
  return v;
}

function buildPool(): Pool {
  const mode = process.env.DB_AUTH_MODE;

  const ssl = {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.join(process.cwd(), 'rds-ca.pem')).toString(),
  };

  if (mode === 'static') {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      ...POOL_SHAPE,
    });
  }

  if (mode === 'iam') {
    const host = requireEnv('RDS_HOST'); // the real RDS endpoint — tokens can't be signed against a DNS alias
    const port = Number(process.env.RDS_PORT || 5432);
    const user = requireEnv('RDS_USER');
    const region = requireEnv('AWS_REGION');

    const signer = new Signer({
      hostname: host,
      port,
      username: user,
      region,
      credentials: awsCredentialsProvider({
        roleArn: requireEnv('AWS_ROLE_ARN'),
        clientConfig: { region },
      }),
    });

    return new Pool({
      host,
      port,
      database: requireEnv('RDS_DATABASE'),
      user,
      // A function, so it runs for every NEW socket, not once at pool
      // creation: each connection gets a token minted inside its 15-minute
      // window, and connections already established keep working regardless.
      password: () => signer.getAuthToken(),
      ssl,
      ...POOL_SHAPE,
    });
  }

  throw new Error(
    `db.ts: DB_AUTH_MODE must be 'static' or 'iam' (got ${JSON.stringify(mode ?? null)})`
  );
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = buildPool();
    attachDatabasePool(pool);
    // Idle-socket errors (RDS reboot, failover, network reset) surface here
    // rather than crashing the function instance; the next query draws a
    // fresh connection.
    pool.on('error', (err) => console.error('db pool error:', err));
    pool.once('connect', () =>
      console.log(`db: first connection established (mode=${process.env.DB_AUTH_MODE})`)
    );
  }
  return pool;
}
