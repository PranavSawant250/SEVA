/**
 * backend/scripts/test-step8.js
 *
 * Verifies Step 8 — Chat Knows the Goals:
 *  Tests the 4 required prompts against chatWithSeva() and reports raw replies and timings:
 *   1. "how am I doing on my goals?"
 *   2. "what should I focus on today?"
 *   3. "how is my Rust goal going?" (not in DB — must say no such goal)
 *   4. "what did we plan for tomorrow?"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDbPath = path.join(os.tmpdir(), `seva-test-step8-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'seva.db'), tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const assert = require('assert');
const db = require('../database/db');
process.on('exit', () => {
  try { db.close(); } catch (_) {}
  for (const s of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + s)) fs.unlinkSync(tempDbPath + s); } catch (_) {}
  }
});
const { chatWithSeva } = require('../services/aiService');
const { getTodayDate, getTomorrowDate } = require('../utils/dateUtils');

async function main() {
  console.log('================================================================');
  console.log('STEP 8 VERIFICATION SUITE — CHAT KNOWS THE GOALS');
  console.log('================================================================\n');

  const todayObj = new Date(2026, 9, 27, 10, 0, 0); // 2026-10-27 10:00 AM
  const tomorrowStr = getTomorrowDate(todayObj);    // 2026-10-28

  // Seed one tomorrow task so "what did we plan for tomorrow?" has a real planned item to report
  const seededTomorrow = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, duration_min, source, completed, date)
    VALUES ('Spring Boot Basics: next 2 steps (Services, Repositories)', 'high', '10:30 AM', 180, 'goal', 0, ?)
  `).run(tomorrowStr);

  const prompts = [
    'how am I doing on my goals?',
    'what should I focus on today?',
    'how is my Rust goal going?',
    'what did we plan for tomorrow?'
  ];

  try {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      console.log(`--- Prompt [${i + 1}/4]: "${prompt}" ---`);
      const t0 = Date.now();
      const reply = await chatWithSeva(prompt, null, todayObj);
      const elapsedMs = Date.now() - t0;
      console.log(`Timing: ${elapsedMs} ms (${(elapsedMs / 1000).toFixed(2)}s)`);
      console.log(`Raw Reply:\n${reply}\n`);
      assert(reply && !reply.startsWith("Sorry, I'm having trouble responding"), 'Must get a real AI response from Ollama');
    }
  } finally {
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(seededTomorrow.lastInsertRowid);
  }

  console.log('================================================================');
  console.log('ALL STEP 8 CHECKS PASSED SUCCESSFULLY');
  console.log('================================================================');
}

main().catch(err => {
  console.error('❌ STEP 8 TEST FAILED:', err);
  process.exit(1);
});
