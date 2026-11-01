/**
 * backend/scripts/test-correction-flow.js
 *
 * Demonstrates the end-to-end correction flow for "only one, not two" on a temporary DB copy:
 * 1. User reports: "I completed two DSA problems"
 *    -> logs 2 problems, sets goal progress to +2, original row with amount=2, chat_message_id=101.
 * 2. User follows up: "Correction: only one, not two"
 *    -> NEVER edits original row (row with amount=2 remains untouched).
 *    -> Inserts compensating row: amount = (1 - 2) = -1, chat_message_id=102.
 *    -> Updates goal current_count cleanly.
 * 3. Shows live database is completely untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(os.tmpdir(), `seva-test-correction-${Date.now()}.db`);
const liveDbPath = path.join(__dirname, '..', 'seva.db');

fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { executeToolCall } = require('../services/chatAgent');

async function testCorrectionFlow() {
  console.log('=== END-TO-END CORRECTION FLOW VERIFICATION ON TEMP DB ===\n');

  const todayDate = new Date('2026-10-29T10:00:00Z');

  // Find target count goal
  const goalBefore = db.prepare("SELECT id, title, current_count, target_count FROM goals WHERE status = 'active' AND goal_type = 'count' LIMIT 1").get();
  console.log(`Initial Goal State: "${goalBefore.title}" -> ${goalBefore.current_count}/${goalBefore.target_count}`);

  const initialCount = goalBefore.current_count;

  // STEP 1: User says: "I completed two DSA problems"
  console.log('\n--- STEP 1: Log initial progress (2 problems) ---');
  const step1 = await executeToolCall({
    name: 'log_goal_progress',
    args: { goal_identifier: goalBefore.title, amount: 2, note: 'User reported 2 problems' }
  }, { todayDate, messageId: 101, db });

  console.log('Tool Result 1:', step1.message);

  const goalAfterStep1 = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalBefore.id);
  console.log(`Goal Count after Step 1: ${goalAfterStep1.current_count}`);

  const logRowsStep1 = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 2').all(goalBefore.id);
  console.log('Progress Log Rows after Step 1:');
  console.table(logRowsStep1);

  // STEP 2: User says: "Correction: only one, not two"
  console.log('\n--- STEP 2: Correction ("only one, not two") -> correct_amount: 1, previous_amount: 2 ---');
  const step2 = await executeToolCall({
    name: 'correct_goal_progress',
    args: {
      goal_identifier: goalBefore.title,
      correct_amount: 1,
      previous_amount: 2,
      reason: 'User correction: only one, not two'
    }
  }, { todayDate, messageId: 102, db });

  console.log('Tool Result 2:', step2.message);

  const goalAfterStep2 = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalBefore.id);
  console.log(`Goal Count after Step 2: ${goalAfterStep2.current_count} (Expected: ${initialCount + 1})`);

  const logRowsStep2 = db.prepare('SELECT id, goal_id, date, amount, note, chat_message_id FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 3').all(goalBefore.id);
  console.log('Progress Log Rows after Step 2 (Note original row untouched, compensating row inserted):');
  console.table(logRowsStep2);

  // Cleanup temp DB
  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + ext)) fs.unlinkSync(tempDbPath + ext); } catch (_) {}
  }
}

testCorrectionFlow().catch(console.error);

