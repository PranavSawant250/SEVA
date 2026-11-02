const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const dbPath = path.resolve(__dirname, '../seva.db');
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC").all().map(t => t.name);

console.log('TABLE CONTENT HASHES FOR ' + dbPath + ':');
const hashes = {};
for (const table of tables) {
  if (table.startsWith('sqlite_')) continue;
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
  const canonicalJson = JSON.stringify(rows);
  const hash = crypto.createHash('sha256').update(canonicalJson).digest('hex');
  hashes[table] = { count: rows.length, hash };
  console.log(`  ${table.padEnd(25)}: ${rows.length} rows | SHA256: ${hash}`);
}
db.close();

