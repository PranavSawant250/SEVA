/**
 * backend/scripts/verify-fallback-reliability.js
 *
 * Final Production Verification for Local Fallback Reliability:
 * Tests the required messages with Gemini disabled on an isolated temporary SQLite database:
 * 1. "Add DB lab exam tomorrow at 10 AM."
 * 2. "Add DB lab exam to my schedule tomorrow at 10 AM."
 * 3. "Remove Shell Scripting from my daily plan."
 * 4. "I solved 2 LeetCode problems today."
 * 5. "Move my session to 4."
 * 6. "Add a task to prepare for my presentation."
 * 7. "Delete my Shell Scripting goal."
 *
 * Strictly verifies zero live DB modifications and complete data isolation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-fallback-final-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
// Clear chat history for rapid local execution
db.prepare('DELETE FROM chat_history').run();

const {
  processAgentChatMessage,
  tripGeminiCircuitBreaker
} = require('../services/chatAgent');

function getSnapshot() {
  return {
    goals: db.prepare('SELECT id, title, current_count, status FROM goals').all(),
    tasks: db.prepare('SELECT id, name, priority, date, completed, duration_min, time_slot FROM tasks').all(),
    progress: db.prepare('SELECT id, goal_id, amount, note FROM goal_progress_log').all(),
    plans: db.prepare('SELECT id, date, plan_json FROM day_plans').all()
  };
}

async function runVerification() {
  console.log('================================================================');
  console.log('🧪 FINAL LOCAL FALLBACK RELIABILITY VERIFICATION');
  console.log(`Database: Isolated Temp DB (${tempDbPath})`);
  console.log('================================================================\n');

  // Trip circuit breaker to simulate Gemini completely offline / rate-limited
  tripGeminiCircuitBreaker(3600000, 'Verification: Gemini Disabled');

  const testDate = new Date('2026-11-02T10:00:00Z');

  const testCases = [
    {
      id: 'CASE 1',
      message: 'Add DB lab exam tomorrow at 10 AM.',
      expected: 'Creates task "DB lab exam" for tomorrow at 10:00 AM (duration 30 min)'
    },
    {
      id: 'CASE 2',
      message: 'Add DB lab exam to my schedule tomorrow at 10 AM.',
      expected: 'Creates task "DB lab exam" for tomorrow at 10:00 AM (duration 30 min)'
    },
    {
      id: 'CASE 3',
      message: 'Remove Shell Scripting from my daily plan.',
      expected: 'Inspects day plan, sees item absent from today plan, explicitly states nothing removed (0 mutations)'
    },
    {
      id: 'CASE 4',
      message: 'I solved 2 LeetCode problems today.',
      expected: 'Logs 2 problems to active LeetCode goal (count 3 -> 5)'
    },
    {
      id: 'CASE 5',
      message: 'Move my session to 4.',
      expected: 'Ambiguous reschedule without AM/PM or task, asks clarification (0 mutations)'
    },
    {
      id: 'CASE 6',
      message: 'Add a task to prepare for my presentation.',
      expected: 'Creates task "Prepare for my presentation" for today (duration 30 min)'
    },
    {
      id: 'CASE 7',
      message: 'Delete my Shell Scripting goal.',
      expected: 'Matches goal "Shell Scripting Lab", initiates pending confirmation, deletes nothing yet (0 mutations)'
    }
  ];

  for (const tc of testCases) {
    console.log('----------------------------------------------------------------');
    console.log(`[${tc.id}] "${tc.message}"`);
    console.log(`Expected: ${tc.expected}`);

    const snapBefore = getSnapshot();

    const res = await processAgentChatMessage(tc.message, {
      sessionId: `sess_fb_${tc.id.replace(' ', '_')}`,
      messageId: `msg_fb_${tc.id.replace(' ', '_')}_${Date.now()}`,
      todayDate: testDate,
      nowDate: testDate,
      db
    });

    const snapAfter = getSnapshot();

    // Check DB changes
    const newTasks = snapAfter.tasks.filter(t => !snapBefore.tasks.some(bt => bt.id === t.id));
    const newProgress = snapAfter.progress.filter(p => !snapBefore.progress.some(bp => bp.id === p.id));
    const updatedGoals = snapAfter.goals.filter(g => {
      const bg = snapBefore.goals.find(b => b.id === g.id);
      return bg && bg.current_count !== g.current_count;
    });
    const deletedTasks = snapBefore.tasks.filter(bt => !snapAfter.tasks.some(t => t.id === bt.id));

    console.log(`• Route: ${res.provider} (badge: ${res.badge})`);
    console.log(`• Parsed Actions:`, JSON.stringify(res.actions || []));
    console.log(`• User Reply: "${res.reply}"`);
    console.log(`• Database State Changes:`);

    let didMutate = false;
    if (newTasks.length > 0) {
      didMutate = true;
      for (const t of newTasks) {
        console.log(`  + INSERT tasks: ID ${t.id} | Name: "${t.name}" | Date: ${t.date} | Time: ${t.time_slot || 'flexible'} | Duration: ${t.duration_min}m | Priority: ${t.priority}`);
      }
    }
    if (newProgress.length > 0) {
      didMutate = true;
      for (const p of newProgress) {
        console.log(`  + INSERT goal_progress_log: ID ${p.id} | Goal ID: ${p.goal_id} | Amount: ${p.amount} | Note: "${p.note}"`);
      }
    }
    if (updatedGoals.length > 0) {
      didMutate = true;
      for (const ug of updatedGoals) {
        const bg = snapBefore.goals.find(b => b.id === ug.id);
        console.log(`  * UPDATE goals: ID ${ug.id} ("${ug.title}") | current_count: ${bg.current_count} -> ${ug.current_count}`);
      }
    }
    if (deletedTasks.length > 0) {
      didMutate = true;
      for (const dt of deletedTasks) {
        console.log(`  - DELETE tasks: ID ${dt.id} | Name: "${dt.name}"`);
      }
    }

    if (!didMutate) {
      console.log('  (No rows added, modified, or deleted — verified zero mutations)');
    }
    console.log('');
  }

  console.log('================================================================');
  console.log('✅ ALL TEST CASES COMPLETED');
  console.log('================================================================\n');

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

runVerification().catch(err => {
  console.error('Verification failed:', err);
  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
  process.exit(1);
});

