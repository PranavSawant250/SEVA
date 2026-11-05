const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-case16-test-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { processAgentChatMessage } = require('../services/chatAgent');

async function testCase16() {
  console.log('Testing Case #16 in controlled sequence:');
  const testDate = new Date('2026-11-01T12:00:00Z');

  // Step 1: Initial state
  const initialGoal = db.prepare("SELECT current_count FROM goals WHERE title LIKE '%LeetCode%'").get();
  console.log('Initial LeetCode count:', initialGoal.current_count);

  // User previously logged 3: "did 3 leetcode today"
  console.log('\n--- Step 1: User says "did 3 leetcode today" ---');
  const res1 = await processAgentChatMessage('did 3 leetcode today', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: 'step1-test',
    history: [],
    db
  });
  console.log('Step 1 Reply:', res1.reply);
  const midGoal = db.prepare("SELECT current_count FROM goals WHERE title LIKE '%LeetCode%'").get();
  console.log('Mid LeetCode count:', midGoal.current_count);
  const midLogs = db.prepare("SELECT id, goal_id, amount, note FROM goal_progress_log WHERE goal_id = 1").all();
  console.log('Mid Logs:', midLogs);

  // Step 2: User says "oops, I said 3 but it was 2"
  console.log('\n--- Step 2: User says "oops, I said 3 but it was 2" ---');
  const res2 = await processAgentChatMessage('oops, I said 3 but it was 2', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: 'step2-test',
    history: [
      { role: 'user', content: 'did 3 leetcode today' },
      { role: 'assistant', content: res1.reply }
    ],
    db
  });
  console.log('Step 2 Reply:', res2.reply);
  console.log('Step 2 Actions:', res2.actions);

  const afterGoal = db.prepare("SELECT current_count FROM goals WHERE title LIKE '%LeetCode%'").get();
  console.log('Final LeetCode count:', afterGoal.current_count);
  const finalLogs = db.prepare('SELECT id, goal_id, amount, note FROM goal_progress_log WHERE goal_id = 1').all();
  console.log('Final Logs:', finalLogs);

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

testCase16().catch(console.error);
