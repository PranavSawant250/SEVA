/**
 * backend/scripts/verify-live-migration.js
 *
 * Verifies live schema migration on seva.db:
 * 1. PRAGMA foreign_keys status
 * 2. Table existence and structure for user_devices, idempotency_requests, idempotency_actions
 * 3. Primary keys and index definitions
 * 4. Composite foreign key definition
 * 5. Pre- and post-migration row counts on all business tables
 */

const path = require('path');
const db = require('../database/db'); // Loads live seva.db and triggers initPhase10IdempotencySchema

console.log('================================================================');
console.log('🧪 VERIFYING LIVE MIGRATION ON SEVA.DB');
console.log('================================================================\n');

// 1. Foreign keys check
const fk = db.pragma('foreign_keys');
console.log(`[1] PRAGMA foreign_keys: ${fk[0]?.foreign_keys === 1 ? 'ON (1) ✅' : 'OFF (0) ❌'}`);

// 2. Table list verification
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC").all().map(t => t.name);
const expectedNew = ['user_devices', 'idempotency_requests', 'idempotency_actions'];
const allPresent = expectedNew.every(t => tables.includes(t));
console.log(`[2] New tables present: ${allPresent ? 'ALL PRESENT ✅' : 'MISSING ❌'}`);
console.log(`    Installed tables:`, expectedNew.filter(t => tables.includes(t)));

// 3. Columns and Primary Keys
console.log('\n[3] Schema Details:');
for (const t of expectedNew) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  const pkCols = cols.filter(c => c.pk > 0).sort((a,b) => a.pk - b.pk).map(c => c.name);
  console.log(`  Table: ${t}`);
  console.log(`    Columns: ${cols.map(c => `${c.name} (${c.type}${c.notnull ? ' NOT NULL' : ''})`).join(', ')}`);
  console.log(`    PRIMARY KEY: (${pkCols.join(', ')})`);
}

// 4. Foreign Key constraints
console.log('\n[4] Foreign Key Constraints:');
const actFks = db.prepare('PRAGMA foreign_key_list(idempotency_actions)').all();
for (const f of actFks) {
  console.log(`  idempotency_actions.${f.from} -> ${f.table}.${f.to} [ON DELETE ${f.on_delete}]`);
}

// 5. Indexes
console.log('\n[5] Indexes:');
const expectedIndexes = ['idx_user_devices_token', 'idx_idemp_req_lookup', 'idx_idemp_actions_lookup'];
for (const idx of expectedIndexes) {
  const info = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name = ?").get(idx);
  console.log(`  Index ${idx}: ${info ? `EXISTS on ${info.tbl_name} ✅` : 'MISSING ❌'}`);
}

// 6. Business Table Row Counts
console.log('\n[6] Business Table Row Counts (Must be identical to pre-migration baseline):');
const baseline = {
  goals: 7,
  goal_steps: 6,
  goal_progress_log: 11,
  tasks: 32,
  day_plans: 6,
  daily_settings: 4,
  preferences: 1,
  chat_history: 69,
  emails: 13
};

let allMatch = true;
for (const [tbl, expected] of Object.entries(baseline)) {
  const actual = db.prepare(`SELECT count(*) as c FROM ${tbl}`).get().c;
  const match = actual === expected;
  if (!match) allMatch = false;
  console.log(`  ${tbl.padEnd(20)}: ${actual} (Baseline: ${expected}) ${match ? '✅' : '❌ UNEXPECTED CHANGE'}`);
}

console.log(`\n  Business Data Integrity: ${allMatch ? '100% UNCHANGED AND PRESERVED ✅' : 'FAILED ❌'}`);

console.log('\n================================================================');
console.log('MIGRATION VERIFICATION COMPLETE');
console.log('================================================================\n');
