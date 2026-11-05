const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-goal-step-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);

const Database = require('better-sqlite3');
const db = new Database(tempDbPath);

const TaskService = require('../services/taskService');

async function testGoalStepReversal() {
  console.log('======================================================================');
  console.log('GOAL-STEP PROGRESS REVERSAL AND ISOLATION TEST');
  console.log('======================================================================');

  console.log('goal_steps schema:', db.prepare("PRAGMA table_info(goal_steps)").all());

  // Insert a clean test goal (milestone with 2 steps)
  db.prepare(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, status)
    VALUES (901, 'Test Data Structures', 'Technical', 'high', 'milestone', 2, 'active')
  `).run();

  db.prepare(`
    INSERT INTO goal_steps (id, goal_id, step_text, done)
    VALUES (911, 901, 'Step 1: Arrays', 0),
           (912, 901, 'Step 2: Linked Lists', 0)
  `).run();

  // Insert two tasks linked to this goal
  // Task 9001: 60 min (qualifies for step completion)
  // Task 9002: 60 min (qualifies for step completion)
  db.prepare(`
    INSERT INTO tasks (id, name, goal_id, completed, date, duration_min)
    VALUES (9001, 'Study Arrays thoroughly', 901, 0, '2026-11-05', 60),
           (9002, 'Study Linked Lists thoroughly', 901, 0, '2026-11-05', 60)
  `).run();

  // Also insert an existing unrelated historical goal log to verify it is NEVER touched
  db.prepare(`
    INSERT INTO goal_progress_log (id, goal_id, date, amount, note)
    VALUES (9999, 901, '2026-11-01', 1, 'historical:manual_log')
  `).run();

  console.log('\n--- 1. INITIAL STATE ---');
  console.log('Goal 901 Steps:', db.prepare('SELECT id, step_text, done FROM goal_steps WHERE goal_id = 901').all());
  console.log('Goal 901 Logs:', db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901').all());

  // 1. Complete Task 9001 -> should complete Step 911 (Arrays) and log note: task:9001:step:911
  console.log('\n--- 2. COMPLETE TASK 9001 (Step 1) ---');
  TaskService.completeTask(9001, 1, new Date('2026-11-05'), db);
  const step1After = db.prepare('SELECT id, done FROM goal_steps WHERE id = 911').get();
  const logAfter1 = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901 AND note LIKE ?').all('task:9001%');
  console.log('Step 911 done:', step1After.done);
  console.log('Task 9001 log:', logAfter1);
  assert.strictEqual(step1After.done, 1, 'Step 911 must be done');
  assert.strictEqual(logAfter1.length, 1, 'Exactly 1 progress log for task 9001');
  assert.strictEqual(logAfter1[0].note, 'task:9001:step:911', 'Note must contain task and step');

  // 2. Complete Task 9002 -> should complete Step 912 (Linked Lists) and log note: task:9002:step:912
  console.log('\n--- 3. COMPLETE TASK 9002 (Step 2 - Same Goal) ---');
  TaskService.completeTask(9002, 1, new Date('2026-11-05'), db);
  const step2After = db.prepare('SELECT id, done FROM goal_steps WHERE id = 912').get();
  const logAfter2 = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901 AND note LIKE ?').all('task:9002%');
  const allLogs = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901').all();
  console.log('Step 912 done:', step2After.done);
  console.log('Task 9002 log:', logAfter2);
  console.log('All goal logs after completing both:', allLogs);
  assert.strictEqual(step2After.done, 1, 'Step 912 must be done');
  assert.strictEqual(logAfter2.length, 1, 'Exactly 1 progress log for task 9002');
  assert.strictEqual(allLogs.length, 3, 'Must have 3 logs (1 historical + 2 task completions)');

  // 3. Uncheck Task 9001 -> should untick Step 911 and remove ONLY task:9001:step:911 log
  console.log('\n--- 4. UNCHECK TASK 9001 (Goal-Step Reversal) ---');
  TaskService.completeTask(9001, 0, new Date('2026-11-05'), db);
  const step1Unticked = db.prepare('SELECT id, done FROM goal_steps WHERE id = 911').get();
  const step2Preserved = db.prepare('SELECT id, done FROM goal_steps WHERE id = 912').get();
  const logsAfterUncheck1 = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901').all();
  console.log('Step 911 done (unticked):', step1Unticked.done);
  console.log('Step 912 done (preserved):', step2Preserved.done);
  console.log('Remaining logs:', logsAfterUncheck1);
  assert.strictEqual(step1Unticked.done, 0, 'Step 911 must be unticked (done = 0)');
  assert.strictEqual(step2Preserved.done, 1, 'Step 912 must remain completed (done = 1)');
  assert.strictEqual(logsAfterUncheck1.some(l => l.note.startsWith('task:9001')), false, 'Task 9001 log must be removed');
  assert.strictEqual(logsAfterUncheck1.some(l => l.note.startsWith('task:9002')), true, 'Task 9002 log must be preserved');
  assert.strictEqual(logsAfterUncheck1.some(l => l.note === 'historical:manual_log'), true, 'Historical log must be preserved');

  // 4. Re-complete Task 9001 -> Complete -> Uncheck -> Complete
  console.log('\n--- 5. RE-COMPLETE TASK 9001 ---');
  TaskService.completeTask(9001, 1, new Date('2026-11-05'), db);
  const step1ReDone = db.prepare('SELECT id, done FROM goal_steps WHERE id = 911').get();
  const logsAfterReDone = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901').all();
  console.log('Step 911 done (re-done):', step1ReDone.done);
  console.log('All logs after re-complete:', logsAfterReDone);
  assert.strictEqual(step1ReDone.done, 1, 'Step 911 must be re-marked done');
  assert.strictEqual(logsAfterReDone.length, 3, 'Must have 3 logs again');

  // 5. Delete Task 9002 -> Deleting a completed task MUST preserve historical goal logs
  console.log('\n--- 6. DELETE COMPLETED TASK 9002 (Historical Preservation) ---');
  TaskService.deleteTask(9002, db);
  const logsAfterDelete = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 901').all();
  console.log('Logs after deleting completed task 9002:', logsAfterDelete);
  assert.strictEqual(logsAfterDelete.some(l => l.note.startsWith('task:9002')), true, 'Task 9002 log must be preserved');
  assert.strictEqual(logsAfterDelete.some(l => l.note === 'historical:manual_log'), true, 'Historical log must be preserved');

  // 6. Parent-Goal (count) task completion and reversal test
  console.log('\n--- 7. PARENT-GOAL (Count Type) COMPLETION AND REVERSAL ---');
  db.prepare(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status)
    VALUES (902, 'LeetCode 100', 'Technical', 'high', 'count', 100, 10, 'active')
  `).run();
  db.prepare(`
    INSERT INTO tasks (id, name, goal_id, completed, date)
    VALUES (9003, 'Solve 2 DP problems', 902, 0, '2026-11-05')
  `).run();

  TaskService.completeTask(9003, 1, new Date('2026-11-05'), db);
  const goal902AfterComplete = db.prepare('SELECT current_count FROM goals WHERE id = 902').get();
  const log902 = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 902').all();
  console.log('Count goal after completion:', goal902AfterComplete.current_count, log902);
  assert.strictEqual(goal902AfterComplete.current_count, 11, 'Count incremented by 1');

  TaskService.completeTask(9003, 0, new Date('2026-11-05'), db);
  const goal902AfterUncheck = db.prepare('SELECT current_count FROM goals WHERE id = 902').get();
  const log902AfterUncheck = db.prepare('SELECT id, note FROM goal_progress_log WHERE goal_id = 902').all();
  console.log('Count goal after uncheck:', goal902AfterUncheck.current_count, log902AfterUncheck);
  assert.strictEqual(goal902AfterUncheck.current_count, 10, 'Count decremented back to 10');
  assert.strictEqual(log902AfterUncheck.length, 0, 'Task log removed');

  console.log('\n======================================================================');
  console.log('✅ ALL GOAL-STEP PROGRESS REVERSAL TESTS PASSED (100% ISOLATED & ACCURATE)');
  console.log('======================================================================');
}

testGoalStepReversal().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
