const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../seva.db');
const db = new Database(dbPath);

console.log('--- LIVE DATABASE ROW COUNTS ---');
const tables = ['goals', 'goal_steps', 'goal_progress_log', 'tasks', 'day_plans', 'daily_settings', 'preferences', 'chat_history', 'emails'];
for (const t of tables) {
  try {
    const row = db.prepare(`SELECT count(*) as c FROM ${t}`).get();
    console.log(`${t.padEnd(20)}: ${row.c}`);
  } catch (err) {
    console.log(`${t.padEnd(20)}: ERROR (${err.message})`);
  }
}

const idempTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='idempotency_requests' OR name='idempotency_actions')").all();
console.log('idempotency tables present in live DB:', idempTables.map(t => t.name));

