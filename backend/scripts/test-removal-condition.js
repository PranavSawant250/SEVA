/**
 * backend/scripts/test-removal-condition.js
 * Proves Condition 1 (Removal):
 * 1. confirm_removal is absent from tools.
 * 2. request_removal creates pending state only; deletes nothing.
 * 3. Following 'yes' deletes task.
 * 4. Following 'no' cancels removal.
 * 5. Following unrelated message cancels pending state.
 */

const fs = require('fs');
const path = require('path');

// Ensure isolated temp DB
const originalDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.resolve(__dirname, `../temp_removal_${Date.now()}.db`);
fs.copyFileSync(originalDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { TOOLS, getToolByName } = require('../services/chatTools');
const { routeCommand, getPendingState } = require('../services/chatCommands');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  PASS: ${message}`);
}

async function runTest() {
  console.log('=== TEST SUITE: Condition 1 (Removal Verification) ===');

  // Check 1: confirm_removal is NOT in tool list
  console.log('\n[Check 1] Verify confirm_removal tool is deleted from model tools:');
  const confirmTool = getToolByName('confirm_removal');
  assert(confirmTool === null, 'confirm_removal must NOT exist in chatTools');
  assert(TOOLS.every(t => t.name !== 'confirm_removal'), 'confirm_removal is completely absent from TOOLS array');

  // Insert a clean task to test
  const today = '2026-11-01';
  db.prepare("DELETE FROM tasks WHERE name = 'DSA practice'").run();
  const insertRes = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, duration_min)
    VALUES ('DSA practice', 'high', 'chat', 0, ?, 60)
  `).run(today);
  const taskId = insertRes.lastInsertRowid;
  assert(taskId > 0, `Created task 'DSA practice' with ID ${taskId}`);

  const reqRemovalTool = getToolByName('request_removal');

  // Subtest A: "delete the DSA practice task and confirm" in one message deletes NOTHING
  console.log('\n[Subtest A] Single message asking to delete and confirm:');
  const resultA = await reqRemovalTool.handler(
    { type: 'task', identifier: 'DSA practice' },
    { todayDate: new Date(`${today}T12:00:00`) }
  );

  console.log('  request_removal result:', JSON.stringify(resultA));
  assert(resultA.success === true, 'request_removal returns success');
  assert(resultA.pending_confirmation === true, 'request_removal sets pending_confirmation flag');

  const taskStillThereA = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert(taskStillThereA !== undefined && taskStillThereA.completed === 0, 'Task is NOT deleted yet (pending confirmation)');
  assert(getPendingState() !== null, 'Pending state is active');

  // Next user message is "yes"
  console.log('\n[Subtest A.1] Following message "yes":');
  const replyYes = routeCommand('yes', new Date(`${today}T12:00:00`), new Date(`${today}T12:00:00`));
  console.log('  routeCommand("yes") reply:', replyYes);
  assert(replyYes.includes('Task "DSA practice" removed'), 'Deterministic parser returned removal confirmation');

  const taskDeletedA = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert(taskDeletedA === undefined, 'Task is now deleted from DB');
  assert(getPendingState() === null, 'Pending state is cleared after confirmation');

  // Subtest B: Cancellation with "no"
  console.log('\n[Subtest B] Re-insert and cancel with "no":');
  const insertResB = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, duration_min)
    VALUES ('DSA practice', 'high', 'chat', 0, ?, 60)
  `).run(today);
  const taskIdB = insertResB.lastInsertRowid;

  await reqRemovalTool.handler(
    { type: 'task', identifier: 'DSA practice' },
    { todayDate: new Date(`${today}T12:00:00`) }
  );
  assert(getPendingState() !== null, 'Pending state created for Subtest B');

  const replyNo = routeCommand('no', new Date(`${today}T12:00:00`), new Date(`${today}T12:00:00`));
  console.log('  routeCommand("no") reply:', replyNo);
  assert(replyNo.includes('keeping "DSA practice"'), 'Reply confirms keeping task');

  const taskKeptB = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskIdB);
  assert(taskKeptB !== undefined, 'Task still exists in database');
  assert(getPendingState() === null, 'Pending state is cleared after "no"');

  // Subtest C: Cancellation with unrelated message
  console.log('\n[Subtest C] Re-insert and cancel with unrelated message:');
  const insertResC = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, duration_min)
    VALUES ('DSA practice', 'high', 'chat', 0, ?, 60)
  `).run(today);
  const taskIdC = insertResC.lastInsertRowid;

  const resultC = await reqRemovalTool.handler(
    { type: 'task', identifier: 'DSA practice' },
    { todayDate: new Date(`${today}T12:00:00`) }
  );
  console.log('  Subtest C request_removal result:', JSON.stringify(resultC));
  assert(getPendingState() !== null, 'Pending state created for Subtest C');

  // Send unrelated message
  const replyUnrelated = routeCommand('what is on my plan today?', new Date(`${today}T12:00:00`), new Date(`${today}T12:00:00`));
  console.log('  routeCommand("what is on my plan today?") reply:', replyUnrelated);
  assert(getPendingState() === null, 'Unrelated message cancels pending removal state');

  // A subsequent "yes" must now NOT delete the task
  const replySubsequentYes = routeCommand('yes', new Date(`${today}T12:00:00`), new Date(`${today}T12:00:00`));
  console.log('  routeCommand("yes") after cancellation reply:', replySubsequentYes);
  assert(replySubsequentYes === null, 'Subsequent "yes" is not intercepted because pending state was cancelled');

  const taskStillThereC = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskIdC);
  assert(taskStillThereC !== undefined, 'Task was not deleted by the unrelated message or subsequent yes');

  // Cleanup temp db
  try {
    fs.unlinkSync(tempDbPath);
  } catch (_) {}

  console.log('\n=== ALL CONDITION 1 CHECKS PASSED ===');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
