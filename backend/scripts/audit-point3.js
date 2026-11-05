const fs = require('fs');
const path = require('path');
const os = require('os');
const testDbPath = path.join(os.tmpdir(), `audit_p3_${Date.now()}.db`);
process.env.SEVA_DB_PATH = testDbPath;

const db = require('../database/db').db || require('../database/db');
const TaskService = require('../services/taskService');
const DayPlanService = require('../services/dayPlanService');
const nightlyService = require('../services/nightlyService');
const dateUtils = require('../utils/dateUtils');

console.log('====================================================');
console.log('AUDIT POINT 3: Nightly Carry-Forward Full Flow');
console.log('Test DB:', testDbPath);
console.log('====================================================\n');

const todayDateObj = new Date('2026-11-05T21:00:00');
const today = dateUtils.getTodayDate(todayDateObj);
const tomorrow = dateUtils.getTomorrowDate(todayDateObj);

// 1. Create a task scheduled for today and a day plan for today
const task = TaskService.createTask({
  name: 'Assignment to Carry Forward',
  date: today,
  fixed_start: '4:00 PM',
  duration_min: 60,
  priority: 'high'
}, db);

const todayPlan = [
  { time: '4:00 PM', task: task.name, task_id: task.id, completed: 0, priority: 'high', duration: 60 }
];
db.prepare('INSERT INTO day_plans (date, plan_json, generated_at) VALUES (?, ?, ?)')
  .run(today, JSON.stringify(todayPlan), `${today} 08:00 AM`);

console.log('1. INITIAL STATE:');
console.log('Today task:', db.prepare('SELECT id, name, date, completed FROM tasks WHERE id = ?').get(task.id));
console.log('Today Day Plan items:', JSON.parse(db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(today).plan_json));

// 2. Start Nightly Check-in
console.log('\n2. START CHECK-IN & PROVIDE BUDGET:');
nightlyService.startNightlyCheckIn(todayDateObj);

// Send budget "4 hours"
const budgetReply = nightlyService.handleNightlyReply('4 hours', todayDateObj);
console.log('Budget reply summary: suggestions generated.');

// 3. User says "add 1" to accept the pending task
console.log('\n3. USER SELECTS SUGGESTION ("add 1"):');
const addReply = nightlyService.handleNightlyReply('add 1', todayDateObj);
console.log('Add reply:\n', addReply);

// 4. User says "done"
console.log('\n4. USER CONFIRMS ("done"):');
const confirmReply = nightlyService.handleNightlyReply('done', todayDateObj);
console.log('Confirmation reply:\n', confirmReply);

// 5. Verify Database Assertions
const taskAfter = db.prepare('SELECT id, name, date, source, completed FROM tasks WHERE id = ?').get(task.id);
console.log('\n--- VERIFICATION RESULTS ---');
console.log('Task after check-in:', taskAfter);
console.log('1. Task date changed to tomorrow:', taskAfter.date === tomorrow);

// Check today's plan
const todayPlanAfter = JSON.parse(db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(today).plan_json);
console.log('2. Removed from today plan:', todayPlanAfter.filter(i => i.task_id === task.id).length === 0);

// Check tomorrow's tasks
const tomorrowTasks1 = TaskService.getTasks({ date: tomorrow }, db);
const tomorrowMatches1 = tomorrowTasks1.tasks.filter(t => t.id === task.id);
console.log('3. Appears in tomorrow tasks count:', tomorrowMatches1.length);
console.log('Exactly once in tomorrow tasks:', tomorrowMatches1.length === 1);

// 6. Test repeated execution (Deduplication Check)
console.log('\n6. REPEATED CHECK-IN / CARRY FORWARD:');
nightlyService.startNightlyCheckIn(todayDateObj);
nightlyService.handleNightlyReply('4 hours', todayDateObj);
nightlyService.handleNightlyReply('add 1', todayDateObj);
nightlyService.handleNightlyReply('done', todayDateObj);

const tomorrowTasks2 = TaskService.getTasks({ date: tomorrow }, db);
const tomorrowMatches2 = tomorrowTasks2.tasks.filter(t => t.id === task.id);
console.log('Occurrences in tomorrow tasks after 2nd run:', tomorrowMatches2.length);
console.log('Zero duplicate rows on repeated run:', tomorrowMatches2.length === 1);

// Cleanup
try {
  fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
  if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
} catch (_) {}
