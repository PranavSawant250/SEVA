const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const { getTodayDate, getYesterdayDate, getTomorrowDate } = require('../utils/dateUtils');

const PREFERRED_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';

/**
 * Generates AI night summary message using Ollama.
 * Uses plain text mode (no format: 'json').
 */
async function generateSevaMessage(completedCount, missedCount, streak) {
  const systemPrompt = `You are SEVA, a personal planning assistant. Write a short, warm, honest 1-2 sentence end-of-day summary message.
Acknowledge the user's progress gently without preachy language or guilt trips.

Context:
- Completed tasks today: ${completedCount}
- Missed tasks today: ${missedCount}
- Current streak: ${streak} day(s)`;

  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate my end-of-day summary message.' }
      ]
    });
    let content = response.message ? response.message.content.trim() : '';
    if (content.includes('\n\n')) {
      content = content.split('\n\n')[0].trim();
    }
    return content || `You completed ${completedCount} of ${completedCount + missedCount} tasks today. Tomorrow is a fresh start!`;
  } catch (err) {
    console.error('❌ Error generating seva_message via AI:', err.message);
    return `You completed ${completedCount} of ${completedCount + missedCount} tasks today. Tomorrow is a fresh start!`;
  }
}

/**
 * generateNightSummary()
 *
 * Computes daily summary analytics:
 *  - Segregates today's tasks into completed and missed
 *  - Calculates productivity streak relative to yesterday
 *  - Generates AI reflection message
 *  - Carries forward high/medium priority missed tasks to tomorrow (inserting NEW rows)
 *  - Persists summary into night_summary table (UPSERT)
 */
async function generateNightSummary() {
  const today = getTodayDate();
  const yesterday = getYesterdayDate();
  const tomorrow = getTomorrowDate();

  console.log(`\n🌙 generateNightSummary() called for date: ${today}`);

  // 1. Query today's tasks split by completed / missed
  const completedTasks = db.prepare(`
    SELECT id, name, priority, source, time_slot
    FROM tasks
    WHERE date = ? AND completed = 1
  `).all(today);

  const missedTasks = db.prepare(`
    SELECT id, name, priority, source, time_slot
    FROM tasks
    WHERE date = ? AND completed = 0
  `).all(today);

  console.log(`   ├─ Completed tasks: ${completedTasks.length}`);
  console.log(`   ├─ Missed tasks: ${missedTasks.length}`);

  // 2. Compute productivity streak
  const yesterdaySummary = db.prepare(`SELECT streak FROM night_summary WHERE date = ?`).get(yesterday);
  let streak = 1; // Default: start/continue fresh
  if (yesterdaySummary && typeof yesterdaySummary.streak === 'number' && yesterdaySummary.streak > 0) {
    streak = yesterdaySummary.streak + 1;
  }
  console.log(`   ├─ Computed streak: ${streak} day(s)`);

  // 3. Determine carry-forward tasks
  // DECISION RULE: Auto carry-forward high and medium priority missed tasks.
  // Low-priority missed tasks are NOT auto-carried forward to prevent tomorrow's list bloat.
  const carryForwardTasks = missedTasks.filter(task => {
    const prio = (task.priority || '').toLowerCase();
    return prio === 'high' || prio === 'medium';
  });

  console.log(`   ├─ Carried forward to tomorrow (${tomorrow}): ${carryForwardTasks.length} task(s)`);

  // 4. Insert NEW rows for carried-forward tasks into tomorrow's date
  const insertTaskStmt = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward)
    VALUES (?, ?, ?, 'carry_forward', 0, ?, 1)
  `);

  const carryForwardTx = db.transaction(() => {
    for (const task of carryForwardTasks) {
      // Check if this task was already carried forward to tomorrow to prevent duplicate insertion if summary runs twice
      const existing = db.prepare(`
        SELECT id FROM tasks WHERE date = ? AND name = ? AND source = 'carry_forward'
      `).get(tomorrow, task.name);

      if (!existing) {
        insertTaskStmt.run(task.name, task.priority, task.time_slot, tomorrow);
      }
    }
  });
  carryForwardTx();

  // 5. Generate AI seva_message
  const sevaMessage = await generateSevaMessage(completedTasks.length, missedTasks.length, streak);

  // 6. Format JSON strings for DB persistence (preserving full object metadata)
  const completedJson = JSON.stringify(completedTasks);
  const missedJson = JSON.stringify(missedTasks);
  const carryForwardJson = JSON.stringify(carryForwardTasks);

  // 7. Save to night_summary table (UPSERT)
  const existingSummary = db.prepare(`SELECT id FROM night_summary WHERE date = ?`).get(today);
  if (existingSummary) {
    db.prepare(`
      UPDATE night_summary
      SET completed_tasks = ?, missed_tasks = ?, carry_forward = ?, seva_message = ?, streak = ?
      WHERE date = ?
    `).run(completedJson, missedJson, carryForwardJson, sevaMessage, streak, today);
    console.log(`💾 Updated existing night_summary row for date ${today}.`);
  } else {
    db.prepare(`
      INSERT INTO night_summary (date, completed_tasks, missed_tasks, carry_forward, seva_message, streak)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(today, completedJson, missedJson, carryForwardJson, sevaMessage, streak);
    console.log(`💾 Inserted new night_summary row for date ${today}.`);
  }

  // 8. Return parsed summary response
  return {
    date: today,
    completed_tasks: completedTasks,
    missed_tasks: missedTasks,
    carry_forward: carryForwardTasks,
    seva_message: sevaMessage,
    streak
  };
}

module.exports = {
  generateNightSummary
};
