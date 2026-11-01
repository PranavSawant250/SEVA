/**
 * backend/scripts/test-executor-a.js
 *
 * Test Suite A: Executor Tests with FIXED Model Outputs (Zero API calls).
 * Verifies:
 *  - Tool Schema & Argument Validation
 *  - Ambiguity Detection (zero mutation on ambiguous targets)
 *  - Idempotency Guards (messageId + tool + normalized args prevent double counting)
 *  - Two-Step Confirmation Flow (request_removal -> confirm_removal)
 *  - Duration, Window & Schedule Bounds & Conflicts
 *  - Failure Messages & Error Handling
 *
 * Test Isolation:
 *  - Uses an isolated temporary database copy via process.env.SEVA_DB_PATH.
 *  - Verifies live database row counts remain 100% untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Establish Isolated Temporary Database Copy
const tempDbPath = path.join(os.tmpdir(), `seva-test-executor-a-${process.pid}-${Date.now()}.db`);
const liveDbPath = path.join(__dirname, '..', 'seva.db');

if (fs.existsSync(liveDbPath)) {
  fs.copyFileSync(liveDbPath, tempDbPath);
}
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { executeToolCall, checkAndStoreIdempotency } = require('../services/chatAgent');
const { getTodayDate } = require('../utils/dateUtils');
const { clearPending } = require('../services/chatCommands');

// Helper to record row counts from a DB instance
function getRowCounts(database) {
  const tables = ['goals', 'goal_steps', 'goal_progress_log', 'tasks', 'day_plans', 'daily_settings', 'preferences', 'chat_history', 'emails'];
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = database.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
    } catch (_) {
      counts[t] = -1;
    }
  }
  return counts;
}

let passed = 0;
let total = 0;

function assert(description, condition, details = '') {
  total++;
  if (condition) {
    passed++;
    console.log(`  [PASS] Test A.${total}: ${description}`);
  } else {
    console.error(`  [FAIL] Test A.${total}: ${description}`);
    if (details) console.error(`         Details: ${details}`);
    process.exit(1);
  }
}

async function runTestSuiteA() {
  console.log('=============================================================');
  console.log('🧪 TEST SUITE A: EXECUTOR TESTS WITH FIXED MODEL OUTPUTS');
  console.log('🔒 Database Isolation: Temporary Copy');
  console.log(`   Temp DB: ${tempDbPath}`);
  console.log(`   Live DB: ${liveDbPath}`);
  console.log('=============================================================\n');

  // Verify live DB row counts prior to tests
  const Database = require('better-sqlite3');
  const liveDbBefore = new Database(liveDbPath, { readonly: true });
  const beforeCounts = getRowCounts(liveDbBefore);
  liveDbBefore.close();

  const injectedToday = new Date('2026-10-29T10:00:00Z');
  const todayStr = '2026-10-29';

  const defaultContext = {
    todayDate: injectedToday,
    nowDate: injectedToday,
    messageId: 'test-msg-001',
    db
  };

  console.log('--- 1. SCHEMA & ARGUMENT VALIDATION ---');

  // Test A.1: add_task with empty name fails
  const t1 = await executeToolCall({
    name: 'add_task',
    args: { name: '   ', priority: 'high', duration_min: 30 }
  }, defaultContext);
  assert('add_task with empty name is rejected', t1.success === false && t1.error.includes('empty'));

  // Test A.2: add_task duration bounds clamping
  const t2 = await executeToolCall({
    name: 'add_task',
    args: { name: 'Quick Task', duration_min: 5, date: todayStr }
  }, defaultContext);
  assert('add_task clamps duration below 15 min to minimum 30 min default', t2.success === true && t2.duration_min === 30);

  // Test A.3: add_task clamps duration above 480 min to maximum 480 min
  const t3 = await executeToolCall({
    name: 'add_task',
    args: { name: 'Marathon Task', duration_min: 999, date: todayStr }
  }, defaultContext);
  assert('add_task clamps duration above 480 min to maximum 480 min', t3.success === true && t3.duration_min === 480);

  // Test A.4: log_goal_progress rejects non-positive amount
  const t4 = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: 'LeetCode', amount: -2 }
  }, defaultContext);
  assert('log_goal_progress rejects non-positive amount', t4.success === false && t4.error.includes('positive integer'));

  // Test A.5: update_task requires task_identifier
  const t5 = await executeToolCall({
    name: 'update_task',
    args: { task_identifier: '', time_slot: '5:00 PM' }
  }, defaultContext);
  assert('update_task requires task_identifier', t5.success === false && t5.error.includes('required'));

  // Test A.6: request_removal rejects invalid type
  const t6 = await executeToolCall({
    name: 'request_removal',
    args: { type: 'invalid_type', identifier: 'some_id' }
  }, defaultContext);
  assert('request_removal rejects invalid type', t6.success === false && t6.error.includes('task" or "goal"'));

  console.log('\n--- 2. AMBIGUITY RESOLUTION & NO-MUTATION ---');

  // Setup: create two goals matching "DSA"
  db.prepare("INSERT INTO goals (id, title, category, status, goal_type, target_count, current_count) VALUES (901, 'DSA Practice', 'DSA', 'active', 'count', 40, 10)").run();
  db.prepare("INSERT INTO goals (id, title, category, status, goal_type, target_count, current_count) VALUES (902, 'Advanced DSA Problems', 'DSA', 'active', 'count', 30, 5)").run();

  const countBeforeAmbiguous = db.prepare('SELECT current_count FROM goals WHERE id = 901').get().current_count;

  // Test A.7: Ambiguous goal title returns clarification and leaves DB unchanged
  const t7 = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: 'DSA', amount: 2 }
  }, defaultContext);

  const countAfterAmbiguous = db.prepare('SELECT current_count FROM goals WHERE id = 901').get().current_count;
  assert('Ambiguous goal selection returns clarification prompt without mutating goal progress',
    t7.success === false && t7.ambiguous === true && countBeforeAmbiguous === countAfterAmbiguous);

  // Test A.8: Ambiguous task identifier leaves task unchanged
  db.prepare("INSERT INTO tasks (id, name, date, priority, completed) VALUES (801, 'Review Database notes', '2026-10-29', 'medium', 0)").run();
  db.prepare("INSERT INTO tasks (id, name, date, priority, completed) VALUES (802, 'Review Database lecture slides', '2026-10-29', 'medium', 0)").run();

  const t8 = await executeToolCall({
    name: 'complete_task',
    args: { task_identifier: 'Review Database', date: todayStr }
  }, defaultContext);
  const task801 = db.prepare('SELECT completed FROM tasks WHERE id = 801').get();
  const task802 = db.prepare('SELECT completed FROM tasks WHERE id = 802').get();
  assert('Ambiguous task selection returns ambiguous flag without marking tasks complete',
    t8.success === false && t8.ambiguous === true && task801.completed === 0 && task802.completed === 0);

  console.log('\n--- 3. IDEMPOTENCY (NO DOUBLE-COUNTING) ---');

  // Test A.9: Re-executing log_goal_progress with same messageId and args returns cached result and does not double-count
  const uniqueMsgId = 'msg-idemp-unique-999';
  const idempContext1 = { ...defaultContext, messageId: uniqueMsgId };

  const firstCall = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: 'DSA Practice', amount: 2 }
  }, idempContext1);

  const countAfterFirst = db.prepare('SELECT current_count FROM goals WHERE id = 901').get().current_count;

  // Second execution with identical messageId and args
  const secondCall = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: 'DSA Practice', amount: 2 }
  }, idempContext1);

  const countAfterSecond = db.prepare('SELECT current_count FROM goals WHERE id = 901').get().current_count;

  assert('Idempotency guard prevents duplicate progress increment on repeated invocation with same messageId',
    firstCall.success === true &&
    secondCall.success === true &&
    secondCall._idempotent_cached === true &&
    countAfterFirst === 12 &&
    countAfterSecond === 12);

  console.log('\n--- 4. TWO-STEP CONFIRMATION FLOW FOR REMOVALS ---');

  // Setup: create task to remove
  db.prepare("INSERT INTO tasks (id, name, date, priority, completed) VALUES (777, 'Task to be deleted', '2026-10-29', 'medium', 0)").run();

  // Test A.10: request_removal sets pending state and does NOT delete immediately
  clearPending();
  const t10 = await executeToolCall({
    name: 'request_removal',
    args: { type: 'task', identifier: 'Task to be deleted' }
  }, { ...defaultContext, messageId: 'msg-removal-req-1' });

  const taskStillExists = db.prepare('SELECT id FROM tasks WHERE id = 777').get();
  assert('request_removal creates pending confirmation without deleting task',
    t10.success === true && t10.pending_confirmation === true && Boolean(taskStillExists));

  // Test A.11: confirm_removal tool is deleted from model tools, deterministic "no" cancels removal
  const { routeCommand } = require('../services/chatCommands');
  const t11Reply = routeCommand('no', injectedToday, injectedToday);
  const taskStillPreserved = db.prepare('SELECT id FROM tasks WHERE id = 777').get();
  assert('confirm_removal is handled deterministically by user turn: "no" preserves the item',
    t11Reply.includes('keeping') && Boolean(taskStillPreserved));

  // Test A.12: deterministic "yes" executes deletion
  await executeToolCall({
    name: 'request_removal',
    args: { type: 'task', identifier: 'Task to be deleted' }
  }, { ...defaultContext, messageId: 'msg-removal-req-2' });

  const t12Reply = routeCommand('yes', injectedToday, injectedToday);
  const taskDeleted = db.prepare('SELECT id FROM tasks WHERE id = 777').get();
  assert('confirm_removal is handled deterministically by user turn: "yes" executes deletion cleanly',
    t12Reply.includes('removed') && taskDeleted === undefined);

  console.log('\n--- 5. BOUNDS & TIMETABLE CONFLICTS ---');

  // Test A.13: set_window outside bounds (15 to 960) rejected
  const t13 = await executeToolCall({
    name: 'set_window',
    args: { available_minutes: 1200 }
  }, defaultContext);
  assert('set_window rejects available_minutes outside 15-960 min',
    t13.success === false && t13.error.includes('between 15 and 960'));

  // Test A.14: Timetable conflict check prevents overlapping reschedule
  // On Thursday (2026-10-29), timetable has Artificial Intelligence at 11:00 AM - 12:00 PM
  db.prepare("INSERT INTO tasks (id, name, date, priority, completed, duration_min) VALUES (666, 'Conflicting Study Session', '2026-10-29', 'medium', 0, 60)").run();

  const t14 = await executeToolCall({
    name: 'update_task',
    args: { task_identifier: '666', time_slot: '11:15 AM' }
  }, defaultContext);

  assert('update_task detects fixed timetable class conflict and refuses schedule overwrite',
    t14.success === false && t14.error.includes('conflicts with'));

  console.log('\n--- 6. FAILURE MESSAGES & GROUNDING ---');

  // Test A.15: complete_task on non-existent task returns clean failure message
  const t15 = await executeToolCall({
    name: 'complete_task',
    args: { task_identifier: 'Nonexistent Task XYZ' }
  }, defaultContext);
  assert('complete_task on non-existent task returns clear error message',
    t15.success === false && t15.error.includes('No tasks found'));

  // Test A.16: complete_goal_step on non-existent step returns clean failure message
  const t16 = await executeToolCall({
    name: 'complete_goal_step',
    args: { step_identifier: 'Nonexistent Step XYZ' }
  }, defaultContext);
  assert('complete_goal_step on non-existent step returns clear error message',
    t16.success === false && t16.error.includes('No goal step found'));

  // Test A.17: ask_user produces clarification message with zero side effects
  const t17 = await executeToolCall({
    name: 'ask_user',
    args: { question: 'Which DSA problem set did you finish?' }
  }, defaultContext);
  assert('ask_user returns question with clarification_needed and zero mutations',
    t17.success === true && t17.clarification_needed === true && t17.message.includes('Which DSA'));

  // Verify live DB row counts remain 100% unchanged
  const liveDbAfter = new Database(liveDbPath, { readonly: true });
  const afterCounts = getRowCounts(liveDbAfter);
  liveDbAfter.close();

  let liveMatches = true;
  for (const t of Object.keys(beforeCounts)) {
    if (beforeCounts[t] !== afterCounts[t]) {
      console.error(`🚨 Live DB table "${t}" row count mismatch: before=${beforeCounts[t]}, after=${afterCounts[t]}`);
      liveMatches = false;
    }
  }

  assert('Live database remains 100% untouched and unchanged throughout tests', liveMatches);

  console.log('\n=============================================================');
  console.log(`🎉 ALL ${passed}/${total} TEST SPECIFICATIONS IN SUITE A PASSED!`);
  console.log('=============================================================\n');

  // Cleanup temp database
  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + ext)) fs.unlinkSync(tempDbPath + ext); } catch (_) {}
  }

  process.exit(0);
}

runTestSuiteA().catch(err => {
  console.error('❌ Unhandled error in Test Suite A:', err);
  process.exit(1);
});
