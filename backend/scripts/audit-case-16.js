const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-case16-audit-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { executeToolCall } = require('../services/chatAgent');

function getTableHash(tableName) {
  const rows = db.prepare(`SELECT * FROM ${tableName} ORDER BY id ASC`).all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function auditCase16() {
  console.log('================================================================');
  console.log('CASE #16 AUDIT: "oops, I said 3 but it was 2"');
  console.log('Expected: Net LeetCode +2, original row untouched');
  console.log('================================================================\n');

  const testDate = new Date('2026-11-01T12:00:00Z');

  // Find the active LeetCode count goal
  const goal = db.prepare("SELECT id, title, current_count, target_count, status FROM goals WHERE title LIKE '%LeetCode%' AND status = 'active' LIMIT 1").get();
  console.log('Target Goal:', goal);

  const initialCount = goal.current_count;
  console.log(`Initial DB State: Goal "${goal.title}" current_count = ${initialCount}`);

  // 1. Initial user message: "did 3 leetcode today"
  console.log('\n--- 1. User reported 3 problems ---');
  const logRes = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: goal.title, amount: 3, note: 'User reported 3 problems' }
  }, { todayDate: testDate, messageId: 901, db });

  console.log('Log Tool Result:', logRes);

  const goalAfterLog = db.prepare('SELECT id, title, current_count, status FROM goals WHERE id = ?').get(goal.id);
  const originalLogRow = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goal.id);

  console.log(`After initial log: current_count = ${goalAfterLog.current_count} (was ${initialCount}, delta = +3)`);
  console.log('Original log row in DB:', originalLogRow);

  const originalRowId = originalLogRow.id;
  const originalRowSnapshot = JSON.stringify(originalLogRow);

  // 2. User correction message: "oops, I said 3 but it was 2"
  console.log('\n--- 2. User says: "oops, I said 3 but it was 2" ---');
  const correctRes = await executeToolCall({
    name: 'correct_goal_progress',
    args: {
      goal_identifier: goal.title,
      correct_amount: 2,
      reason: 'oops, I said 3 but it was 2'
    }
  }, { todayDate: testDate, messageId: 902, db });

  console.log('Correction Tool Result:', correctRes);

  // 3. Inspect DB state after correction
  const goalAfterCorrect = db.prepare('SELECT id, title, current_count, status FROM goals WHERE id = ?').get(goal.id);
  const originalRowAfter = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE id = ?').get(originalRowId);
  const compensatingRow = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE goal_id = ? AND note LIKE ?').get(goal.id, `correction_for:${originalRowId}:%`);

  console.log('\n--- 3. Database State Verification ---');
  console.log(`Original Goal Count before any action: ${initialCount}`);
  console.log(`Goal Count after initial +3:           ${goalAfterLog.current_count}`);
  console.log(`Goal Count after correction:           ${goalAfterCorrect.current_count}`);
  console.log(`Net Change from Initial:               +${goalAfterCorrect.current_count - initialCount} (Expected: +2)`);
  console.log('\nOriginal Row check:');
  console.log('  Original row before correction:', originalRowSnapshot);
  console.log('  Original row after correction: ', JSON.stringify(originalRowAfter));
  console.log(`  Original row untouched:         ${JSON.stringify(originalRowAfter) === originalRowSnapshot}`);

  console.log('\nCompensating Row created:');
  console.log('  Compensating row:', compensatingRow);
  console.log(`  Compensating row amount:        ${compensatingRow.amount} (Expected: -1)`);

  const allLogs = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE goal_id = ? ORDER BY id ASC').all(goal.id);
  console.log('\nAll Goal Progress Log rows for this goal:');
  console.table(allLogs);

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

auditCase16().catch(console.error);

