const fs = require('fs');
const path = require('path');
const os = require('os');
const testDbPath = path.join(os.tmpdir(), `audit_p1_${Date.now()}.db`);
process.env.SEVA_DB_PATH = testDbPath;

const db = require('../database/db').db || require('../database/db');
const TaskService = require('../services/taskService');

console.log('====================================================');
console.log('AUDIT POINT 1: Goal Progress Association & Isolation');
console.log('Test DB:', testDbPath);
console.log('====================================================\n');

// 1. Seed goal
const goalRes = db.prepare(`
  INSERT INTO goals (title, goal_type, target_count, current_count, status)
  VALUES ('LeetCode 100', 'count', 100, 10, 'active')
`).run();
const goalId = goalRes.lastInsertRowid;

// 2. Seed Task A and Task B linked to same goal
const taskA = TaskService.createTask({ name: 'LC Problem 1', date: '2026-11-05', goal_id: goalId }, db);
const taskB = TaskService.createTask({ name: 'LC Problem 2', date: '2026-11-05', goal_id: goalId }, db);

console.log('1. INITIAL STATE:');
console.log('Goal:', db.prepare('SELECT id, title, current_count, status FROM goals WHERE id = ?').get(goalId));
console.log('Task A:', { id: taskA.id, name: taskA.name, completed: taskA.completed, goal_id: taskA.goal_id });
console.log('Task B:', { id: taskB.id, name: taskB.name, completed: taskB.completed, goal_id: taskB.goal_id });
console.log('goal_progress_log rows:', db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ?').all(goalId));

console.log('\n2. COMPLETE TASK A:');
const resA = TaskService.completeTask(taskA.id, 1, new Date('2026-11-05T10:00:00'), db);
console.log('TaskService response:', { success: resA.success, unchanged: resA.unchanged });
console.log('Goal:', db.prepare('SELECT id, current_count FROM goals WHERE id = ?').get(goalId));
console.log('goal_progress_log rows:', db.prepare('SELECT id, goal_id, date, amount, note FROM goal_progress_log WHERE goal_id = ?').all(goalId));

console.log('\n3. COMPLETE TASK B (different task, same goal):');
const resB = TaskService.completeTask(taskB.id, 1, new Date('2026-11-05T11:00:00'), db);
console.log('TaskService response:', { success: resB.success, unchanged: resB.unchanged });
console.log('Goal:', db.prepare('SELECT id, current_count FROM goals WHERE id = ?').get(goalId));
console.log('goal_progress_log rows:', db.prepare('SELECT id, goal_id, date, amount, note FROM goal_progress_log WHERE goal_id = ?').all(goalId));

console.log('\n4. DUPLICATE COMPLETION OF TASK B (Idempotency):');
const resBDup = TaskService.completeTask(taskB.id, 1, new Date('2026-11-05T11:05:00'), db);
console.log('TaskService response:', { success: resBDup.success, unchanged: resBDup.unchanged });
console.log('Goal:', db.prepare('SELECT id, current_count FROM goals WHERE id = ?').get(goalId));
console.log('goal_progress_log row count:', db.prepare('SELECT COUNT(*) as c FROM goal_progress_log WHERE goal_id = ?').get(goalId).c);

console.log('\n5. UNCHECK TASK A (Reverses ONLY Task A, leaves Task B intact):');
const resAUncheck = TaskService.completeTask(taskA.id, 0, new Date('2026-11-05T12:00:00'), db);
console.log('TaskService response:', { success: resAUncheck.success, unchanged: resAUncheck.unchanged });
console.log('Goal count (should be 11):', db.prepare('SELECT id, current_count FROM goals WHERE id = ?').get(goalId));
console.log('Remaining goal_progress_log rows (only task B log should remain):', db.prepare('SELECT id, goal_id, date, amount, note FROM goal_progress_log WHERE goal_id = ?').all(goalId));

console.log('\n6. RE-COMPLETE TASK A (Complete -> Uncheck -> Complete Again):');
const resARecomplete = TaskService.completeTask(taskA.id, 1, new Date('2026-11-05T13:00:00'), db);
console.log('TaskService response:', { success: resARecomplete.success, unchanged: resARecomplete.unchanged });
console.log('Goal count (should be 12):', db.prepare('SELECT id, current_count FROM goals WHERE id = ?').get(goalId));
console.log('goal_progress_log rows (both Task A and Task B logs present):', db.prepare('SELECT id, goal_id, date, amount, note FROM goal_progress_log WHERE goal_id = ?').all(goalId));

// Cleanup
try {
  fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
  if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
} catch (_) {}

