// The database: Render's Postgres, reached through DATABASE_URL, where the measurement of every
// run and every determination lives so that nothing resets with a deploy (server/economics.js).
// Without DATABASE_URL nothing here is used, and the economics keep their rows in memory.
//
// The schema is a numbered list of SQL files under server/migrations/, applied once each at boot
// under an advisory lock, so two instances starting together (a deploy) never race. A migration
// that fails stops the boot with a plain message, and the host's health check keeps the old
// instance up, which is the right outcome: a server with half a schema would measure half of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');
const LOCK = 727001; // one key for the schema; any number, the same in every instance

let pool = null;

export function dbOn() { return Boolean(String(config.databaseUrl || '').trim()); }

/** TLS to the database: Render's internal address needs none; a host with a dot in its name gets verified TLS unless the operator says otherwise. */
function sslFor(url) {
  const mode = String(config.databaseSsl || 'auto').toLowerCase();
  if (mode === 'off' || mode === 'disable') return undefined;
  if (mode === 'insecure') return { rejectUnauthorized: false };
  if (mode === 'require') return { rejectUnauthorized: true };
  let host = '';
  try { host = new URL(url).hostname; } catch { return undefined; }
  const internal = host === 'localhost' || /^[\d.]+$/.test(host) || !host.includes('.');
  return internal ? undefined : { rejectUnauthorized: true };
}

export function getPool() {
  if (!pool && dbOn()) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.databasePool, ssl: sslFor(config.databaseUrl), connectionTimeoutMillis: config.databaseWaitMs, idleTimeoutMillis: 30000 });
    pool.on('error', (err) => { console.error('[db] a pooled connection failed:', err.message); });
  }
  return pool;
}

export function query(text, params) { return getPool().query(text, params); }

/** One transaction: `fn(client)` runs inside BEGIN … COMMIT, and any throw rolls it back. */
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** The migration files in order: 001-….sql, 002-….sql. */
export function migrations() {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir).filter((f) => /^\d{3}-.+\.sql$/.test(f)).sort()
    .map((f) => ({ id: Number.parseInt(f.slice(0, 3), 10), name: f, sql: fs.readFileSync(path.join(migrationsDir, f), 'utf8') }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Applies every migration not yet applied, once, under the lock. A database that does not answer is tried again, a few times, before the boot gives up. */
export async function migrate({ attempts = 6, waitMs = 2000 } = {}) {
  if (!dbOn()) return { applied: [], skipped: true };
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = await getPool().connect().catch((err) => { lastErr = err; return null; });
    if (!client) { await sleep(waitMs); continue; }
    try {
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
      try {
        const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
        const applied = [];
        for (const m of migrations()) {
          if (done.has(m.id)) continue;
          await client.query('BEGIN');
          try {
            await client.query(m.sql);
            await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw new Error(`migration ${m.name} failed: ${err.message}`);
          }
          applied.push(m.name);
        }
        return { applied, skipped: false };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
      }
    } catch (err) {
      lastErr = err;
      if (/^migration /.test(err.message)) throw err; // the schema itself is wrong: no retry will mend it
      await sleep(waitMs);
    } finally {
      client.release();
    }
  }
  throw new Error(`the database did not answer in ${attempts} attempts: ${lastErr?.message || 'unknown'}`);
}

export async function end() { if (pool) { const p = pool; pool = null; await p.end().catch(() => {}); } }
