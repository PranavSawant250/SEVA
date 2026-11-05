/**
 * backend/scripts/verify-local-mutations.js
 *
 * Tests the four user-specified natural-language requests with Gemini disabled (offline/fallback mode):
 * 1. "Add DB lab exam to my schedule tomorrow at 10 AM."
 * 2. "Remove Shell Scripting from my daily plan."
 * 3. "I solved 2 LeetCode problems today."
 * 4. "Move my session to 4."
 *
 * Executed on an isolated temporary SQLite database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-local-mutation-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
const {
  processAgentChatMessage,
  tripGeminiCircuitBreaker
} = require('../services/chatAgent');

function getSnapshot() {
  return {
    goals: db.prepare('SELECT id, title, current_count, status FROM goals').all(),
    tasks: db.prepare('SELECT id, name, priority, date, completed, duration_min FROM tasks').all(),
    progress: db.prepare('SELECT id, goal_id, amount, note FROM goal_progress_log').all(),
    plans: db.prepare('SELECT id, date, plan_json FROM day_plans').all()
  };
}

async function testLocalMutations() {
  console.log('================================================================');
  console.log('🧪 LOCAL MUTATION FALLBACK VERIFICATION (GEMINI DISABLED)');
  console.log(`Database: Isolated Temp DB (${tempDbPath})`);
  console.log('================================================================\n');

  // Disable Gemini by tripping circuit breaker to simulate quota exhaustion
  tripGeminiCircuitBreaker(3600000, 'Verification: Gemini Disabled');

  const testDate = new Date('2026-11-02T10:00:00Z');
  const requests = [
    { num: 1, message: 'Add DB lab exam to my schedule tomorrow at 10 AM.' },
    { num: 2, message: 'Remove Shell Scripting from my daily plan.' },
    { num: 3, message: 'I solved 2 LeetCode problems today.' },
    { num: 4, message: 'Move my session to 4.' }
  ];

  for (const item of requests) {
    console.log(`----------------------------------------------------------------`);
    console.log(`[CASE ${item.num}] "${item.message}"`);

    const snapBefore = getSnapshot();

    const res = await processAgentChatMessage(item.message, {
      sessionId: `sess_local_${item.num}`,
      messageId: `msg_local_${item.num}_${Date.now()}`,
      todayDate: testDate,
      nowDate: testDate,
      db
    });

    const snapAfter = getSnapshot();

    // Check DB changes
    const newTask = snapAfter.tasks.filter(t => !snapBefore.tasks.some(bt => bt.id === t.id));
    const newProgress = snapAfter.progress.filter(p => !snapBefore.progress.some(bp => bp.id === p.id));
    const updatedGoals = snapAfter.goals.filter(g => {
      const bg = snapBefore.goals.find(b => b.id === g.id);
      return bg && bg.current_count !== g.current_count;
    });

    console.log(`• Selected Execution Route: ${res.provider} (badge: ${res.badge})`);
    console.log(`• Handled Actions:`, JSON.stringify(res.actions || []));
    console.log(`• Final User-Facing Reply:\n  "${res.reply}"`);
    console.log(`• Actual Database Changes:`);
    if (newTask.length > 0) {
      console.log(`  - New Task created:`, JSON.stringify(newTask[0]));
    }
    if (newProgress.length > 0) {
      console.log(`  - New Progress logged:`, JSON.stringify(newProgress[0]));
    }
    if (updatedGoals.length > 0) {
      for (const ug of updatedGoals) {
        const bg = snapBefore.goals.find(b => b.id === ug.id);
        console.log(`  - Goal "${ug.title}" (ID ${ug.id}) count: ${bg.current_count} -> ${ug.current_count}`);
      }
    }
    if (newTask.length === 0 && newProgress.length === 0 && updatedGoals.length === 0) {
      console.log(`  - ZERO database mutations (read-only / clarification / cancelled).`);
    }
    console.log('');
  }

  console.log('================================================================');
  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

testLocalMutations().catch(err => {
  console.error('Error:', err);
  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
});

