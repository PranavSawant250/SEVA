const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-concurrency-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const { processAgentChatMessage } = require('../services/chatAgent');
const db = require('../database/db');

async function testConcurrentIdempotency() {
  console.log('================================================================');
  console.log('🧪 CONCURRENT REQUESTS IDEMPOTENCY TEST');
  console.log('================================================================');

  const testDate = new Date('2026-11-01T14:00:00Z');
  const sharedRequestId = `concurrent-req-${Date.now()}`;
  const sharedSessionId = 'sess_concurrency_test_123';

  // Seed initial state
  const goalBefore = db.prepare("SELECT current_count FROM goals WHERE id = 7").get();
  const initialCount = goalBefore.current_count;
  console.log(`Initial LeetCode count (Goal 7): ${initialCount}`);

  console.log('\n--- Firing 3 simultaneous identical requests with same client_request_id ---');
  const p1 = processAgentChatMessage('I solved 2 LeetCode problems today.', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: sharedRequestId,
    sessionId: sharedSessionId,
    db
  });

  const p2 = processAgentChatMessage('I solved 2 LeetCode problems today.', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: sharedRequestId,
    sessionId: sharedSessionId,
    db
  });

  const p3 = processAgentChatMessage('I solved 2 LeetCode problems today.', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: sharedRequestId,
    sessionId: sharedSessionId,
    db
  });

  const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

  console.log('Response 1 success:', res1.success, '| cached:', Boolean(res1._idempotent_cached));
  console.log('Response 2 success:', res2.success, '| cached:', Boolean(res2._idempotent_cached));
  console.log('Response 3 success:', res3.success, '| cached:', Boolean(res3._idempotent_cached));

  const goalAfter = db.prepare("SELECT current_count FROM goals WHERE id = 7").get();
  console.log(`Final LeetCode count (Goal 7): ${goalAfter.current_count}`);

  const diff = goalAfter.current_count - initialCount;
  console.log(`Count incremented by: ${diff} (Expected: 2)`);
  assert.strictEqual(diff, 2, 'Goal must be incremented by exactly 2 once, NOT 6!');

  // Check progress log rows
  const logs = db.prepare("SELECT id, amount, note FROM goal_progress_log WHERE goal_id = 7 AND date = '2026-11-01'").all();
  console.log('Logged rows for date 2026-11-01:', logs);
  assert.strictEqual(logs.length, 1, 'Exactly 1 progress log row created across 3 concurrent requests');

  console.log('\n✅ CONCURRENT IDEMPOTENCY PASSED: Zero duplicate executions under parallel race conditions.');
}

testConcurrentIdempotency().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

