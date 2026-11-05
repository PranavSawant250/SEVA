const Database = require('better-sqlite3');
const db = new Database('./backend/seva.db', { readonly: true });
const tables = ['goals', 'goal_steps', 'goal_progress_log', 'tasks', 'day_plans', 'daily_settings'];
console.log('Production Database Table Counts:');
for (const t of tables) {
  console.log(`  ${t.padEnd(20)}: ${db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c}`);
}

