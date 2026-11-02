const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-fallback-test-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

// Force disable Gemini to test fallback behavior
process.env.GEMINI_API_KEY = '';

const db = require('../database/db');
const { processAgentChatMessage } = require('../services/chatAgent');

async function testFallback() {
  console.log('=== TEST POINT 7: FALLBACK WITH GEMINI DISABLED ===\n');

  const testDate = new Date('2026-11-01T12:00:00Z');

  const snapBefore = {
    goals: db.prepare('SELECT count(*) as c FROM goals').get().c,
    goal_progress_log: db.prepare('SELECT count(*) as c FROM goal_progress_log').get().c,
    tasks: db.prepare('SELECT count(*) as c FROM tasks').get().c
  };

  console.log('Snapshot before:', snapBefore);
  console.log('Sending message: "I solved 2 problems" with Gemini disabled...\n');

  let res;
  try {
    res = await processAgentChatMessage('I solved 2 problems', {
      todayDate: testDate,
      nowDate: testDate,
      messageId: 'test-fallback-disabled-1',
      db
    });
  } catch (err) {
    res = { reply: `Error: ${err.message}`, actions: [] };
  }

  const snapAfter = {
    goals: db.prepare('SELECT count(*) as c FROM goals').get().c,
    goal_progress_log: db.prepare('SELECT count(*) as c FROM goal_progress_log').get().c,
    tasks: db.prepare('SELECT count(*) as c FROM tasks').get().c
  };

  console.log('Agent Response:');
  console.log('  Reply:', res ? res.reply : 'null');
  console.log('  Badge / Provider:', res ? `${res.badge} / ${res.provider}` : 'null');
  console.log('  Actions invoked:', res ? res.actions : []);
  console.log('\nSnapshot after:', snapAfter);

  const mutated = (snapAfter.goals !== snapBefore.goals) ||
                  (snapAfter.goal_progress_log !== snapBefore.goal_progress_log) ||
                  (snapAfter.tasks !== snapBefore.tasks);

  console.log('Mutations detected:', mutated ? 'YES (FAIL)' : 'NO (PASS: 0 mutations)');

  const claimsLogged = /logged\s+\d+|updated\s+progress|recorded|saved to database/i.test(res?.reply || '');
  console.log('Claims anything was logged:', claimsLogged ? 'YES (FAIL)' : 'NO (PASS: does not claim logged)');

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
  console.log('\n=== FALLBACK VERIFICATION FINISHED ===');
}

testFallback().catch(e => {
  console.error(e);
  process.exit(1);
});

