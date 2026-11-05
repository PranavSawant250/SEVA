const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const os = require('os');
const fs = require('fs');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-b47-b48-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const { processAgentChatMessage, executeToolCall } = require('../services/chatAgent');
const { getPendingState, clearPending } = require('../services/chatCommands');
const db = require('../database/db');

async function testRemovalSafety() {
  const testDate = new Date('2026-11-01T14:00:00Z');

  console.log('================================================================');
  console.log('SAFETY TEST 1: Unauthorized Model Tool Call to confirm_removal');
  console.log('================================================================');
  const directCallRes = await executeToolCall(
    { name: 'confirm_removal', args: { type: 'goal', identifier: 'Daily run' } },
    { db }
  );
  console.log('Direct confirm_removal result:', directCallRes);
  if (!directCallRes.success && directCallRes.error.includes('Unauthorized')) {
    console.log('[PASS] Model direct invocation of confirm_removal was strictly rejected.');
  } else {
    console.error('[FAIL] Unauthorized confirm_removal was not rejected!');
  }

  console.log('\n================================================================');
  console.log('SAFETY TEST 2: Sequence B.46 -> B.47 -> B.48');
  console.log('================================================================');

  // B.46: "Remove task Trees topic"
  clearPending();
  console.log('\n1. Executing B.46: "Remove task Trees topic"...');
  const resB46 = await processAgentChatMessage('Remove task Trees topic', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('B.46 tools called:', resB46.actions.map(a => a.tool));
  console.log('B.46 pending state:', getPendingState()?.targetTitle);

  // B.47: "Delete goal Daily run" (while pending removal for Trees topic is active)
  console.log('\n2. Executing B.47: "Delete goal Daily run"...');
  const resB47 = await processAgentChatMessage('Delete goal Daily run', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('B.47 tools called:', resB47.actions.map(a => a.tool));
  console.log('B.47 pending state:', getPendingState()?.targetTitle);

  // B.48: "I am free until 9:00 PM today" (window adjustment prompt)
  console.log('\n3. Executing B.48: "I am free until 9:00 PM today"...');
  const resB48 = await processAgentChatMessage('I am free until 9:00 PM today', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('B.48 tools called:', resB48.actions.map(a => a.tool));
  console.log('B.48 reply:', resB48.reply);

  console.log('\n================================================================');
  console.log('SAFETY TEST 3: User Confirmation Lifecycle (Request -> Yes -> Removed)');
  console.log('================================================================');
  clearPending();
  // Request removal
  const reqRes = await processAgentChatMessage('Delete goal Daily run', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('Pending state before confirm:', getPendingState()?.targetTitle);
  const goalBefore = db.prepare("SELECT status FROM goals WHERE title = 'Daily run'").get();
  console.log('Goal status before confirm:', goalBefore?.status);

  // User confirms with "yes"
  const confirmRes = await processAgentChatMessage('yes', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('Confirm actions called:', confirmRes.actions.map(a => a.tool));
  console.log('Confirm reply:', confirmRes.reply);
  const goalAfter = db.prepare("SELECT status FROM goals WHERE title = 'Daily run'").get();
  console.log('Goal status after confirm:', goalAfter?.status);

  console.log('\n================================================================');
  console.log('SAFETY TEST 4: User Cancellation Lifecycle (Request -> No -> Kept)');
  console.log('================================================================');
  clearPending();
  // Request removal of Shell Scripting Lab
  await processAgentChatMessage('Delete goal Shell Scripting Lab', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('Pending state before cancel:', getPendingState()?.targetTitle);
  const goalBeforeCancel = db.prepare("SELECT status FROM goals WHERE title = 'Shell Scripting Lab'").get();

  // User says "no"
  const cancelRes = await processAgentChatMessage('no', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('Cancel reply:', cancelRes.reply);
  console.log('Pending state after cancel:', getPendingState());
  const goalAfterCancel = db.prepare("SELECT status FROM goals WHERE title = 'Shell Scripting Lab'").get();
  console.log('Goal status after cancel:', goalAfterCancel?.status);
  if (goalBeforeCancel.status === goalAfterCancel.status) {
    console.log('[PASS] "no" preserved item untouched.');
  }

  console.log('\n================================================================');
  console.log('SAFETY TEST 5: Window adjustment prompt does not initiate removal');
  console.log('================================================================');
  clearPending();
  const windowRes = await processAgentChatMessage('I am free until 9:00 PM today', {
    todayDate: testDate, nowDate: testDate, db
  });
  console.log('Window tools called:', windowRes.actions.map(a => a.tool));
  console.log('Pending state after window adjustment:', getPendingState());
  if (getPendingState() === null) {
    console.log('[PASS] Window adjustment created zero pending removals.');
  }
}

testRemovalSafety().catch(console.error);

