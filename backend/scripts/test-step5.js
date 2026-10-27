/**
 * backend/scripts/test-step5.js
 *
 * Live verification of Step 5:
 * 1. Real data first: buildScheduleFromDb against real seva.db (6 active goals)
 * 2. time_slot parsing: "9AM", "9 AM", "9:00 AM", "3:30 PM", and "banana"
 * 3. Window not set -> { success: false, needs_window: true }
 * 4. Call GET /api/plan/generate 3 times -> 1 task row per (goal_id, date)
 * 5. Check & uncheck goal tasks (count, milestone with steps, step-less, frequency) + double-toggle guard
 * 6. POST /api/plan/replan with "Surprise viva with Professor Rathod at 3:30 PM" -> slot appears, no flexible overlaps
 * 7. PLANNER_ENGINE=scheduler vs PLANNER_ENGINE=ai config flag
 */

process.env.SKIP_AI_PLAN_NOTE = '1'; // deterministic fast note for scheduler tests; AI tested explicitly in #7

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDbPath = path.join(os.tmpdir(), `seva-test-step5-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'seva.db'), tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const express = require('express');
const http = require('http');
const db = require('../database/db');
process.on('exit', () => {
  try { db.close(); } catch (_) {}
  for (const s of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + s)) fs.unlinkSync(tempDbPath + s); } catch (_) {}
  }
});
const { parseTimeToMinutes } = require('../utils/dateUtils');
const { assertNoOverlaps, buildDaySchedule } = require('../services/schedulerService');
const { buildScheduleFromDb } = require('../services/plannerService');

const planRouter = require('../routes/plan');
const tasksRouter = require('../routes/tasks');
const settingsRouter = require('../routes/settings');
const goalsRouter = require('../routes/goals');

function check(cond, msg) {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

function request(app, method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr, 'http://localhost');
    const query = {};
    for (const [k, v] of u.searchParams.entries()) query[k] = v;

    const req = {
      method: method.toUpperCase(),
      url: urlStr,
      originalUrl: urlStr,
      path: u.pathname,
      query,
      body: body || {},
      headers: { 'content-type': 'application/json' },
      get(h) { return this.headers[h.toLowerCase()]; }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload) {
        try {
          resolve({ status: this.statusCode, body: typeof payload === 'string' ? JSON.parse(payload) : payload });
        } catch {
          resolve({ status: this.statusCode, body: payload });
        }
        return this;
      },
      end(payload) {
        resolve({ status: this.statusCode, body: payload });
      }
    };
    try {
      app.handle(req, res, err => {
        if (err) reject(err);
        else resolve({ status: 404, body: { error: 'Not found' } });
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function main() {
  const app = express();
  app.use('/api/plan', planRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/goals', goalsRouter);

  const server = app;
  const SIM_NOW = '2026-10-27T08:00:00';
  const SIM_DATE = '2026-10-27';

  try {
    // Prepare clean today state while keeping the 6 imported goals in seva.db
    db.prepare(`UPDATE preferences SET neglect_days = 3 WHERE id = 1`).run();
    db.prepare(`UPDATE goals SET created_date = '2026-10-21' WHERE id = 2`).run(); // 6d inactive so floor triggers
    db.prepare(`DELETE FROM tasks WHERE date = ? AND goal_id IS NOT NULL`).run(SIM_DATE);
    db.prepare(`DELETE FROM goal_progress_log WHERE date = ?`).run(SIM_DATE);

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('1. REAL DATA FIRST — buildScheduleFromDb on real seva.db (6 goals)');
    console.log('══════════════════════════════════════════════════════════════════════');
    const { schedule: realSched, inputs: realInputs } = buildScheduleFromDb(
      new Date(SIM_NOW),
      { nowMinutes: 480, windowEndMinutes: 960, doneForDay: false }
    );
    console.log('\nActive Goals read via getAllGoals():');
    console.log(JSON.stringify(realInputs.allGoals.filter(g => g.status === 'active').map(g => ({
      id: g.id, title: g.title, goal_type: g.goal_type,
      is_overdue: g.is_overdue, days_left: g.days_left,
      expected_progress: g.expected_progress, progress: g.progress, behind_by: g.behind_by,
      days_since_activity: g.days_since_activity, last_logged_today: g.last_logged_today,
      steps: g.steps
    })), null, 2));
    console.log('\nRaw plan:');
    console.log(JSON.stringify(realSched.plan, null, 2));
    console.log('\nDeferred:');
    console.log(JSON.stringify(realSched.deferred, null, 2));
    console.log('\nFloorSessions:');
    console.log(JSON.stringify(realSched.floorSessions, null, 2));
    console.log('\nShrunk:');
    console.log(JSON.stringify(realSched.shrunk, null, 2));

    check(realSched.floorSessions.length === 1 && realSched.floorSessions[0].item === 'PostgreSQL + Spring Boot',
      'PostgreSQL + Spring Boot appears in floorSessions');
    check(!realSched.shrunk.some(s => s.goal_id === 2 || s.floor), 'Floor session is NOT in shrunk');

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('2. TIME_SLOT PARSING — "9AM", "9 AM", "9:00 AM", "3:30 PM", "banana"');
    console.log('══════════════════════════════════════════════════════════════════════');
    const formats = ['9AM', '9 AM', '9:00 AM', '3:30 PM', 'banana'];
    for (const f of formats) {
      console.log(`  parseTimeToMinutes(${JSON.stringify(f)}) => ${parseTimeToMinutes(f)}`);
    }
    check(parseTimeToMinutes('9AM') === 540, '"9AM" -> 540');
    check(parseTimeToMinutes('9 AM') === 540, '"9 AM" -> 540');
    check(parseTimeToMinutes('9:00 AM') === 540, '"9:00 AM" -> 540');
    check(parseTimeToMinutes('3:30 PM') === 930, '"3:30 PM" -> 930');
    check(parseTimeToMinutes('banana') === null, '"banana" -> null (never throws)');

    const tsSched = buildDaySchedule({
      today: SIM_DATE,
      nowMinutes: 480,
      windowEndMinutes: 1080,
      bufferMinutes: 15,
      flexibleTasks: [
        { id: 901, name: 'Slot 9AM', priority: 'high', source: 'manual', time_slot: '9AM', duration_min: 30 },
        { id: 902, name: 'Slot 3:30 PM', priority: 'high', source: 'manual', time_slot: '3:30 PM', duration_min: 30 },
        { id: 903, name: 'Slot Garbage', priority: 'medium', source: 'manual', time_slot: 'not-a-time', duration_min: 30 }
      ]
    });
    console.log('  Scheduled with 9AM, 3:30 PM, and garbage time_slot:', JSON.stringify(tsSched.plan.map(b => ({ task: b.task, time: b.time, startMinutes: b.startMinutes, pinned: !!b.pinned }))));
    check(tsSched.plan.find(b => b.task === 'Slot 9AM').startMinutes === 540, '"Slot 9AM" pinned at 9:00 AM (540)');
    check(tsSched.plan.find(b => b.task === 'Slot 3:30 PM').startMinutes === 930, '"Slot 3:30 PM" pinned at 3:30 PM (930)');
    check(tsSched.plan.find(b => b.task === 'Slot Garbage').startMinutes === 480, '"Slot Garbage" ignores bad preference and uses first free gap (8:00 AM / 480)');

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('3. WINDOW NOT SET vs WINDOW SET + REGENERATE 3x (NO DUPLICATE ROWS)');
    console.log('══════════════════════════════════════════════════════════════════════');
    const savedSettings = db.prepare('SELECT * FROM daily_settings').all();
    db.prepare('DELETE FROM daily_settings').run();
    db.prepare('INSERT INTO daily_settings (date, available_minutes) VALUES (?, 300)').run(SIM_DATE);

    const noWinRes = await request(server, 'GET', `/api/plan/generate?now=${encodeURIComponent(SIM_NOW)}`);
    console.log('GET /api/plan/generate (window unset):', JSON.stringify(noWinRes.body, null, 2));
    check(noWinRes.body.success === false && noWinRes.body.needs_window === true, 'Returns { success:false, needs_window:true } when window is unset');
    check(noWinRes.body.hint && noWinRes.body.hint.includes('5 hours'), 'Includes tonight_budget_hint when available_minutes exists');

    // Set window end to 7:00 PM (1140 mins) for SIM_DATE so blocks fit both before and after 2-4 PM DSA Lab
    db.prepare(`
      INSERT INTO daily_settings (date, window_end_minutes, available_minutes, done_for_day)
      VALUES (?, 1140, 480, 0)
      ON CONFLICT(date) DO UPDATE SET window_end_minutes = 1140, done_for_day = 0
    `).run(SIM_DATE);

    // Call GET /api/plan/generate THREE times
    let genRes;
    for (let i = 1; i <= 3; i++) {
      genRes = await request(server, 'GET', `/api/plan/generate?now=${encodeURIComponent(SIM_NOW)}`);
      console.log(`\nRun #${i} GET /api/plan/generate -> count=${genRes.body.count}, plan_note=${JSON.stringify(genRes.body.plan_note)}`);
    }
    console.log('\nFull response from 3rd GET /api/plan/generate:');
    console.log(JSON.stringify(genRes.body, null, 2));

    const goalTaskCounts = db.prepare(`
      SELECT goal_id, date, COUNT(*) as row_count, GROUP_CONCAT(id) as task_ids, GROUP_CONCAT(name) as names
      FROM tasks
      WHERE goal_id IS NOT NULL AND date = ?
      GROUP BY goal_id, date
      ORDER BY goal_id ASC
    `).all(SIM_DATE);
    console.log('\nDB task row counts per goal after 3 generate calls:');
    console.log(JSON.stringify(goalTaskCounts, null, 2));
    check(goalTaskCounts.length > 0 && goalTaskCounts.every(r => r.row_count === 1),
      'Every scheduled goal has EXACTLY 1 task row for today after 3 generate calls');

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('4. CHECK & UNCHECK GOAL TASKS + REPEATED TOGGLE GUARD');
    console.log('══════════════════════════════════════════════════════════════════════');
    const lcPlanItem = genRes.body.plan.find(b => b.goal_id === 7);
    const treePlanItem = genRes.body.plan.find(b => b.goal_id === 4);
    const pgPlanItem = genRes.body.plan.find(b => b.goal_id === 2);
    const runPlanItem = genRes.body.plan.find(b => b.goal_id === 6);

    // A) Count goal (LeetCode 320, goal_id=7)
    console.log(`\n--- (A) Count goal task id=${lcPlanItem.task_id} ("${lcPlanItem.task}") ---`);
    const lcCheck1 = await request(server, 'PATCH', `/api/tasks/${lcPlanItem.task_id}/complete`, { completed: 1, now: SIM_NOW });
    console.log('Check #1 (0->1):', JSON.stringify({ progress_action: lcCheck1.body.progress_action, current_count: lcCheck1.body.goal.current_count, progress: lcCheck1.body.goal.progress }));
    check(lcCheck1.body.goal.current_count === 1, 'Count goal incremented from 0 to 1');

    const lcCheck2 = await request(server, 'PATCH', `/api/tasks/${lcPlanItem.task_id}/complete`, { completed: 1, now: SIM_NOW });
    console.log('Check #2 (1->1 repeat):', JSON.stringify({ unchanged: lcCheck2.body.unchanged, current_count: lcCheck2.body.goal.current_count }));
    check(lcCheck2.body.unchanged === true && lcCheck2.body.goal.current_count === 1, 'Repeated completed:1 is a no-op (cannot double count)');

    const lcUncheck1 = await request(server, 'PATCH', `/api/tasks/${lcPlanItem.task_id}/complete`, { completed: 0, now: SIM_NOW });
    console.log('Uncheck #1 (1->0):', JSON.stringify({ progress_action: lcUncheck1.body.progress_action, current_count: lcUncheck1.body.goal.current_count, progress: lcUncheck1.body.goal.progress }));
    check(lcUncheck1.body.goal.current_count === 0, 'Unchecking reverses count from 1 back to 0');

    const lcUncheck2 = await request(server, 'PATCH', `/api/tasks/${lcPlanItem.task_id}/complete`, { completed: 0, now: SIM_NOW });
    console.log('Uncheck #2 (0->0 repeat):', JSON.stringify({ unchanged: lcUncheck2.body.unchanged, current_count: lcUncheck2.body.goal.current_count }));
    check(lcUncheck2.body.unchanged === true && lcUncheck2.body.goal.current_count === 0, 'Repeated completed:0 is a no-op');

    // B) Milestone goal with steps (Trees topic, goal_id=4)
    console.log(`\n--- (B) Milestone goal with steps task id=${treePlanItem.task_id} ("${treePlanItem.task}") ---`);
    const trCheck = await request(server, 'PATCH', `/api/tasks/${treePlanItem.task_id}/complete`, { completed: 1, now: SIM_NOW });
    console.log('Check (0->1):', JSON.stringify({ progress_action: trCheck.body.progress_action, progress: trCheck.body.goal.progress, steps: trCheck.body.goal.steps }));
    check(trCheck.body.goal.progress === 33 && trCheck.body.goal.steps[0].done === 1, 'Milestone step 1 (BFS) ticked -> progress 33%');

    const trUncheck = await request(server, 'PATCH', `/api/tasks/${treePlanItem.task_id}/complete`, { completed: 0, now: SIM_NOW });
    console.log('Uncheck (1->0):', JSON.stringify({ progress_action: trUncheck.body.progress_action, progress: trUncheck.body.goal.progress, steps: trUncheck.body.goal.steps }));
    check(trUncheck.body.goal.progress === 0 && trUncheck.body.goal.steps[0].done === 0, 'Uncheck unticks BFS -> progress reverts to 0%');

    // C) Step-less milestone goal (PostgreSQL + Spring Boot, goal_id=2)
    console.log(`\n--- (C) Step-less milestone goal task id=${pgPlanItem.task_id} ("${pgPlanItem.task}") ---`);
    const pgCheck = await request(server, 'PATCH', `/api/tasks/${pgPlanItem.task_id}/complete`, { completed: 1, now: SIM_NOW });
    console.log('Check (0->1):', JSON.stringify({ progress_action: pgCheck.body.progress_action, progress: pgCheck.body.goal.progress, dsa: pgCheck.body.goal.days_since_activity }));
    check(pgCheck.body.goal.progress === 0 && pgCheck.body.goal.days_since_activity === 0, 'Step-less logs worked: progress stays 0%, dsa becomes 0');

    const pgUncheck = await request(server, 'PATCH', `/api/tasks/${pgPlanItem.task_id}/complete`, { completed: 0, now: SIM_NOW });
    console.log('Uncheck (1->0):', JSON.stringify({ progress_action: pgUncheck.body.progress_action, progress: pgUncheck.body.goal.progress, dsa: pgUncheck.body.goal.days_since_activity }));
    check(pgUncheck.body.goal.progress === 0 && pgUncheck.body.goal.days_since_activity === 6, 'Step-less uncheck deletes worked log -> dsa reverts to 6');

    // D) Frequency goal (Daily run, goal_id=6)
    console.log(`\n--- (D) Frequency goal task id=${runPlanItem.task_id} ("${runPlanItem.task}") ---`);
    const runCheck = await request(server, 'PATCH', `/api/tasks/${runPlanItem.task_id}/complete`, { completed: 1, now: SIM_NOW });
    console.log('Check (0->1):', JSON.stringify({ progress_action: runCheck.body.progress_action, days_this_week: runCheck.body.goal.days_this_week, progress: runCheck.body.goal.progress }));
    check(runCheck.body.goal.days_this_week === 2 && runCheck.body.goal.progress === 40, 'Frequency goal days_this_week 1 -> 2 (40%)');

    const runUncheck = await request(server, 'PATCH', `/api/tasks/${runPlanItem.task_id}/complete`, { completed: 0, now: SIM_NOW });
    console.log('Uncheck (1->0):', JSON.stringify({ progress_action: runUncheck.body.progress_action, days_this_week: runUncheck.body.goal.days_this_week, progress: runUncheck.body.goal.progress }));
    check(runUncheck.body.goal.days_this_week === 1 && runUncheck.body.goal.progress === 20, 'Frequency goal uncheck reverts days_this_week to 1 (20%)');

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('5. REPLAN WITH "Surprise viva with Professor Rathod at 3:30 PM"');
    console.log('══════════════════════════════════════════════════════════════════════');
    // Extend window to 6:00 PM (1080) so we see work around the 2-4 PM lab and 3:30-4:30 PM viva
    db.prepare(`UPDATE daily_settings SET window_end_minutes = 1080 WHERE date = ?`).run(SIM_DATE);
    const replanRes = await request(server, 'POST', '/api/plan/replan', {
      surpriseEvent: 'Surprise viva with Professor Rathod at 3:30 PM',
      now: '2026-10-27T13:00:00'
    });
    console.log('POST /api/plan/replan response:');
    console.log(JSON.stringify(replanRes.body, null, 2));
    const vivaSlot = replanRes.body.plan.find(b => b.source === 'surprise_event');
    check(!!vivaSlot && vivaSlot.time === '3:30 PM', 'Surprise viva slot present at 3:30 PM with source="surprise_event"');
    assertNoOverlaps(replanRes.body.plan);
    console.log('  ✔ assertNoOverlaps(replanRes.body.plan) passed — no flexible block overlaps anything');

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('6. CONFIG FLAG: PLANNER_ENGINE=scheduler vs PLANNER_ENGINE=ai');
    console.log('══════════════════════════════════════════════════════════════════════');
    const schedEngineRes = await request(server, 'GET', `/api/plan/generate?now=${encodeURIComponent(SIM_NOW)}&engine=scheduler`);
    console.log('PLANNER_ENGINE=scheduler:', JSON.stringify({
      success: schedEngineRes.body.success,
      engine: schedEngineRes.body.engine,
      count: schedEngineRes.body.count,
      plan_note: schedEngineRes.body.plan_note
    }, null, 2));
    check(schedEngineRes.body.engine === 'scheduler', 'PLANNER_ENGINE=scheduler uses deterministic scheduler');

    const aiEngineRes = await request(server, 'GET', `/api/plan/generate?now=${encodeURIComponent(SIM_NOW)}&engine=ai`);
    console.log('PLANNER_ENGINE=ai:', JSON.stringify({
      success: aiEngineRes.body.success,
      engine: aiEngineRes.body.engine,
      count: aiEngineRes.body.count,
      plan_note: aiEngineRes.body.plan_note,
      sample_items: aiEngineRes.body.plan.slice(0, 3)
    }, null, 2));
    check(aiEngineRes.body.engine === 'ai', 'PLANNER_ENGINE=ai reaches legacy AI planner');

    // Restore daily_settings and re-run scheduler generate so day_plans has clean scheduler plan
    db.prepare('DELETE FROM daily_settings').run();
    for (const row of savedSettings) {
      db.prepare('INSERT INTO daily_settings (date, window_end_minutes, available_minutes, done_for_day) VALUES (?, ?, ?, ?)')
        .run(row.date, row.window_end_minutes, row.available_minutes, row.done_for_day);
    }

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('ALL STEP 5 LIVE TESTS PASSED');
    console.log('══════════════════════════════════════════════════════════════════════');
  } finally {
    // in-process express app complete
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
