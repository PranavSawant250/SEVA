const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const { getTodayDate, getYesterdayDate, getTomorrowDate } = require('../utils/dateUtils');
const { getAllGoals } = require('./goalsService');

const PREFERRED_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';

/**
 * Computes deterministic behind-pace goals list for Night Summary (no AI).
 * @param {Date} [todayDateObj=new Date()]
 */
function getBehindPaceGoals(todayDateObj = new Date()) {
  const activeGoals = getAllGoals(todayDateObj);
  return activeGoals
    .filter(g => g.is_overdue || (g.progress_source !== 'no_progress_data' && g.behind_by > 0))
    .map(g => ({
      goal_id: g.id,
      title: g.title,
      priority: g.priority,
      progress: g.progress,
      expected_progress: g.expected_progress,
      behind_by: g.behind_by,
      days_left: g.days_left,
      is_overdue: g.is_overdue,
      deadline: g.deadline
    }));
}

/**
 * Generates AI night summary message using Ollama.
 * Uses plain text mode (no format: 'json').
 */
async function generateSevaMessage(completedCount, missedCount, streak, skipAi = false) {
  const fallback = `You completed ${completedCount} of ${completedCount + missedCount} tasks today. Tomorrow is a fresh start!`;
  if (skipAi) return fallback;

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
    return content || fallback;
  } catch (err) {
    console.error('❌ Error generating seva_message via AI:', err.message);
    return fallback;
  }
}

/**
 * generateNightSummary(todayDateObj, opts)
 *
 * Computes daily summary analytics:
 *  - Segregates today's tasks into completed and missed
 *  - Calculates productivity streak relative to yesterday
 *  - Generates AI reflection message (with deterministic fallback)
 *  - Carries forward high/medium priority non-goal missed tasks to tomorrow
 *    (goal tasks are NOT copied; active goals recompute fresh work on tomorrow's plan)
 *  - Extended duplicate guard: skips any task whose name (case-insensitive)
 *    or goal_id already exists as an incomplete task for tomorrow, regardless of source
 *  - Computes deterministic behind_pace_goals list
 *  - Persists summary into night_summary table (UPSERT)
 *
 * @param {Date} [todayDateObj=new Date()] Injected date for testability
 * @param {Object} [opts={}] Optional { skipAi: boolean }
 */
async function generateNightSummary(todayDateObj = new Date(), opts = {}) {
  const today = getTodayDate(todayDateObj);
  const yesterday = getYesterdayDate(todayDateObj);
  const tomorrow = getTomorrowDate(todayDateObj);

  console.log(`\n🌙 generateNightSummary() called for date: ${today}`);

  // 1. Query today's tasks split by completed / missed
  const completedTasks = db.prepare(`
    SELECT id, name, priority, source, time_slot, goal_id
    FROM tasks
    WHERE date = ? AND completed = 1
  `).all(today);

  const missedTasks = db.prepare(`
    SELECT id, name, priority, source, time_slot, goal_id
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
  // DECISION RULE:
  //  - Goal tasks (goal_id != null) are NEVER copied forward by summaryService;
  //    active goals automatically produce fresh work on tomorrow's plan.
  //  - Non-goal tasks (goal_id == null) with high or medium priority carry forward,
  //    de-duplicated by case-insensitive task name and guarded against any existing
  //    incomplete task on tomorrow regardless of source.
  const seenCarryNames = new Set();
  const carryForwardTasks = [];
  for (const task of missedTasks) {
    if (task.goal_id !== null && task.goal_id !== undefined) continue;
    const prio = (task.priority || '').toLowerCase();
    if (prio !== 'high' && prio !== 'medium') continue;
    const normName = (task.name || '').trim().toLowerCase();
    if (!normName || seenCarryNames.has(normName)) continue;
    seenCarryNames.add(normName);
    carryForwardTasks.push(task);
  }

  console.log(`   ├─ Qualifying non-goal carry-forward tasks for (${tomorrow}): ${carryForwardTasks.length} task(s)`);

  // 4. Insert NEW rows for carried-forward tasks into tomorrow's date
  // Extended duplicate guard: skip any task whose name (case-insensitive) or goal_id
  // already exists as an incomplete task for tomorrow, regardless of source.
  const insertTaskStmt = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward)
    VALUES (?, ?, ?, 'carry_forward', 0, ?, 1)
  `);

  const checkExistingTomorrowStmt = db.prepare(`
    SELECT id FROM tasks
    WHERE date = ?
      AND completed = 0
      AND (
        LOWER(TRIM(name)) = LOWER(TRIM(?))
        OR (? IS NOT NULL AND goal_id = ?)
      )
    LIMIT 1
  `);

  const actuallyCarried = [];
  const carryForwardTx = db.transaction(() => {
    for (const task of carryForwardTasks) {
      const existing = checkExistingTomorrowStmt.get(
        tomorrow,
        task.name,
        task.goal_id ?? null,
        task.goal_id ?? null
      );

      if (!existing) {
        insertTaskStmt.run(task.name, task.priority, task.time_slot, tomorrow);
        actuallyCarried.push(task);
      }
    }
  });
  carryForwardTx();

  // 5. Generate AI seva_message
  const sevaMessage = await generateSevaMessage(completedTasks.length, missedTasks.length, streak, Boolean(opts.skipAi));

  // 6. Compute behind-pace goals (deterministic, no AI)
  const behindPaceGoals = getBehindPaceGoals(todayDateObj);

  // 7. Format JSON strings for DB persistence (preserving full object metadata)
  const completedJson = JSON.stringify(completedTasks);
  const missedJson = JSON.stringify(missedTasks);
  const carryForwardJson = JSON.stringify(carryForwardTasks);

  // 8. Save to night_summary table (UPSERT)
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

  // 9. Return parsed summary response
  return {
    date: today,
    completed_tasks: completedTasks,
    missed_tasks: missedTasks,
    carry_forward: carryForwardTasks,
    actually_inserted_for_tomorrow: actuallyCarried.length,
    behind_pace_goals: behindPaceGoals,
    seva_message: sevaMessage,
    streak
  };
}

module.exports = {
  generateNightSummary,
  getBehindPaceGoals
};
