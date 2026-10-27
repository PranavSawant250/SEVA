const db = require('../database/db');

// .tables equivalent
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('\n=== .tables ===');
console.log(tables.map(t => t.name).join('\n'));

// PRAGMA table_info for tasks
console.log('\n=== PRAGMA table_info(tasks) ===');
const tasksCols = db.prepare("PRAGMA table_info(tasks)").all();
tasksCols.forEach(c => console.log(`  cid=${c.cid} name=${c.name} type=${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`));

// PRAGMA table_info for preferences (if exists)
const prefExists = tables.find(t => t.name === 'preferences');
if (prefExists) {
  console.log('\n=== PRAGMA table_info(preferences) ===');
  const prefCols = db.prepare("PRAGMA table_info(preferences)").all();
  prefCols.forEach(c => console.log(`  cid=${c.cid} name=${c.name} type=${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`));
} else {
  console.log('\n=== preferences table: DOES NOT EXIST ===');
}

// PRAGMA table_info for daily_settings (if exists)
const dsExists = tables.find(t => t.name === 'daily_settings');
if (dsExists) {
  console.log('\n=== PRAGMA table_info(daily_settings) ===');
  const dsCols = db.prepare("PRAGMA table_info(daily_settings)").all();
  dsCols.forEach(c => console.log(`  cid=${c.cid} name=${c.name} type=${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`));
} else {
  console.log('\n=== daily_settings table: DOES NOT EXIST ===');
}

// PRAGMA table_info for goals (if exists)
const goalsExists = tables.find(t => t.name === 'goals');
if (goalsExists) {
  console.log('\n=== PRAGMA table_info(goals) ===');
  const goalsCols = db.prepare("PRAGMA table_info(goals)").all();
  goalsCols.forEach(c => console.log(`  cid=${c.cid} name=${c.name} type=${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`));
} else {
  console.log('\n=== goals table: DOES NOT EXIST ===');
}

process.exit(0);
