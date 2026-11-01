/**
 * backend/scripts/test-quoted-speech.js
 *
 * Regression Suite: Quoted Text & Reported Speech Intent Classification.
 * Verifies that SEVA distinguishes:
 *  1. Attributed / reported speech (what someone else said/wrote) -> ZERO mutations
 *  2. Explicit user directives to schedule or execute -> Creates task / executes action
 *
 * Runs on an isolated temporary database copy (SEVA_DB_PATH).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-quoted-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { processAgentChatMessage } = require('../services/chatAgent');

function getSnapshot(database) {
  const tables = ['goals', 'goal_steps', 'goal_progress_log', 'tasks', 'day_plans', 'daily_settings'];
  const snap = {};
  for (const t of tables) {
    snap[t] = database.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
  }
  return snap;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CASES = [
  // ── NON-ACTIONABLE REPORTED / QUOTED SPEECH (ZERO MUTATIONS) ──
  {
    id: 'Q.01',
    message: 'Professor announced: "Finish two steps of the assignment tonight"',
    expectMutation: false,
    description: 'Quoted professor announcement'
  },
  {
    id: 'Q.02',
    message: 'Professor said finish the assignment tonight.',
    expectMutation: false,
    description: 'Unquoted reported speech from professor'
  },
  {
    id: 'Q.03',
    message: 'My friend told me to complete two chapters.',
    expectMutation: false,
    description: 'Friend suggestion reported'
  },
  {
    id: 'Q.04',
    message: 'The email says: please submit the lab report by 5 PM.',
    expectMutation: false,
    description: 'Reported email text'
  },
  {
    id: 'Q.05',
    message: 'Doctor told me to go for a run every day.',
    expectMutation: false,
    description: 'Doctor advice reported'
  },
  {
    id: 'Q.06',
    message: 'My boss texted: update the presentation slides.',
    expectMutation: false,
    description: 'Boss text reported'
  },
  {
    id: 'Q.07',
    message: 'Textbook exercise says solve 3 problems on trees.',
    expectMutation: false,
    description: 'Textbook instruction quoted'
  },
  {
    id: 'Q.08',
    message: 'In our discussion she mentioned "delete the database practice task".',
    expectMutation: false,
    description: 'Discussion quote mentioning deletion'
  },
  {
    id: 'Q.09',
    message: 'In the meeting, John said: "We completed the Spring Boot endpoints".',
    expectMutation: false,
    description: 'Meeting statement reported'
  },
  {
    id: 'Q.10',
    message: 'My study group suggested: "Let us practice 5 LeetCode questions tomorrow".',
    expectMutation: false,
    description: 'Group suggestion quoted'
  },
  {
    id: 'Q.11',
    message: 'The syllabus says: "Midterm exam prep starts next week".',
    expectMutation: false,
    description: 'Syllabus quote'
  },
  {
    id: 'Q.12',
    message: 'Mom reminded me: "Schedule a dentist appointment".',
    expectMutation: false,
    description: 'Family reminder quoted'
  },
  {
    id: 'Q.13',
    message: 'The TA posted on Piazza: "Complete DFS before Friday".',
    expectMutation: false,
    description: 'TA post reported'
  },
  {
    id: 'Q.14',
    message: 'Article recommends: "Read 20 pages every morning".',
    expectMutation: false,
    description: 'Article recommendation reported'
  },
  {
    id: 'Q.15',
    message: 'Classmate said: "I finished BFS topic".',
    expectMutation: false,
    description: 'Classmate progress statement quoted'
  },

  // ── ACTIONABLE DIRECTIVES (USER EXPLICITLY DIRECTS TASK CREATION) ──
  {
    id: 'Q.16',
    message: 'Add this as my task: complete two chapters tonight.',
    expectMutation: true,
    expectedTool: 'add_task',
    description: 'Explicit user directive converting text into a task'
  },
  {
    id: 'Q.17',
    message: 'Professor told me to submit the lab report, so schedule it for tomorrow at 2 PM.',
    expectMutation: true,
    expectedTool: 'add_task',
    description: 'User explicitly directs scheduling based on professor notice'
  }
];

async function runQuotedSpeechTests() {
  console.log('================================================================');
  console.log('🧪 TEST: Quoted Text & Reported Speech Regression (17 cases)');
  console.log(`Temp DB: ${tempDbPath}`);
  console.log('================================================================\n');

  let passed = 0;
  const results = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const testDate = new Date('2026-11-01T14:00:00Z');
    const msgId = `quoted-${c.id}-${Date.now()}`;

    const snapBefore = getSnapshot(db);
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

    const snapAfter = getSnapshot(db);
    let mutated = false;
    for (const tbl of Object.keys(snapBefore)) {
      if (snapAfter[tbl] !== snapBefore[tbl]) mutated = true;
    }

    let isPass = false;
    if (!c.expectMutation) {
      // Must NOT mutate and must NOT execute task-creation or progress tools
      const noMutatingTool = actualTools.every(t => t.startsWith('get_') || t === 'ask_user' || actualTools.length === 0);
      isPass = !mutated && noMutatingTool;
    } else {
      // MUST execute requested tool and mutate
      isPass = actualTools.includes(c.expectedTool) && mutated;
    }

    if (isPass) {
      passed++;
      console.log(`PASS (${actualTools.join(', ') || 'pure conversational'})`);
    } else {
      console.log(`FAIL (Mutated: ${mutated}, Tools: ${JSON.stringify(actualTools)})`);
    }

    results.push({
      id: c.id,
      description: c.description,
      message: c.message,
      expectMutation: c.expectMutation,
      actualMutated: mutated,
      tools: actualTools.join(', ') || 'none',
      status: isPass ? 'PASS' : 'FAIL'
    });

    if (i < CASES.length - 1) await sleep(2100);
  }

  console.log('\n================================================================');
  console.log(`Quoted Speech Results: ${passed} / ${CASES.length} passed (${((passed / CASES.length) * 100).toFixed(1)}%)`);
  console.log('================================================================\n');

  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

runQuotedSpeechTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

