import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function runMigrations() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r) => r.id)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insert = db.prepare('INSERT INTO _migrations (id) VALUES (?)');

  // Disable foreign-key enforcement for the duration of the run. Schema
  // migrations may rebuild a table (create new → copy → DROP old → rename),
  // and with FKs ON, dropping a parent table implicitly deletes its rows and
  // cascades to children (comments, phases, checklist_items all reference
  // projects ON DELETE CASCADE) — silently wiping data. Migrations are trusted
  // schema operations, so we turn enforcement off and restore it after. The
  // PRAGMA is a no-op inside a transaction, so it must be toggled OUTSIDE the
  // per-file tx below; we restore the prior state in `finally`.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const tx = db.transaction(() => {
        db.exec(sql);
        insert.run(file);
      });
      tx();
      console.log(`migrated: ${file}`);
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
    console.log('migrations complete');
  } finally {
    closeDb();
  }
}
