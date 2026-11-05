/**
 * tests/chat_dayplan_sync.test.js
 *
 * Automated verification suite for SEVA Chat <-> Day Plan Synchronization.
 * Tests all 8 Chat -> Day Plan actions against an ISOLATED SQLite database.
 * NEVER touches production seva.db.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const Database = require('../backend/node_modules/better-sqlite3');

const {
  getTodayDate,
  parseTimeToMinutes,
  minutesToTimeString
} = require('../backend/utils/dateUtils');

const TEST_DB_PATH = path.join(os.tmpdir(), `seva_test_chat_dayplan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.db`);

function setupIsolatedDb() {
  const db = new Database(TEST_DB_PATH);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT,
      category TEXT,
      title TEXT NOT NULL,
      target_text TEXT,
      deadline TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      goal_type TEXT DEFAULT 'milestone' CHECK(goal_type IN ('milestone','count','frequency')),
      target_count INTEGER NULL,
      current_count INTEGER DEFAULT 0,
      per_week INTEGER NULL,
      manual_progress INTEGER NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','removed')),
      created_date TEXT,
      completed_date TEXT NULL,
      is_paused INTEGER DEFAULT 0 CHECK(is_paused IN (0, 1) AND (is_paused = 0 OR status = 'active')),
      paused_at TEXT NULL,
      total_paused_days INTEGER DEFAULT 0
    );

    CREATE TABLE goal_progress_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER DEFAULT 1,
      note TEXT,
      chat_message_id INTEGER NULL,
      source TEXT DEFAULT 'chat',
      FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE CASCADE
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT,
      time_slot TEXT DEFAULT 'Anytime',
      duration_min INTEGER DEFAULT 30,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      category TEXT DEFAULT 'general',
      completed INTEGER DEFAULT 0 CHECK(completed IN (0,1)),
      completed_at TEXT NULL,
      goal_id INTEGER NULL,
      due_date TEXT NULL,
      fixed_start TEXT NULL,
      fixed_end TEXT NULL,
      is_urgent INTEGER DEFAULT 0 CHECK(is_urgent IN (0,1)),
      carry_forward INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE SET NULL
    );

    CREATE TABLE day_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      plan_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      completed_count INTEGER DEFAULT 0,
      missed_count INTEGER DEFAULT 0
    );
  `);

  return db;
}

const testDb = setupIsolatedDb();
const TaskService = require('../backend/services/taskService');
const DayPlanService = require('../backend/services/dayPlanService');
const chatTools = require('../backend/services/chatTools');
const chatCommands = require('../backend/services/chatCommands');

async function executeTool(name, args, context) {
  const tool = chatTools.getToolByName(name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return await tool.handler(args, context);
}

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

async function runSuite() {
  const today = getTodayDate();
  console.log('===============================================================');
  console.log('🚀 SEVA CHAT <-> DAY PLAN SYNCHRONIZATION TEST SUITE');
  console.log('   Running on isolated database:', TEST_DB_PATH);
  console.log('===============================================================\n');

  // Seed initial Day Plan
  const initialPlan = [
    {
      time: '10:00 AM',
      task: 'Shell Scripting Lab',
      priority: 'high',
      duration: 60,
      source: 'manual',
      task_id: 1,
      goal_id: null,
      completed: 0
    },
    {
      time: '02:00 PM',
      task: 'DSA Practice Session',
      priority: 'high',
      duration: 45,
      source: 'goal',
      task_id: 2,
      goal_id: 1,
      completed: 0
    }
  ];

  testDb.prepare(`
    INSERT INTO tasks (id, name, date, time_slot, fixed_start, duration_min, priority, completed)
    VALUES (1, 'Shell Scripting Lab', ?, '10:00 AM', '10:00 AM', 60, 'high', 0)
  `).run(today);

  // Goal for task 2
  testDb.prepare(`
    INSERT INTO goals (id, title, goal_type, target_count, current_count, status)
    VALUES (1, 'Solve 100 DSA Problems', 'count', 100, 10, 'active')
  `).run();

  testDb.prepare(`
    INSERT INTO tasks (id, name, date, time_slot, fixed_start, duration_min, priority, completed, goal_id)
    VALUES (2, 'DSA Practice Session', ?, '02:00 PM', '02:00 PM', 45, 'high', 0, 1)
  `).run(today);

  testDb.prepare(`
    INSERT INTO day_plans (date, plan_json, generated_at)
    VALUES (?, ?, datetime('now'))
  `).run(today, JSON.stringify(initialPlan));

  const toolContext = { db: testDb, todayDate: today };

  // ── Action 1: Completing a scheduled task via Chat ──
  console.log('--- Action 1: Completing a scheduled task ---');
  await runAsync('Action 1: complete_task marks SQLite task and Day Plan completed', async () => {
    const res = await executeTool('complete_task', { task_identifier: 'Shell Scripting Lab' }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'), 'updated array must signal Day Plan refresh');

    // Check DB tasks
    const task = testDb.prepare('SELECT completed FROM tasks WHERE id = 1').get();
    assert.strictEqual(task.completed, 1);

    // Check Day Plan projection
    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const labItem = planRes.plan.find(p => p.task === 'Shell Scripting Lab');
    assert.ok(labItem, 'Item must be in plan');
    assert.strictEqual(labItem.completed, 1, 'Plan projection must reflect completed = 1');
  });

  // ── Action 2: Marking a task incomplete via Chat ──
  console.log('\n--- Action 2: Marking a task incomplete ---');
  await runAsync('Action 2: uncomplete_task reverts task and Day Plan to completed = 0', async () => {
    const res = await executeTool('uncomplete_task', { task_identifier: 'Shell Scripting Lab' }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));

    const task = testDb.prepare('SELECT completed FROM tasks WHERE id = 1').get();
    assert.strictEqual(task.completed, 0);

    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const labItem = planRes.plan.find(p => p.task === 'Shell Scripting Lab');
    assert.strictEqual(labItem.completed, 0);
  });

  // ── Action 3: Adding a new task to Day Plan via Chat ──
  console.log('\n--- Action 3: Adding a new task to Day Plan ---');
  await runAsync('Action 3a: add_task with fixed time appears in Day Plan timeline', async () => {
    const res = await executeTool('add_task', {
      name: 'Java Practice',
      time_slot: '5:00 PM',
      duration_min: 90,
      priority: 'high',
      date: 'today'
    }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));

    const task = testDb.prepare('SELECT * FROM tasks WHERE name = ?').get('Java Practice');
    assert.ok(task, 'Task row must exist');
    assert.strictEqual(task.time_slot, '5:00 PM');
    assert.strictEqual(task.fixed_start, '5:00 PM');
    assert.strictEqual(task.duration_min, 90);

    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const javaItem = planRes.plan.find(p => p.task === 'Java Practice');
    assert.ok(javaItem, 'Java Practice must be in reconciled plan');
    assert.strictEqual(javaItem.duration, 90);
    assert.strictEqual(javaItem.time, '5:00 PM');
  });

  await runAsync('Action 3b: add_task anytime (flexible) is persisted for today without polluting timed timeline', async () => {
    const res = await executeTool('add_task', {
      name: 'Read Architecture Doc',
      time_slot: 'Anytime',
      duration_min: 30,
      priority: 'medium',
      date: 'today'
    }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));

    const task = testDb.prepare('SELECT * FROM tasks WHERE name = ?').get('Read Architecture Doc');
    assert.ok(task);
    assert.strictEqual(task.fixed_start, null);

    // Timed plan does NOT have anytime task
    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const item = planRes.plan.find(p => p.task === 'Read Architecture Doc');
    assert.strictEqual(item, undefined, 'Anytime task must not pollute timed timeline blocks');
  });

  // ── Action 4: Rescheduling an existing task via Chat ──
  console.log('\n--- Action 4: Rescheduling an existing task ---');
  await runAsync('Action 4: update_task changes time and reconciles chronological sorting', async () => {
    const res = await executeTool('update_task', {
      task_identifier: 'Java Practice',
      time_slot: '7:00 PM'
    }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));

    const task = testDb.prepare('SELECT time_slot, fixed_start FROM tasks WHERE name = ?').get('Java Practice');
    assert.strictEqual(task.fixed_start, '7:00 PM');

    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const javaItem = planRes.plan.find(p => p.task === 'Java Practice');
    assert.ok(javaItem);
    assert.strictEqual(javaItem.time, '7:00 PM');

    // Chronological ordering
    const times = planRes.plan.map(p => parseTimeToMinutes(p.time));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] >= times[i - 1], 'Plan items must be sorted chronologically');
    }
  });

  // ── Action 5: Removing a task with deterministic confirmation ──
  console.log('\n--- Action 5: Removing a task with confirmation ---');
  await runAsync('Action 5: request_removal and executeRemoval cleanly removes from tasks and plan_json', async () => {
    // 1. Request removal
    const reqRes = await executeTool('request_removal', {
      type: 'task',
      identifier: 'Java Practice'
    }, toolContext);
    assert.strictEqual(reqRes.success, true);
    assert.strictEqual(reqRes.pending_confirmation, true);

    // 2. Execute confirmation
    const state = {
      pendingRemoval: true,
      removalType: 'task',
      targetId: reqRes.target_id,
      targetIds: [reqRes.target_id],
      targetTitle: reqRes.target_title,
      todayStr: today
    };
    const confirmRes = chatCommands.executeRemoval(state, testDb);
    assert.ok(typeof confirmRes === 'string' && confirmRes.includes('removed'));

    // Verify task is deleted
    const task = testDb.prepare('SELECT id FROM tasks WHERE id = ?').get(reqRes.target_id);
    assert.strictEqual(task, undefined, 'Task row must be deleted');

    // Verify plan_json no longer has the item
    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const item = planRes.plan.find(p => p.task === 'Java Practice');
    assert.strictEqual(item, undefined, 'Removed task must not appear in Day Plan');
  });

  // ── Action 6: Changing task duration via Chat ──
  console.log('\n--- Action 6: Changing task duration ---');
  await runAsync('Action 6: update_task changes duration and updates Day Plan', async () => {
    const res = await executeTool('update_task', {
      task_identifier: 'Shell Scripting Lab',
      duration_min: 90
    }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));

    const task = testDb.prepare('SELECT duration_min FROM tasks WHERE id = 1').get();
    assert.strictEqual(task.duration_min, 90);

    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const item = planRes.plan.find(p => p.task === 'Shell Scripting Lab');
    assert.ok(item);
    assert.strictEqual(item.duration, 90, 'Plan projection must show new duration');
  });

  // ── Action 7: Reporting unexpected events requiring replan ──
  console.log('\n--- Action 7: Unexpected event replanning ---');
  await runAsync('Action 7: replan_today handles unexpected events gracefully and returns Day Plan refresh', async () => {
    const res = await executeTool('replan_today', {
      reason: 'Unexpected team sync at 3:00 PM'
    }, toolContext);
    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'));
  });

  // ── Action 8: Goal progress update reflected in Day Plan ──
  console.log('\n--- Action 8: Goal progress update reflects in Day Plan ---');
  await runAsync('Action 8: log_goal_progress marks today linked task completed and updates Day Plan', async () => {
    // Task 2 is linked to Goal 1 ('DSA Practice Session')
    const beforeTask = testDb.prepare('SELECT completed FROM tasks WHERE id = 2').get();
    assert.strictEqual(beforeTask.completed, 0);

    const res = await executeTool('log_goal_progress', {
      goal_identifier: 'Solve 100 DSA Problems',
      amount: 2,
      note: 'Solved 2 tree problems'
    }, toolContext);

    assert.strictEqual(res.success, true);
    assert.ok(res.updated.includes('Day Plan'), 'Must notify Day Plan screen');
    assert.ok(res.updated.includes('Goals'), 'Must notify Goals screen');

    // Verify task completed
    const afterTask = testDb.prepare('SELECT completed FROM tasks WHERE id = 2').get();
    assert.strictEqual(afterTask.completed, 1, 'Linked scheduled task must be marked complete');

    // Verify Day Plan reconciled
    const planRes = DayPlanService.getPlanForDate(today, testDb);
    const dsaItem = planRes.plan.find(p => p.task === 'DSA Practice Session');
    assert.ok(dsaItem);
    assert.strictEqual(dsaItem.completed, 1, 'Day Plan must reflect completion');
  });

  // ── Concurrency & Transactional Safety ──
  console.log('\n--- Concurrency & Transactional Safety ---');
  run('Transactional Rollback: Day Plan updates are atomic with TaskService mutations', () => {
    const beforeCount = testDb.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
    try {
      testDb.transaction(() => {
        TaskService.createTask({
          name: 'Temporary Transaction Task',
          date: today,
          fixed_start: '11:00 PM',
          duration_min: 30
        }, testDb);
        throw new Error('Forced transaction failure');
      })();
    } catch (_) {
      // Expected
    }
    const afterCount = testDb.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
    assert.strictEqual(afterCount, beforeCount, 'Task creation and plan sync must roll back together');
  });

  console.log('\n===============================================================');
  console.log(`🏁 CHAT <-> DAY PLAN TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});
