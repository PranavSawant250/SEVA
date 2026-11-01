/**
 * backend/scripts/test-corrections-condition.js
 * Proves Condition 2 (Corrections):
 * 1. Ignores model-supplied previous_amount.
 * 2. Finds the most recent uncorrected positive entry in last 24h, delta = correct_amount - its amount.
 * 3. Zero or several candidates: asks, changes nothing.
 * 4. Correcting to 0.
 * 5. Correcting twice.
 * 6. Correction with no prior entry (errors/asks cleanly, no change).
 * 7. Goal that was 'completed' dropping back below target returns status to 'active'.
 */

const fs = require('fs');
const path = require('path');

const originalDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.resolve(__dirname, `../temp_corrections_${Date.now()}.db`);
fs.copyFileSync(originalDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { getToolByName } = require('../services/chatTools');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  PASS: ${message}`);
}

async function runTest() {
  console.log('=== TEST SUITE: Condition 2 (Corrections Verification) ===');

  const logTool = getToolByName('log_goal_progress');
  const correctTool = getToolByName('correct_goal_progress');
  const today = '2026-11-01';
  const ctx = {
    todayDate: new Date(`${today}T12:00:00`),
    messageId: 9001
  };

  // Use existing seeded LeetCode goal if available
  let goal = db.prepare("SELECT * FROM goals WHERE title LIKE '%LeetCode%' ORDER BY id ASC LIMIT 1").get();
  if (!goal) {
    const res = db.prepare(`
      INSERT INTO goals (title, category, goal_type, target_count, current_count, status, created_date)
      VALUES ('LeetCode 320', 'coding', 'count', 50, 10, 'active', ?)
    `).run(today);
    goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(res.lastInsertRowid);
  } else {
    db.prepare("UPDATE goals SET current_count = 10, status = 'active', completed_date = NULL WHERE id = ?").run(goal.id);
  }

  // Clear prior logs for this goal in temp db
  db.prepare('DELETE FROM goal_progress_log WHERE goal_id = ?').run(goal.id);

  // -------------------------------------------------------------
  // Test 1: Correction with NO prior entry (0 candidates)
  // -------------------------------------------------------------
  console.log('\n[Test 1] Correction with no prior entry in last 24h:');
  const resNoPrior = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 1 },
    ctx
  );
  console.log('  Result:', JSON.stringify(resNoPrior));
  assert(resNoPrior.success === false, 'Fails cleanly with success: false');
  assert(resNoPrior.error.includes('No recent progress entry found'), 'Reports no recent entry found');
  const goalAfterNoPrior = db.prepare('SELECT current_count, status FROM goals WHERE id = ?').get(goal.id);
  assert(goalAfterNoPrior.current_count === 10, 'Goal count unchanged at 10');

  // -------------------------------------------------------------
  // Test 2: Standard log then correction (delta calculation & ignoring model previous_amount)
  // -------------------------------------------------------------
  console.log('\n[Test 2] Log 2 problems, then correct to 1 (ignoring model previous_amount):');
  const logRes = await logTool.handler(
    { goal_identifier: String(goal.id), amount: 2, note: 'solved 2 problems' },
    ctx
  );
  console.log('  Logged 2 problems:', JSON.stringify(logRes));
  assert(logRes.success === true, 'Logged 2 problems');
  const origRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goal.id);
  assert(origRow.amount === 2, 'Original row has amount 2');

  // Pass bogus previous_amount=99 to verify it is completely ignored
  const corr1 = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 1, previous_amount: 99 },
    { ...ctx, messageId: 9002 }
  );
  console.log('  Correction result:', JSON.stringify(corr1));
  assert(corr1.success === true, 'Correction succeeded');
  assert(corr1.compensating_delta === -1, 'Compensating delta is -1 (1 - 2 = -1)');
  assert(corr1.new_count === 11, 'Goal count adjusted from 12 to 11');

  // Verify original row is UNTOUCHED
  const origRowAfter = db.prepare('SELECT * FROM goal_progress_log WHERE id = ?').get(origRow.id);
  assert(origRowAfter.amount === 2, 'Original row amount is still 2 (NEVER edited)');

  // Verify compensating row exists
  const compRow = db.prepare('SELECT * FROM goal_progress_log WHERE note LIKE ?').get(`correction_for:${origRow.id}:%`);
  assert(compRow !== undefined && compRow.amount === -1, 'Compensating row inserted with amount -1');
  assert(compRow.chat_message_id === 9002, 'Compensating row links to correction chat_message_id 9002');

  // -------------------------------------------------------------
  // Test 3: Correcting TWICE (from 1 to 0)
  // -------------------------------------------------------------
  console.log('\n[Test 3] Correcting twice (from 1 to 0):');
  const corr2 = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 0 },
    { ...ctx, messageId: 9003 }
  );
  console.log('  Second correction result:', JSON.stringify(corr2));
  assert(corr2.success === true, 'Second correction succeeded');
  assert(corr2.compensating_delta === -1, 'Second delta is -1 (0 - 1 = -1)');
  assert(corr2.new_count === 10, 'Goal count returned to baseline 10');

  // Net sum for this goal progress log should now be exactly 0
  const netSum = db.prepare('SELECT SUM(amount) as s FROM goal_progress_log WHERE goal_id = ?').get(goal.id).s;
  assert(netSum === 0, 'Net progress log amount across 3 rows is exactly 0 (2 - 1 - 1 = 0)');

  // -------------------------------------------------------------
  // Test 4: Attempting third correction when effective amount is 0
  // -------------------------------------------------------------
  console.log('\n[Test 4] Attempting third correction when effective amount is already 0:');
  const corr3 = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 0 },
    { ...ctx, messageId: 9004 }
  );
  console.log('  Third correction result:', JSON.stringify(corr3));
  assert(corr3.success === false, 'Cannot correct because active positive candidate is now 0');

  // -------------------------------------------------------------
  // Test 5: Ambiguity when several positive candidate entries exist
  // -------------------------------------------------------------
  console.log('\n[Test 5] Several candidates (2 entries in last 24h) -> ask, change nothing:');
  await logTool.handler({ goal_identifier: String(goal.id), amount: 3 }, { ...ctx, messageId: 9005 });
  await logTool.handler({ goal_identifier: String(goal.id), amount: 4 }, { ...ctx, messageId: 9006 });

  const ambigRes = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 2 },
    { ...ctx, messageId: 9007 }
  );
  console.log('  Ambiguity result:', JSON.stringify(ambigRes));
  assert(ambigRes.success === false, 'Ambiguity returns success: false');
  assert(ambigRes.ambiguous === true, 'Ambiguity flag is set to true');
  assert(ambigRes.error.includes('Found 2 separate progress entries'), 'Asks user to clarify which entry to correct');

  // -------------------------------------------------------------
  // Test 6: Goal was 'completed' dropping back below target (status must return to 'active')
  // -------------------------------------------------------------
  console.log('\n[Test 6] Goal "completed" dropping back below target -> status returns to "active":');
  // Set target to 20, current_count to 18
  db.prepare("UPDATE goals SET target_count = 20, current_count = 18, status = 'active', completed_date = NULL WHERE id = ?").run(goal.id);
  db.prepare('DELETE FROM goal_progress_log WHERE goal_id = ?').run(goal.id);

  // Log 2 -> reaches 20/20 -> status becomes 'completed'
  const reachedRes = await logTool.handler({ goal_identifier: String(goal.id), amount: 2 }, { ...ctx, messageId: 9008 });
  assert(reachedRes.target_reached === true, 'Target reached 20/20');
  const completedGoal = db.prepare('SELECT status, completed_date, current_count FROM goals WHERE id = ?').get(goal.id);
  assert(completedGoal.status === 'completed', 'Goal status is "completed"');
  assert(completedGoal.completed_date !== null, 'Completed date is recorded');

  // Now user corrects: "only one, not two"
  const dropRes = await correctTool.handler(
    { goal_identifier: String(goal.id), correct_amount: 1 },
    { ...ctx, messageId: 9009 }
  );
  console.log('  Drop below target result:', JSON.stringify(dropRes));
  assert(dropRes.success === true, 'Correction succeeded');
  assert(dropRes.new_count === 19, 'New count is 19 (below target 20)');
  assert(dropRes.new_status === 'active', 'Returned new_status is "active"');

  const revertedGoal = db.prepare('SELECT status, completed_date, current_count FROM goals WHERE id = ?').get(goal.id);
  assert(revertedGoal.status === 'active', 'Goal status in DB reverted to "active"');
  assert(revertedGoal.completed_date === null, 'Completed date reset to null');

  // Cleanup
  try { fs.unlinkSync(tempDbPath); } catch (_) {}

  console.log('\n=== ALL CONDITION 2 CHECKS PASSED ===');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
