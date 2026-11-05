/**
 * Database connection and migration runner.
 *
 * Uses node:sqlite from the standard library — no native module to compile,
 * which is what keeps `pnpm install` working on a machine without a C
 * toolchain and keeps the whole stack free to run offline.
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

export interface OpenOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
}

export function openDb({ path }: OpenOptions): Db {
  const db = new DatabaseSync(path);
  // Foreign keys are off by default in SQLite; without this, every ON DELETE
  // CASCADE in the schema is decoration and account deletion leaks rows.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const ran: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now(),
      );
      db.exec('COMMIT');
      ran.push(migration.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.id} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return ran;
}

/** Run `fn` in a transaction, rolling back on any throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
