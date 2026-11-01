/**
 * backend/scripts/test-negative-rows-condition.js
 * Proves Condition 3 (Negative Rows & Audit):
 * 1. Log progress today (+1) -> days_since_activity becomes 0, frequency day counted.
 * 2. Correct to 0 (delta -1, compensating row) -> net today <= 0.
 * 3. Proves: correct to 0 does NOT reset days_since_activity or count a frequency day.
 */

const fs = require('fs');
const path = require('path');

const originalDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.resolve(__dirname, `../temp_neg_${Date.now()}.db`);
fs.copyFileSync(originalDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { computeGoalProgress } = require('../services/goalsService');
const { getToolByName } = require('../services/chatTools');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  PASS: ${message}`);
}

async function runTest() {
  console.log('=== TEST SUITE: Condition 3 (Negative Rows & Net Activity Verification) ===');

  const todayStr = '2026-11-01'; // Sunday
  const todayDt = new Date(`${todayStr}T12:00:00`);
  const priorWeekDateStr = '2026-10-25'; // Previous Sunday (7 days ago, prior calendar week)

  const logTool = getToolByName('log_goal_progress');
  const correctTool = getToolByName('correct_goal_progress');

  // 1. Create a frequency goal: "Morning Run", per_week = 3, created 15 days ago
  const res = db.prepare(`
    INSERT INTO goals (title, category, goal_type, per_week, status, created_date)
    VALUES ('Morning Run Test', 'fitness', 'frequency', 3, 'active', '2026-10-15')
  `).run();
  const goalId = res.lastInsertRowid;

  // Insert a positive log 7 days ago (2026-10-25 in prior week)
  db.prepare(`
    INSERT INTO goal_progress_log (goal_id, date, amount, note)
    VALUES (?, ?, 1, '7 days ago run')
  `).run(goalId, priorWeekDateStr);

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);

  // Baseline check: before today's activity
  console.log('\n[Baseline] Checking goal progress before today:');
  const baseProgress = computeGoalProgress(goal, todayStr, todayDt);
  console.log('  Base progress:', JSON.stringify({
    dsa: baseProgress.days_since_activity,
    days_this_week: baseProgress.days_this_week,
    last_logged_today: baseProgress.last_logged_today
  }));
  assert(baseProgress.days_since_activity === 7, 'Baseline days_since_activity is 7 days ago');
  assert(baseProgress.days_this_week === 0, 'Baseline days_this_week is 0 (last activity was previous week)');
  assert(baseProgress.last_logged_today === false, 'Baseline last_logged_today is false');

  // Step 2: Log progress today (+1)
  console.log('\n[Step 2] User logs run today (+1):');
  db.prepare(`
    INSERT INTO goal_progress_log (goal_id, date, amount, note)
    VALUES (?, ?, 1, 'logged morning run')
  `).run(goalId, todayStr);

  const activeProgress = computeGoalProgress(goal, todayStr, todayDt);
  console.log('  Active progress:', JSON.stringify({
    dsa: activeProgress.days_since_activity,
    days_this_week: activeProgress.days_this_week,
    last_logged_today: activeProgress.last_logged_today
  }));
  assert(activeProgress.days_since_activity === 0, 'Active days_since_activity is 0 (logged today)');
  assert(activeProgress.days_this_week === 1, 'Active days_this_week is 1');
  assert(activeProgress.last_logged_today === true, 'Active last_logged_today is true');

  // Step 3: User corrects to 0 ("actually didn't run", delta = -1 compensating row)
  console.log('\n[Step 3] User corrects to 0 (delta = -1 compensating row inserted):');
  const targetEntry = db.prepare('SELECT id FROM goal_progress_log WHERE goal_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(goalId, todayStr);
  db.prepare(`
    INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
    VALUES (?, ?, -1, ?, 9999)
  `).run(goalId, todayStr, `correction_for:${targetEntry.id}:cancelled`);

  // Verify net amount for today in database
  const netToday = db.prepare(`
    SELECT SUM(amount) as net FROM goal_progress_log WHERE goal_id = ? AND date = ?
  `).get(goalId, todayStr).net;
  console.log(`  Net progress amount recorded for today (${todayStr}): ${netToday}`);
  assert(netToday === 0, 'Net amount for today is exactly 0 (1 + (-1) = 0)');

  // Step 4: Re-compute goal progress after correcting to 0
  console.log('\n[Step 4] Checking goal progress after correcting to 0:');
  const correctedProgress = computeGoalProgress(goal, todayStr, todayDt);
  console.log('  Corrected progress:', JSON.stringify({
    dsa: correctedProgress.days_since_activity,
    days_this_week: correctedProgress.days_this_week,
    last_logged_today: correctedProgress.last_logged_today
  }));

  assert(correctedProgress.last_logged_today === false, 'last_logged_today is FALSE after correcting to 0');
  assert(correctedProgress.days_since_activity === 7, 'days_since_activity reverted to 7 (does NOT reset to 0)');
  assert(correctedProgress.days_this_week === 0, 'days_this_week reverted to 0 (does NOT count a frequency day)');

  // Cleanup
  try { fs.unlinkSync(tempDbPath); } catch (_) {}

  console.log('\n=== ALL CONDITION 3 CHECKS PASSED ===');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
