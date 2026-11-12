#!/usr/bin/env node
// Upgrade a tutor.db to the current schema version, with a consistent backup first.
// The plugin runs the same migrations itself on start (SqliteTutorStore.open); this script lets you do it, and keep a
// copy, before restarting DSH.  Usage: node scripts/migrate-db.mjs [--db ~/.dsh/oh-my-ai-tutor/tutor.db] [--no-backup]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { SqliteTutorStore, DB_VERSION, defaultDbPath } from '../src/sqlite-store.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const path = arg('--db', defaultDbPath());
if (!existsSync(path)) { console.error(`no database at ${path}`); process.exit(2); }
const ro = new DatabaseSync(path, { readOnly: true });
const from = ro.prepare('PRAGMA user_version').get().user_version;
let backup = null;
if (from < DB_VERSION && !process.argv.includes('--no-backup')) {
  backup = `${path}.bak-v${from}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  ro.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`); // consistent copy, WAL included
}
ro.close();
const store = new SqliteTutorStore(path, { legacyJsonPath: null });
store.open();
const to = store.db.prepare('PRAGMA user_version').get().user_version;
const cards = store.db.prepare("SELECT state, count(*) AS n FROM review_cards GROUP BY state").all().map((r) => `${r.state}=${r.n}`).join(' ');
store.close();
console.log(JSON.stringify({ db: path, from, to, backup, reviewInit: store.reviewInit, reviewCards: cards }));
