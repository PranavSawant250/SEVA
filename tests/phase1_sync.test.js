/**
 * tests/phase1_sync.test.js
 *
 * Comprehensive integration tests for Phase 1: Chat <-> Day Plan Synchronization.
 * Runs on an isolated temporary SQLite database — NEVER touches production seva.db.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. Setup isolated database path
const testDbPath = path.join(os.tmpdir(), `seva_test_p1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SEVA_DB_PATH = testDbPath;

// Import services using isolated DB
const dbModule = require('../backend/database/db');
const db = dbModule.db || dbModule;
const TaskService = require('../backend/services/taskService');
const DayPlanService = require('../backend/services/dayPlanService');
const dateUtils = require('../backend/utils/dateUtils');

console.log('🧪 Starting Phase 1 Integration Tests on isolated DB:', testDbPath);

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    testsFailed++;
  }
}

async function runTestAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    testsFailed++;
  }
}

async function main() {
  const today = dateUtils.getTodayDate();
  const tomorrow = dateUtils.getTomorrowDate();

  console.log(`\n--- Test Group 1: Task Creation, Dates & Backlog ---`);

  runTest('T1: Backlog task created without date (date = NULL)', () => {
    const task = TaskService.createTask({
      name: 'Read distributed systems paper'
    }, db);

    assert.strictEqual(task.date, null, 'Task date must be null');
    assert.strictEqual(task.time_slot, 'Anytime');
    assert.strictEqual(task.completed, 0);

    const backlog = TaskService.getTasks({ view: 'backlog' }, db);
    const found = backlog.tasks.find(t => t.id === task.id);
    assert.ok(found, 'Task must appear in backlog query');

    const todayTasks = TaskService.getTasks({ date: today }, db);
    assert.strictEqual(todayTasks.tasks.some(t => t.id === task.id), false, 'Backlog task must NOT appear in today tasks');
  });

  runTest('T2: Scheduled task with explicit tomorrow date and fixed time', () => {
    const task = TaskService.createTask({
      name: 'DB lab exam',
      date: 'tomorrow',
      time_slot: '10:00 AM',
      fixed_start: '10:00 AM',
      duration_min: 60,
      priority: 'high'
    }, db);

    assert.strictEqual(task.date, tomorrow);
    assert.strictEqual(task.fixed_start, '10:00 AM');
    assert.strictEqual(task.fixed_end, '11:00 AM');
    assert.strictEqual(task.priority, 'high');

    const tomorrowTasks = TaskService.getTasks({ date: tomorrow }, db);
    const found = tomorrowTasks.tasks.find(t => t.id === task.id);
    assert.ok(found, 'Task must appear in tomorrow tasks query');
  });

  runTest('T3: Move backlog task to scheduled date', () => {
    const task = TaskService.createTask({
      name: 'Unscheduled research task'
    }, db);
    assert.strictEqual(task.date, null);

    const updated = TaskService.rescheduleTask(task.id, tomorrow, '3:00 PM', db);
    assert.strictEqual(updated.task.date, tomorrow);
    assert.strictEqual(updated.task.fixed_start, '3:00 PM');

    const backlogAfter = TaskService.getTasks({ view: 'backlog' }, db);
    assert.strictEqual(backlogAfter.tasks.some(t => t.id === task.id), false, 'Rescheduled task must leave backlog');
  });

  console.log(`\n--- Test Group 2: Day Plan Reconciliation & Invariants ---`);

  runTest('T4: Reconciled plan filters deleted tasks without mutating plan_json', () => {
    // 1. Create a dummy day plan row
    const testDate = '2026-11-20';
    const task1 = TaskService.createTask({ name: 'Task 1 to delete', date: testDate }, db);
    const task2 = TaskService.createTask({ name: 'Task 2 to keep', date: testDate }, db);

    const initialPlan = [
      { time: '9:00 AM', task: task1.name, task_id: task1.id, completed: 0, priority: 'medium' },
      { time: '11:00 AM', task: task2.name, task_id: task2.id, completed: 0, priority: 'medium' }
    ];
    db.prepare(`INSERT INTO day_plans (date, plan_json, generated_at) VALUES (?, ?, '2026-11-20 08:00 AM')`)
      .run(testDate, JSON.stringify(initialPlan));

    // 2. Delete task1
    TaskService.deleteTask(task1.id, db);

    // 3. Fetch plan via DayPlanService.getPlanForDate
    const planRes = DayPlanService.getPlanForDate(testDate, db);
    assert.strictEqual(planRes.success, true);
    assert.strictEqual(planRes.plan.length, 1, 'Reconciled plan must omit deleted task');
    assert.strictEqual(planRes.plan[0].task_id, task2.id);
  });

  runTest('T5: Flexible tasks are NOT ad-hoc injected into timed timeline', () => {
    const testDate = '2026-11-21';
    const flexTask = TaskService.createTask({ name: 'Flexible DSA', date: testDate, time_slot: 'Anytime' }, db);

    const initialPlan = [
      { time: '9:00 AM', task: 'Fixed Lecture', task_id: null, completed: 0 }
    ];
    db.prepare(`INSERT INTO day_plans (date, plan_json, generated_at) VALUES (?, ?, '2026-11-21 08:00 AM')`)
      .run(testDate, JSON.stringify(initialPlan));

    const planRes = DayPlanService.getPlanForDate(testDate, db);
    assert.strictEqual(planRes.plan.length, 1, 'Timeline must not have flexible task injected without time');
    assert.strictEqual(planRes.plan[0].task, 'Fixed Lecture');
  });

  runTest('T6: Plan deduplication on repeat synchronization', () => {
    const testDate = '2026-11-22';
    db.prepare(`INSERT INTO day_plans (date, plan_json, generated_at) VALUES (?, '[]', '2026-11-22 08:00 AM')`)
      .run(testDate);

    const fixedTask = TaskService.createTask({
      name: 'Seminar',
      date: testDate,
      fixed_start: '2:00 PM',
      duration_min: 60
    }, db);

    // Call syncFixedTaskToPlanTransaction again explicitly
    DayPlanService.syncFixedTaskToPlanTransaction(fixedTask, 'INSERT', db);
    DayPlanService.syncFixedTaskToPlanTransaction(fixedTask, 'UPDATE', db);

    const planRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(testDate);
    const plan = JSON.parse(planRow.plan_json);
    const matching = plan.filter(item => item.task_id === fixedTask.id);
    assert.strictEqual(matching.length, 1, 'Fixed task must have exactly 1 block in plan_json, no duplicates');
  });

  console.log(`\n--- Test Group 3: Goal Consistency, Idempotency & Progress Protection ---`);

  runTest('T7: Task completion and goal count progress increment atomically', () => {
    // 1. Seed a count goal
    const goalRes = db.prepare(`
      INSERT INTO goals (title, goal_type, target_count, current_count, status)
      VALUES ('Solve 50 LeetCode', 'count', 50, 10, 'active')
    `).run();
    const goalId = goalRes.lastInsertRowid;

    // 2. Create task linked to goal
    const task = TaskService.createTask({
      name: 'LC Tree Problem',
      date: today,
      goal_id: goalId
    }, db);

    // 3. Complete task
    const res = TaskService.completeTask(task.id, 1, new Date(), db);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.task.completed, 1);

    const goalAfter = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalAfter.current_count, 11, 'Goal count must increment by 1');

    const logRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').get(goalId, `task:${task.id}`);
    assert.ok(logRow, 'Progress log row must exist');
    assert.strictEqual(logRow.amount, 1);
  });

  runTest('T8: Idempotent task completion does NOT create duplicate logs or count', () => {
    const goalRes = db.prepare(`
      INSERT INTO goals (title, goal_type, target_count, current_count, status)
      VALUES ('Count Goal Idemp', 'count', 20, 5, 'active')
    `).run();
    const goalId = goalRes.lastInsertRowid;

    const task = TaskService.createTask({
      name: 'Task Idemp Test',
      date: today,
      goal_id: goalId
    }, db);

    // First completion
    TaskService.completeTask(task.id, 1, new Date(), db);
    // Second completion (duplicate call)
    const secondRes = TaskService.completeTask(task.id, 1, new Date(), db);

    assert.strictEqual(secondRes.unchanged, true, 'Second call must be marked unchanged');

    const goalAfter = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalAfter.current_count, 6, 'Goal count must NOT increment again');

    const logs = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').all(goalId, `task:${task.id}`);
    assert.strictEqual(logs.length, 1, 'Only exactly 1 log row must exist');
  });

  runTest('T9: Unchecking task reverses ONLY the progress entry for that task', () => {
    const goalRes = db.prepare(`
      INSERT INTO goals (title, goal_type, target_count, current_count, status)
      VALUES ('Count Goal Reverse', 'count', 10, 2, 'active')
    `).run();
    const goalId = goalRes.lastInsertRowid;

    const task = TaskService.createTask({ name: 'Work to reverse', date: today, goal_id: goalId }, db);

    TaskService.completeTask(task.id, 1, new Date(), db);
    let goalMid = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalMid.current_count, 3);

    // Uncheck
    const uncheckRes = TaskService.completeTask(task.id, 0, new Date(), db);
    assert.strictEqual(uncheckRes.task.completed, 0);

    let goalEnd = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalEnd.current_count, 2, 'Count must revert to 2');

    const logs = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').all(goalId, `task:${task.id}`);
    assert.strictEqual(logs.length, 0, 'Task log must be removed');
  });

  runTest('T10: Deleting a completed task PRESERVES historical goal progress', () => {
    const goalRes = db.prepare(`
      INSERT INTO goals (title, goal_type, target_count, current_count, status)
      VALUES ('Permanent Progress Goal', 'count', 100, 40, 'active')
    `).run();
    const goalId = goalRes.lastInsertRowid;

    const task = TaskService.createTask({ name: 'Historical work done', date: today, goal_id: goalId }, db);
    TaskService.completeTask(task.id, 1, new Date(), db);

    const goalBeforeDel = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalBeforeDel.current_count, 41);

    // Delete task
    TaskService.deleteTask(task.id, db);

    // Verify task row is gone
    const taskRow = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id);
    assert.strictEqual(taskRow, undefined, 'Task row must be hard deleted');

    // Verify goal progress and log are PRESERVED (Safeguard 1)
    const goalAfterDel = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalAfterDel.current_count, 41, 'Historical goal count must NOT decrement on task delete');

    const logRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').get(goalId, `task:${task.id}`);
    assert.ok(logRow, 'Historical log row in goal_progress_log must be preserved');
  });

  console.log(`\n--- Test Group 4: Timezone Independence (Asia/Kolkata) ---`);

  runTest('T11: Date calculations around midnight IST evaluated in UTC simulation', () => {
    // 18:29 UTC on Nov 5 = 23:59 IST Nov 5
    const dtBefore = new Date('2026-11-05T18:29:00Z');
    assert.strictEqual(dateUtils.getTodayDate(dtBefore), '2026-11-05');
    assert.strictEqual(dateUtils.getTomorrowDate(dtBefore), '2026-11-06');
    assert.strictEqual(dateUtils.getYesterdayDate(dtBefore), '2026-11-04');

    // 18:31 UTC on Nov 5 = 00:01 IST Nov 6
    const dtAfter = new Date('2026-11-05T18:31:00Z');
    assert.strictEqual(dateUtils.getTodayDate(dtAfter), '2026-11-06');
    assert.strictEqual(dateUtils.getTomorrowDate(dtAfter), '2026-11-07');
    assert.strictEqual(dateUtils.getYesterdayDate(dtAfter), '2026-11-05');
  });

  console.log(`\n--- Test Group 5: Transaction Rollback Integrity ---`);

  runTest('T12: Failed transaction rolls back task table mutation', () => {
    const initialCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;

    assert.throws(() => {
      const failingTx = db.transaction(() => {
        db.prepare(`INSERT INTO tasks (name, priority, source, completed, date) VALUES ('Should Rollback', 'medium', 'test', 0, '2026-11-30')`).run();
        // Force syntax error / constraint error
        throw new Error('Simulated Plan Sync Failure');
      });
      failingTx();
    }, /Simulated Plan Sync Failure/);

    const countAfter = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
    assert.strictEqual(countAfter, initialCount, 'Task table row must not persist when transaction throws');
  });

  console.log('\n=============================================');
  console.log(`Test Results: ${testsPassed} Passed, ${testsFailed} Failed`);
  console.log('=============================================\n');

  // Clean up test database
  try {
    fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});

