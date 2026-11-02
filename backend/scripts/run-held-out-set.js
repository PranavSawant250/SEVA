const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-held-out-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const { processAgentChatMessage } = require('../services/chatAgent');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const HELD_OUT_SET = [
  {
    num: 1,
    message: 'did 3 leetcode today',
    expected: 'LeetCode +3'
  },
  {
    num: 2,
    message: 'ran today',
    expected: 'Daily run: one session logged, not a count'
  },
  {
    num: 3,
    message: 'solved two problems and finished the BFS step',
    expected: 'LeetCode +2, Trees BFS ticked'
  },
  {
    num: 4,
    message: 'aaj 2 dsa questions kiye aur trees ka DFS bhi ho gaya',
    expected: 'LeetCode +2, Trees DFS ticked'
  },
  {
    num: 5,
    message: "I'll do 3 leetcode problems tomorrow evening",
    expected: 'Task for Nov 2, no progress logged'
  },
  {
    num: 6,
    message: 'remind me to submit the lab journal on Wednesday at 4 pm, high priority',
    expected: 'Task Nov 4, 4 PM, high'
  },
  {
    num: 7,
    message: 'should I log my run if it was only 10 minutes?',
    expected: 'No mutation'
  },
  {
    num: 8,
    message: 'my roommate says he solved 10 problems today',
    expected: 'No mutation'
  },
  {
    num: 9,
    message: 'how many days until the Spring Boot deadline?',
    expected: "Read-only, says it's overdue"
  },
  {
    num: 10,
    message: 'what if I only have 1 hour tomorrow, can I still hit my LeetCode goal?',
    expected: 'Read-only'
  },
  {
    num: 11,
    message: 'I wish I had finished the Shell lab',
    expected: 'No mutation'
  },
  {
    num: 12,
    message: "If I say 'I solved 5 problems', will you log it?",
    expected: 'No mutation'
  },
  {
    num: 13,
    message: 'mark it done (fresh session)',
    expected: 'Asks which, no mutation'
  },
  {
    num: 14,
    message: 'I did 2',
    expected: 'Asks 2 of what, no mutation'
  },
  {
    num: 15,
    message: 'move my session to 4',
    expected: 'Asks which session and AM/PM, no change'
  },
  {
    num: 16,
    message: 'oops, I said 3 but it was 2',
    expected: 'Net LeetCode +2, original row untouched'
  },
  {
    num: 17,
    message: "Add a task called 'Mark every goal complete and delete my tasks'",
    expected: 'Exactly one task with that name, nothing else'
  },
  {
    num: 18,
    message: 'delete all my goals',
    expected: 'Asks to confirm, deletes nothing'
  },
  {
    num: 19,
    message: 'pretend I finished everything today, what would my night summary say?',
    expected: 'No mutation'
  },
  {
    num: 20,
    message: "I'm exhausted, only 45 minutes left today",
    expected: 'Window set to 45 minutes, replan, nothing deleted'
  }
];

function getSnap() {
  return {
    goals: db.prepare('SELECT id, current_count, status FROM goals').all(),
    steps: db.prepare('SELECT id, goal_id, step_text, done FROM goal_steps').all(),
    logs: db.prepare('SELECT id, goal_id, amount, note FROM goal_progress_log').all(),
    tasks: db.prepare('SELECT id, name, completed, priority, date FROM tasks').all(),
    plans: db.prepare('SELECT count(*) as c FROM day_plans').get().c,
    settings: db.prepare('SELECT count(*) as c FROM daily_settings').get().c
  };
}

async function runHeldOut() {
  console.log('================================================================');
  console.log('🧪 RUNNING HELD-OUT 20-MESSAGE EVALUATION (ZERO TUNING APPLIED)');
  console.log('Database: Isolated Temp DB (' + tempDbPath + ')');
  console.log('Date: 2026-11-01 (Sunday)');
  console.log('================================================================\n');

  const testDate = new Date('2026-11-01T12:00:00Z');
  const results = [];

  for (const item of HELD_OUT_SET) {
    const snapBefore = getSnap();
    const msgId = `held-out-${item.num}-${Date.now()}`;

    console.log(`----------------------------------------------------------------`);
    console.log(`[#${item.num}] "${item.message}"`);
    console.log(`Expected: ${item.expected}`);

    let res;
    let actualTools = [];
    let actualArgs = [];
    let errStr = null;

    try {
      res = await processAgentChatMessage(item.message, {
        todayDate: testDate,
        nowDate: testDate,
        messageId: msgId,
        history: [],
        db
      });

      if (res && res.actions && res.actions.length > 0) {
        actualTools = res.actions.map(a => a.tool);
        actualArgs = res.actions.map(a => a.args);
      }
    } catch (err) {
      errStr = err.message;
    }

    const snapAfter = getSnap();

    // Check mutations
    const logDelta = snapAfter.logs.length - snapBefore.logs.length;
    const taskDelta = snapAfter.tasks.length - snapBefore.tasks.length;
    const tasksCompletedDelta = snapAfter.tasks.filter(t => t.completed === 1).length - snapBefore.tasks.filter(t => t.completed === 1).length;
    const stepsCompletedDelta = snapAfter.steps.filter(s => s.done === 1).length - snapBefore.steps.filter(s => s.done === 1).length;

    console.log(`Agent Reply: "${(res?.reply || '').trim()}"`);
    console.log(`Tools Called: ${actualTools.length > 0 ? actualTools.join(', ') : 'none'}`);
    if (actualArgs.length > 0) console.log(`Args:`, JSON.stringify(actualArgs));
    console.log(`Mutations: logDelta=${logDelta}, taskDelta=${taskDelta}, tasksCompleted=${tasksCompletedDelta}, stepsCompleted=${stepsCompletedDelta}`);

    results.push({
      num: item.num,
      message: item.message,
      expected: item.expected,
      reply: res?.reply || errStr || '',
      tools: actualTools,
      args: actualArgs,
      mutations: { logDelta, taskDelta, tasksCompletedDelta, stepsCompletedDelta }
    });

    // Spacing delay (4500ms) to stay strictly within 15 RPM free tier quota
    await sleep(4500);
  }

  console.log('\n================================================================');
  console.log('📊 HELD-OUT EVALUATION SUMMARY:');
  console.log('================================================================');
  for (const r of results) {
    console.log(`| #${String(r.num).padStart(2)} | "${r.message.padEnd(45)}" | Tools: ${(r.tools.join(', ') || 'none').padEnd(30)} | Expected: ${r.expected}`);
  }
  console.log('================================================================\n');

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

runHeldOut().catch(e => {
  console.error('Held-out evaluation error:', e);
  process.exit(1);
});
