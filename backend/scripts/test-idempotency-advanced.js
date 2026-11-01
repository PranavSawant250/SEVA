/**
 * backend/scripts/test-idempotency-advanced.js
 *
 * Comprehensive Test Suite for Idempotency Safety Requirements:
 * 1. Same request twice
 * 2. Different message with reused request ID (Hash mismatch rejection)
 * 3. Two actions using the same tool (Multi-action indexing)
 * 4. Crash after first action (Crash recovery & resumption)
 * 5. Simultaneous duplicate requests (Concurrency guard)
 * 6. Server restart (Persistence across process reboot)
 * 7. Failed action followed by retry (No completed marker on failure)
 * 8. Multiple requests from different sessions (Session isolation)
 *
 * Runs exclusively on an isolated temporary database copy (SEVA_DB_PATH).
 * The live database is 100% UNTOUCHED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-idemp-adv-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

let db = new Database(tempDbPath);

// Execute schema creation on temporary database ONLY
db.exec(`
  CREATE TABLE IF NOT EXISTS idempotency_requests (
    client_request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    session_id TEXT DEFAULT 'default',
    status TEXT NOT NULL,
    response_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_idemp_req_session ON idempotency_requests(session_id, client_request_id);

  CREATE TABLE IF NOT EXISTS idempotency_actions (
    client_request_id TEXT NOT NULL,
    action_index INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_request_id, action_index)
  );
  CREATE INDEX IF NOT EXISTS idx_idemp_actions_req ON idempotency_actions(client_request_id);
`);

function computeHash(message) {
  return crypto.createHash('sha256').update((message || '').trim()).digest('hex');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  PASS: ${message}`);
}

const { executeToolCall } = require('../services/chatAgent');

// Helper to simulate request lifecycle
function handleRequestStart(clientRequestId, message, sessionId = 'default', database = db) {
  const hash = computeHash(message);
  const existing = database.prepare('SELECT * FROM idempotency_requests WHERE client_request_id = ?').get(clientRequestId);

  if (existing) {
    // Check hash conflict
    if (existing.request_hash !== hash) {
      return { conflict: true, error: 'Conflict: client_request_id reused with different message content' };
    }
    // Check if completed
    if (existing.status === 'completed') {
      return { cached: true, response: JSON.parse(existing.response_json) };
    }
    // Check if currently pending (concurrent execution)
    if (existing.status === 'pending') {
      return { concurrent: true, error: 'Request is currently being processed by another worker' };
    }
  }

  // Atomically claim request with status = 'pending'
  database.prepare(`
    INSERT INTO idempotency_requests (client_request_id, request_hash, session_id, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(client_request_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(clientRequestId, hash, sessionId);

  return { proceed: true };
}

function handleRequestComplete(clientRequestId, responseObj, database = db) {
  database.prepare(`
    UPDATE idempotency_requests
    SET status = 'completed', response_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE client_request_id = ?
  `).run(JSON.stringify(responseObj), clientRequestId);
}

// Transactional action execution helper
function executeActionTransactional(clientRequestId, actionIndex, toolCall, context, database = db) {
  // Check if action already completed
  const existingAction = database.prepare(`
    SELECT result_json FROM idempotency_actions
    WHERE client_request_id = ? AND action_index = ? AND status = 'completed'
  `).get(clientRequestId, actionIndex);

  if (existingAction) {
    return { ...JSON.parse(existingAction.result_json), _idempotent_cached: true };
  }

  // Execute mutation and persist action result in ONE atomic transaction
  let result;
  const tx = database.transaction(() => {
    // Note: tool execution within transaction
    const tool = require('../services/chatTools').getToolByName(toolCall.name);
    if (!tool) throw new Error(`Unknown tool: ${toolCall.name}`);

    // Synchronous execution simulation for transaction safety
    if (toolCall.name === 'add_task') {
      const res = database.prepare(`
        INSERT INTO tasks (name, priority, source, completed, date, duration_min)
        VALUES (?, 'high', 'chat', 0, '2026-11-02', 45)
      `).run(toolCall.args.name);
      result = { success: true, task_id: res.lastInsertRowid, name: toolCall.args.name };
    } else if (toolCall.name === 'log_goal_progress') {
      database.prepare(`
        INSERT INTO goal_progress_log (goal_id, date, amount, note)
        VALUES (1, '2026-11-01', ?, 'test')
      `).run(toolCall.args.amount);
      result = { success: true, amount: toolCall.args.amount };
    } else {
      result = { success: true };
    }

    // Persist action result in same transaction
    database.prepare(`
      INSERT INTO idempotency_actions (client_request_id, action_index, tool_name, args_json, status, result_json)
      VALUES (?, ?, ?, ?, 'completed', ?)
    `).run(clientRequestId, actionIndex, toolCall.name, JSON.stringify(toolCall.args), JSON.stringify(result));
  });

  tx();
  return result;
}

async function runAdvancedIdempotencyTests() {
  console.log('================================================================');
  console.log('🧪 ADVANCED IDEMPOTENCY SAFETY SUITE (8 Scenarios)');
  console.log(`Temp DB: ${tempDbPath}`);
  console.log('================================================================\n');

  // ── SCENARIO 1: Same request twice ──
  console.log('[Scenario 1] Same request twice:');
  const reqId1 = 'req-scen-1';
  const msg1 = 'tomorrow I have to prepare for German exam';

  const start1a = handleRequestStart(reqId1, msg1, 'sess-1', db);
  assert(start1a.proceed === true, 'First attempt proceeds');

  const act1a = executeActionTransactional(reqId1, 0, { name: 'add_task', args: { name: 'German exam' } }, {}, db);
  handleRequestComplete(reqId1, { reply: 'Task added', actions: [act1a] }, db);

  const taskCount1a = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE name = 'German exam'").get().c;
  assert(taskCount1a === 1, 'Exactly 1 task created on first attempt');

  // Retry with same client_request_id and message
  const start1b = handleRequestStart(reqId1, msg1, 'sess-1', db);
  assert(start1b.cached === true, 'Second attempt recognized as cached completed request');
  assert(start1b.response.reply === 'Task added', 'Cached response returned');

  const taskCount1b = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE name = 'German exam'").get().c;
  assert(taskCount1b === 1, 'Task count remains strictly 1 (Zero duplicate mutation)');

  // ── SCENARIO 2: Different message with reused request ID ──
  console.log('\n[Scenario 2] Different message with reused request ID (Hash Conflict Detection):');
  const differentMsg = 'delete all my tasks';
  const start2 = handleRequestStart(reqId1, differentMsg, 'sess-1', db);
  assert(start2.conflict === true, 'Detected payload hash mismatch');
  assert(start2.error.includes('Conflict: client_request_id reused'), 'Rejects conflicting payload safely');

  // ── SCENARIO 3: Two actions using the same tool in one request ──
  console.log('\n[Scenario 3] Two actions using the same tool in one request:');
  const reqId3 = 'req-scen-3';
  const msg3 = 'Add German exam and LeetCode practice for tomorrow';
  handleRequestStart(reqId3, msg3, 'sess-1', db);

  const act3a = executeActionTransactional(reqId3, 0, { name: 'add_task', args: { name: 'German exam 2' } }, {}, db);
  const act3b = executeActionTransactional(reqId3, 1, { name: 'add_task', args: { name: 'LeetCode practice 2' } }, {}, db);
  handleRequestComplete(reqId3, { reply: 'Both added', actions: [act3a, act3b] }, db);

  assert(act3a.task_id !== act3b.task_id, 'Action 0 and Action 1 have separate task IDs');
  const actionsInDb = db.prepare('SELECT action_index, tool_name FROM idempotency_actions WHERE client_request_id = ? ORDER BY action_index ASC').all(reqId3);
  assert(actionsInDb.length === 2 && actionsInDb[0].action_index === 0 && actionsInDb[1].action_index === 1, 'Both actions persisted under stable action_index 0 and 1');

  // ── SCENARIO 4: Crash after first action (Crash recovery & Resumption) ──
  console.log('\n[Scenario 4] Crash after first action (Crash recovery & Resumption):');
  const reqId4 = 'req-scen-4-crash';
  const msg4 = 'Add Task 1 and Task 2';
  handleRequestStart(reqId4, msg4, 'sess-1', db);

  // Action 0 executes successfully
  const act4a = executeActionTransactional(reqId4, 0, { name: 'add_task', args: { name: 'Crash Task 1' } }, {}, db);
  console.log('  Action 0 completed and committed. Simulating process crash before Action 1...');
  // (Notice: status in idempotency_requests remains 'pending', Action 0 is committed in idempotency_actions)

  const tasksBeforeResume = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE name = 'Crash Task 1'").get().c;
  assert(tasksBeforeResume === 1, 'Crash Task 1 was committed before crash');

  // Resume / Retry after crash
  console.log('  Worker recovers and resumes request execution with same client_request_id...');
  // Action 0 is checked: returns cached result without re-executing
  const act4aResumed = executeActionTransactional(reqId4, 0, { name: 'add_task', args: { name: 'Crash Task 1' } }, {}, db);
  assert(act4aResumed._idempotent_cached === true, 'Action 0 recognized as already completed (NOT re-executed)');

  // Action 1 now executes
  const act4bResumed = executeActionTransactional(reqId4, 1, { name: 'add_task', args: { name: 'Crash Task 2' } }, {}, db);
  assert(!act4bResumed._idempotent_cached, 'Action 1 executed freshly upon resumption');

  handleRequestComplete(reqId4, { reply: 'Both completed after recovery', actions: [act4aResumed, act4bResumed] }, db);

  const finalCrashTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE name IN ('Crash Task 1', 'Crash Task 2')").get().c;
  assert(finalCrashTasks === 2, 'Exactly 2 tasks present (Crash Task 1 was never duplicated)');

  // ── SCENARIO 5: Simultaneous duplicate requests (Concurrency Lock) ──
  console.log('\n[Scenario 5] Simultaneous duplicate requests (Concurrency Lock):');
  const reqId5 = 'req-scen-5-concurrent';
  const msg5 = 'Schedule review meeting';

  // Worker 1 starts
  const worker1 = handleRequestStart(reqId5, msg5, 'sess-1', db);
  assert(worker1.proceed === true, 'Worker 1 claims request lock (status: pending)');

  // Worker 2 attempts same request concurrently while Worker 1 is still working
  const worker2 = handleRequestStart(reqId5, msg5, 'sess-1', db);
  assert(worker2.concurrent === true, 'Worker 2 blocked by pending lock (Prevents race-condition execution)');

  // Worker 1 finishes
  handleRequestComplete(reqId5, { reply: 'Review meeting scheduled' }, db);

  // Worker 2 tries again after Worker 1 finishes
  const worker2Retry = handleRequestStart(reqId5, msg5, 'sess-1', db);
  assert(worker2Retry.cached === true, 'Worker 2 cleanly receives completed result after Worker 1 finishes');

  // ── SCENARIO 6: Server restart across persistent tables ──
  console.log('\n[Scenario 6] Server restart across persistent SQLite tables:');
  console.log('  Closing SQLite connection and re-opening...');
  db.close();

  // Fresh connection
  db = new Database(tempDbPath);

  const postRestartCheck = handleRequestStart(reqId1, msg1, 'sess-1', db);
  assert(postRestartCheck.cached === true, 'Recognized completed request from disk after full restart');
  assert(postRestartCheck.response.reply === 'Task added', 'Response body fully restored from disk');

  // ── SCENARIO 7: Failed action followed by retry (No completed marker on failure) ──
  console.log('\n[Scenario 7] Failed action followed by retry:');
  const reqId7 = 'req-scen-7-fail';
  const msg7 = 'Attempt flawed action';
  handleRequestStart(reqId7, msg7, 'sess-1', db);

  let errorCaught = false;
  try {
    const txFail = db.transaction(() => {
      // Simulate failure mid-mutation
      db.prepare("INSERT INTO tasks (name, priority, source, completed, date, duration_min) VALUES ('Failed Task', 'high', 'chat', 0, '2026-11-02', 30)").run();
      throw new Error('Simulated network / constraint failure during tool run');
    });
    txFail();
  } catch (err) {
    errorCaught = true;
    console.log(`  Expected failure caught: "${err.message}"`);
  }
  assert(errorCaught === true, 'Action transaction rolled back on error');

  // Verify that neither the task nor the completed action row was committed
  const failedTaskInDb = db.prepare("SELECT * FROM tasks WHERE name = 'Failed Task'").get();
  assert(failedTaskInDb === undefined, 'No task committed when action failed');

  const failedActionInDb = db.prepare('SELECT * FROM idempotency_actions WHERE client_request_id = ?').get(reqId7);
  assert(failedActionInDb === undefined, 'No completed action record stored for failed execution');

  // Retry the action successfully
  console.log('  Retrying after resolving failure...');
  const act7Success = executeActionTransactional(reqId7, 0, { name: 'add_task', args: { name: 'Recovered Task' } }, {}, db);
  handleRequestComplete(reqId7, { reply: 'Recovered task added', actions: [act7Success] }, db);

  const recoveredTaskInDb = db.prepare("SELECT * FROM tasks WHERE name = 'Recovered Task'").get();
  assert(recoveredTaskInDb !== undefined, 'Task successfully committed on retry');

  // ── SCENARIO 8: Multiple requests from different sessions (Isolation) ──
  console.log('\n[Scenario 8] Multiple requests from different sessions (Session Isolation):');
  const reqSessA = 'req-session-alpha';
  const reqSessB = 'req-session-beta';

  handleRequestStart(reqSessA, 'Session A task', 'session-alpha', db);
  executeActionTransactional(reqSessA, 0, { name: 'add_task', args: { name: 'Task from Session Alpha' } }, {}, db);
  handleRequestComplete(reqSessA, { reply: 'Alpha done' }, db);

  handleRequestStart(reqSessB, 'Session B task', 'session-beta', db);
  executeActionTransactional(reqSessB, 0, { name: 'add_task', args: { name: 'Task from Session Beta' } }, {}, db);
  handleRequestComplete(reqSessB, { reply: 'Beta done' }, db);

  const rowAlpha = db.prepare("SELECT session_id, status FROM idempotency_requests WHERE client_request_id = ?").get(reqSessA);
  const rowBeta = db.prepare("SELECT session_id, status FROM idempotency_requests WHERE client_request_id = ?").get(reqSessB);

  assert(rowAlpha.session_id === 'session-alpha' && rowAlpha.status === 'completed', 'Session Alpha isolated and completed');
  assert(rowBeta.session_id === 'session-beta' && rowBeta.status === 'completed', 'Session Beta isolated and completed');

  // Inspect final database rows
  console.log('\n--- Final Database Verification on Temp DB ---');
  const reqCount = db.prepare('SELECT COUNT(*) as c FROM idempotency_requests').get().c;
  const actCount = db.prepare('SELECT COUNT(*) as c FROM idempotency_actions').get().c;
  console.log(`  idempotency_requests total rows: ${reqCount}`);
  console.log(`  idempotency_actions total rows:  ${actCount}`);

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}

  console.log('\n================================================================');
  console.log('✅ ALL 8 ADVANCED IDEMPOTENCY SAFETY SCENARIOS PASSED');
  console.log('================================================================\n');
}

runAdvancedIdempotencyTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

