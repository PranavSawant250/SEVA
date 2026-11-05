const Database = require('better-sqlite3');
const db = new Database('./backend/seva.db', { readonly: true });
console.log('Task 9 in production seva.db:');
console.log(db.prepare("SELECT id, name, priority, time_slot, completed, date, carry_forward, goal_id FROM tasks WHERE id = 9").get());
