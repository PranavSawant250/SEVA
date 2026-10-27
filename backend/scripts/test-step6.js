/**
 * backend/scripts/test-step6.js
 *
 * Verifies Step 6 requirements:
 *  1. Goal carry-forward behavior across days (injected Date):
 *     - Leave today's LeetCode task incomplete
 *     - Run generateNightSummary(day1)
 *     - Advance 1 day (day2) and run generateDayPlan({ now: day2 })
 *     - Confirm:
 *       (a) summaryService did NOT copy any goal task (goal_id != null) to day2
 *       (b) day2's plan recomputes LeetCode from remaining work and creates at most 1 LeetCode row for day2
 *       (c) Extended carry-forward duplicate guard skips case-insensitive name matches and goal_id matches regardless of source
 *  2. Removal via chat (services/chatCommands.js):
 *     - "remove goal Daily run" -> "no" (cancelled, still active)
 *     - "remove goal Daily run" -> expire with shortened timeout -> "yes" (expired, still active)
 *     - "remove goal Daily run" -> interrupted by "plan tomorrow" (cancels pending removal and says so)
 *     - "remove goal Daily run" -> "haan" (status='removed', incomplete tasks >= today deleted, completed tasks & goal_progress_log preserved)
 *     - Restore "Daily run" via PATCH /api/goals/:id { status: 'active' } so 6 sample goals stay active
 *     - "remove task <text>" two-step confirmation
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDbPath = path.join(os.tmpdir(), `seva-test-step6-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'seva.db'), tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const assert = require('assert');
const express = require('express');
const db = require('../database/db');
process.on('exit', () => {
  try { db.close(); } catch (_) {}
  for (const s of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + s)) fs.unlinkSync(tempDbPath + s); } catch (_) {}
  }
});
const { generateNightSummary } = require('../services/summaryService');
const { generateDayPlan } = require('../services/plannerService');
const { routeCommand, setRemovalTimeoutMs, clearPending } = require('../services/chatCommands');
const goalsRouter = require('../routes/goals');

const app = express();
app.use(express.json());
app.use('/api/goals', goalsRouter);

function callApp(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const req = {
      method: method.toUpperCase(),
      url,
      originalUrl: url,
      baseUrl: '',
      path: url.split('?')[0],
      headers: { 'content-type': 'application/json' },
      body: body || {},
      query: {},
      params: {},
      get(h) { return this.headers[h.toLowerCase()]; },
      header(h) { return this.headers[h.toLowerCase()]; }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      json(obj) { resolve({ status: this.statusCode, body: obj }); return this; },
      send(payload) {
        try {
          resolve({ status: this.statusCode, body: typeof payload === 'string' ? JSON.parse(payload) : payload });
        } catch (_) {
          resolve({ status: this.statusCode, body: payload });
        }
        return this;
      },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    app.handle(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('================================================================');
  console.log('STEP 6 VERIFICATION SUITE');
  console.log('================================================================\n');

  const day1 = new Date(2026, 9, 27, 8, 0, 0); // 2026-10-27 08:00 AM
  const day1Str = '2026-10-27';
  const day2 = new Date(2026, 9, 28, 8, 0, 0); // 2026-10-28 08:00 AM
  const day2Str = '2026-10-28';

  // Ensure clean window (until 11:59 PM = 1439) for day1 and day2 so LeetCode is scheduled on both days
  db.prepare(`
    INSERT INTO daily_settings (date, window_end_minutes, available_minutes, done_for_day)
    VALUES (?, 1439, 600, 0)
    ON CONFLICT(date) DO UPDATE SET window_end_minutes = 1439, available_minutes = 600, done_for_day = 0
  `).run(day1Str);
  db.prepare(`
    INSERT INTO daily_settings (date, window_end_minutes, available_minutes, done_for_day)
    VALUES (?, 1439, 600, 0)
    ON CONFLICT(date) DO UPDATE SET window_end_minutes = 1439, available_minutes = 600, done_for_day = 0
  `).run(day2Str);

  // Clean any prior test rows on day2
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(day2Str);

  const leetGoal = db.prepare(`SELECT id, title FROM goals WHERE title = 'LeetCode 320' AND status = 'active'`).get();
  const runGoal = db.prepare(`SELECT id, title FROM goals WHERE title = 'Daily run' AND status = 'active'`).get();
  assert(leetGoal && runGoal, 'LeetCode 320 and Daily run active goals must exist');

  // ──────────────────────────────────────────────────────────────
  // 1. GOAL CARRY-FORWARD & EXTENDED DUPLICATE GUARD
  // ──────────────────────────────────────────────────────────────
  console.log('--- [1] Goal Carry-Forward & Extended Duplicate Guard (2026-10-27 -> 2026-10-28) ---');

  // Generate Day 1 plan so LeetCode 320 has an incomplete task row on 2026-10-27
  await generateDayPlan(day1, { skipAiNote: true });
  db.prepare(`UPDATE tasks SET completed = 0 WHERE goal_id = ? AND date = ?`).run(leetGoal.id, day1Str);

  const day1LeetRow = db.prepare(`SELECT id, name, goal_id, completed, source, date FROM tasks WHERE goal_id = ? AND date = ?`).get(leetGoal.id, day1Str);
  console.log('Day 1 (2026-10-27) LeetCode task row (left incomplete):', JSON.stringify(day1LeetRow));
  assert(day1LeetRow && day1LeetRow.completed === 0, 'Day 1 LeetCode task should exist and be incomplete');

  // Also test the extended duplicate guard:
  // Insert a high-priority standalone task on day1 ("Standalone Guard Test") AND a manual incomplete task on day2 ("standalone guard test")
  const t1Info = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, goal_id)
    VALUES ('Standalone Guard Test', 'high', 'manual', 0, ?, NULL)
  `).run(day1Str);
  const t2Info = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, goal_id)
    VALUES ('standalone guard test', 'high', 'manual', 0, ?, NULL)
  `).run(day2Str);

  // Run Night Summary for Day 1
  const summary = await generateNightSummary(day1, { skipAi: true });
  console.log('Night Summary carry_forward list:', JSON.stringify(summary.carry_forward, null, 2));
  console.log('Night Summary behind_pace_goals:', JSON.stringify(summary.behind_pace_goals, null, 2));

  // Verify (a): summaryService did NOT copy LeetCode (or any goal_id != null task) to day2
  const day2GoalCarryRows = db.prepare(`
    SELECT id, name, goal_id, source, date FROM tasks WHERE date = ? AND goal_id IS NOT NULL
  `).all(day2Str);
  console.log('Day 2 (2026-10-28) goal rows right after generateNightSummary:', JSON.stringify(day2GoalCarryRows));
  assert(day2GoalCarryRows.length === 0, 'summaryService must NOT copy goal tasks to tomorrow');
  assert(!summary.carry_forward.some(t => t.goal_id !== null && t.goal_id !== undefined), 'carry_forward array must only include non-goal tasks');

  // Verify (c): Extended duplicate guard skipped inserting a second "Standalone Guard Test" on day2
  const guardRowsDay2 = db.prepare(`
    SELECT id, name, source, date FROM tasks WHERE date = ? AND LOWER(TRIM(name)) = 'standalone guard test'
  `).all(day2Str);
  console.log('Day 2 rows for "standalone guard test" after Night Summary:', JSON.stringify(guardRowsDay2));
  assert(guardRowsDay2.length === 1 && guardRowsDay2[0].source === 'manual', 'Extended duplicate guard must skip task that already exists in tomorrow with any source');

  // Clean up the guard test rows
  db.prepare(`DELETE FROM tasks WHERE id IN (?, ?)`).run(t1Info.lastInsertRowid, t2Info.lastInsertRowid);
  // Also clean up any non-goal carry_forward rows inserted onto day2 during this test so day2 is clean
  db.prepare(`DELETE FROM tasks WHERE date = ? AND source = 'carry_forward'`).run(day2Str);
  db.prepare(`DELETE FROM night_summary WHERE date = ?`).run(day1Str);

  // Advance to Day 2 (2026-10-28) and generate the plan
  const day2PlanResult = await generateDayPlan(day2, { skipAiNote: true });
  const day2LeetRows = db.prepare(`
    SELECT id, name, goal_id, completed, source, date, duration_min FROM tasks WHERE goal_id = ? AND date = ?
  `).all(leetGoal.id, day2Str);
  const day2LeetPlanItems = day2PlanResult.plan.filter(p => p.goal_id === leetGoal.id);

  console.log('Day 2 (2026-10-28) LeetCode plan items:', JSON.stringify(day2LeetPlanItems, null, 2));
  console.log('Day 2 (2026-10-28) LeetCode DB task rows:', JSON.stringify(day2LeetRows, null, 2));

  // Verify (b): Day 2 recomputes LeetCode from remaining work (40 remaining / 4 days = 10 -> capped at 2 problems) and creates at most 1 row
  assert(day2LeetRows.length === 1, `Expected exactly 1 LeetCode row on ${day2Str}, got ${day2LeetRows.length}`);
  assert(day2LeetRows[0].name.includes('2 problems'), `Expected recomputed 2 problems on Day 2, got ${day2LeetRows[0].name}`);

  // Clean up Day 2 test rows and daily_settings
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(day2Str);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(day2Str);
  console.log('✓ [1] Passed: Goal tasks are never copied by summaryService, recompute cleanly on the next day with 1 row per date, and extended carry-forward guard works.\n');

  // ──────────────────────────────────────────────────────────────
  // 2. REMOVAL VIA CHAT (services/chatCommands.js)
  // ──────────────────────────────────────────────────────────────
  console.log('--- [2] Removal via Chat (Cancel, Expiry, Session Interruption, Confirm + Preserve History, Restore) ---');
  clearPending();
  setRemovalTimeoutMs(120000);

  // 2a. "remove goal Daily run" -> "no"
  const r1 = routeCommand('remove goal Daily run', day1);
  console.log('User: "remove goal Daily run"\nSEVA:', r1);
  assert(r1 && r1.includes('Remove goal "Daily run"?'), 'Should ask for confirmation');

  const r1No = routeCommand('no', day1);
  console.log('User: "no"\nSEVA:', r1No);
  const gAfterNo = db.prepare(`SELECT status FROM goals WHERE id = ?`).get(runGoal.id);
  console.log('Daily run status after "no":', gAfterNo.status);
  assert(gAfterNo.status === 'active', 'Goal must remain active after replying no');

  // 2b. "remove goal Daily run" -> let it expire -> "yes"
  setRemovalTimeoutMs(40); // 40ms timeout
  const r2 = routeCommand('remove goal Daily run', day1);
  console.log('\nUser: "remove goal Daily run" (with 40ms timeout)\nSEVA:', r2);
  await sleep(90);
  const r2Expired = routeCommand('yes', day1);
  console.log('User (after 90ms): "yes"\nSEVA:', r2Expired);
  const gAfterExp = db.prepare(`SELECT status FROM goals WHERE id = ?`).get(runGoal.id);
  console.log('Daily run status after expired "yes":', gAfterExp.status);
  assert(r2Expired && r2Expired.toLowerCase().includes('expired'), 'Should report confirmation expired');
  assert(gAfterExp.status === 'active', 'Goal must remain active after expired confirmation');

  // Restore normal 2-min timeout
  setRemovalTimeoutMs(120000);

  // 2c. Starting a new session ("plan tomorrow") cancels pending removal confirmation and says so
  const r3 = routeCommand('remove goal Daily run', day1);
  const r3Interrupt = routeCommand('plan tomorrow', day1);
  console.log('\nUser: "remove goal Daily run" then "plan tomorrow"\nSEVA:', r3Interrupt);
  assert(r3Interrupt && r3Interrupt.includes('Cancelled pending removal confirmation for "Daily run"'), 'Must cancel pending removal and say so');
  clearPending();

  // 2d. Seed a completed task (2026-10-25), a progress log row (2026-10-25), and an incomplete task (2026-10-27) for Daily run
  db.prepare(`DELETE FROM tasks WHERE name IN ('Daily run (completed past)', 'Daily run (incomplete today)')`).run();
  const compTaskInfo = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, goal_id)
    VALUES ('Daily run (completed past)', 'medium', 'goal', 1, '2026-10-25', ?)
  `).run(runGoal.id);
  const incompTaskInfo = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, goal_id)
    VALUES ('Daily run (incomplete today)', 'medium', 'goal', 0, ?, ?)
  `).run(day1Str, runGoal.id);
  const logInfo = db.prepare(`
    INSERT INTO goal_progress_log (goal_id, date, amount, note)
    VALUES (?, '2026-10-25', 1, 'test past run')
  `).run(runGoal.id);

  // Now confirm removal with "haan"
  const r4 = routeCommand('remove goal Daily run', day1);
  console.log('\nUser: "remove goal Daily run"\nSEVA:', r4);
  const r4Haan = routeCommand('haan', day1);
  console.log('User: "haan"\nSEVA:', r4Haan);

  const gAfterHaan = db.prepare(`SELECT id, title, status FROM goals WHERE id = ?`).get(runGoal.id);
  const compTaskStillThere = db.prepare(`SELECT id, name, completed, date FROM tasks WHERE id = ?`).get(compTaskInfo.lastInsertRowid);
  const incompTaskAfterHaan = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(incompTaskInfo.lastInsertRowid);
  const logStillThere = db.prepare(`SELECT id, goal_id, date, amount, note FROM goal_progress_log WHERE id = ?`).get(logInfo.lastInsertRowid);

  console.log('Daily run after "haan":', JSON.stringify(gAfterHaan));
  console.log('Completed task preserved:', JSON.stringify(compTaskStillThere));
  console.log('Incomplete task (>= today) after "haan":', JSON.stringify(incompTaskAfterHaan));
  console.log('Progress log preserved:', JSON.stringify(logStillThere));

  assert(gAfterHaan.status === 'removed', 'Daily run status must be removed');
  assert(compTaskStillThere && compTaskStillThere.completed === 1, 'Completed task must be preserved');
  assert(!incompTaskAfterHaan, 'Incomplete task dated >= today must be deleted');
  assert(logStillThere && logStillThere.id === Number(logInfo.lastInsertRowid), 'goal_progress_log must be preserved');

  // Clean up the test past completed task and progress log
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(compTaskInfo.lastInsertRowid);
  db.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(logInfo.lastInsertRowid);

  // 2e. Restore Daily run via PATCH /api/goals/:id { status: 'active' }
  const restoreRes = await callApp('PATCH', `/api/goals/${runGoal.id}`, { status: 'active' });
  const restoredRow = db.prepare(`SELECT id, title, status FROM goals WHERE id = ?`).get(runGoal.id);
  console.log(`\nPATCH /api/goals/${runGoal.id} { status: "active" } response:`, JSON.stringify(restoreRes.body), 'DB row:', JSON.stringify(restoredRow));
  assert(restoreRes.status === 200 && restoredRow.status === 'active', 'Daily run must be restored to active');

  const activeGoalCount = db.prepare(`SELECT COUNT(*) as c FROM goals WHERE status = 'active'`).get().c;
  console.log('Active goals count after restore:', activeGoalCount);
  assert(activeGoalCount === 6, 'All 6 sample goals must be active');

  // 2f. Test "remove task <text>" two-step confirmation
  const tempTask = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date)
    VALUES ('Temp Chat Removal Task', 'low', 'manual', 0, ?)
  `).run(day1Str);
  const rTask1 = routeCommand('remove task Temp Chat Removal Task', day1);
  console.log('\nUser: "remove task Temp Chat Removal Task"\nSEVA:', rTask1);
  const rTaskYes = routeCommand('yes', day1);
  console.log('User: "yes"\nSEVA:', rTaskYes);
  const tempTaskAfter = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(tempTask.lastInsertRowid);
  assert(!tempTaskAfter, 'Temp task must be deleted after confirmation');

  console.log('✓ [2] Passed: Chat removal and restoration verified.\n');
  console.log('================================================================');
  console.log('ALL STEP 6 CHECKS PASSED SUCCESSFULLY');
  console.log('================================================================');
}

main().catch(err => {
  console.error('❌ STEP 6 TEST FAILED:', err);
  process.exit(1);
});
