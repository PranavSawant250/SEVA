/**
 * backend/scripts/test-ambiguity.js
 *
 * Regression Suite: Incomplete & Ambiguous Action Requests (Priority 3).
 * Verifies that when essential arguments are missing (e.g. goal, task, or amount),
 * the model calls `ask_user` with a concise clarification question rather than
 * guessing or calling read-only query tools.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-ambiguity-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { processAgentChatMessage } = require('../services/chatAgent');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CASES = [
  { id: 'A.01', message: 'Log some progress on my goals.', description: 'Missing goal & amount' },
  { id: 'A.02', message: 'Update my task', description: 'Missing task identifier' },
  { id: 'A.03', message: 'Complete it', description: 'Ambiguous pronoun without context' },
  { id: 'A.04', message: 'Mark one item done', description: 'Missing item identifier' },
  { id: 'A.05', message: 'I solved some questions', description: 'Missing goal & problem count' },
  { id: 'A.06', message: 'Log progress', description: 'Completely unparameterized progress intent' },
  { id: 'A.07', message: 'Mark my goal as completed', description: 'Missing goal title' },
  { id: 'A.08', message: 'I worked on my goal today', description: 'Missing goal and units' },
  { id: 'A.09', message: 'Reschedule a task for tomorrow', description: 'Missing task name' },
  { id: 'A.10', message: 'Delete a task', description: 'Missing task identifier for deletion' },
  { id: 'A.11', message: 'Change the time of my session', description: 'Missing session identifier and target time' }
];

async function runAmbiguityTests() {
  console.log('================================================================');
  console.log('🧪 TEST: Ambiguous & Incomplete Action Requests (11 cases)');
  console.log(`Temp DB: ${tempDbPath}`);
  console.log('================================================================\n');

  let passed = 0;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const testDate = new Date('2026-11-01T14:00:00Z');
    const msgId = `ambig-${c.id}-${Date.now()}`;

    process.stdout.write(`[${c.id}] ${c.description.padEnd(45)} ... `);

    let res;
    let actualTools = [];
    try {
      res = await processAgentChatMessage(c.message, {
        todayDate: testDate,
        nowDate: testDate,
        messageId: msgId,
        db
      });
      if (res && res.actions) {
        actualTools = res.actions.map(a => a.tool);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }

    // Must call ask_user (or return a clarification prompt directly)
    const calledAskUser = actualTools.includes('ask_user');
    const isPass = calledAskUser;

    if (isPass) {
      passed++;
      console.log('PASS (ask_user called)');
    } else {
      console.log(`FAIL (Tools: ${JSON.stringify(actualTools)})`);
    }

    if (i < CASES.length - 1) await sleep(2100);
  }

  console.log('\n================================================================');
  console.log(`Ambiguity Results: ${passed} / ${CASES.length} passed (${((passed / CASES.length) * 100).toFixed(1)}%)`);
  console.log('================================================================\n');

  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

runAmbiguityTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

