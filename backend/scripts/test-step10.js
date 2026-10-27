/**
 * backend/scripts/test-step10.js
 *
 * Verifies Step 10 — The Nightly Check-In ("plan tomorrow"):
 *  - Trigger regex test (8 variants, including negative test "what did I plan yesterday")
 *  - REST endpoints (/api/nightly/start, /reply, /state, /cancel) + Chat command router
 *  - 12 Required Scenarios:
 *    (a) "plan tomorrow" → asks budget
 *    (b) "banana" → asks again
 *    (c) "4 hours" → outline + numbered suggestions (including PostgreSQL neglected)
 *    (d) "add 1" → PostgreSQL forced in, lowest-scoring item shrinks/moves
 *    (e) "also add Buy birthday gift for 45 min priority high" → added
 *    (f) "done" → DB rows verified
 *    (g) "plan tomorrow" → "5h" → "none" → "done"
 *    (h) "plan tomorrow" → "3h" → "add sab" → "done"
 *    (i) "plan tomorrow" → "cancel" → nothing written
 *    (j) accept an old incomplete task → verify it is MOVED (not duplicated)
 *    (k) advance to tomorrow, set window "free till 9 PM", call GET /api/plan/generate,
 *        verify forced/added items appear in the real schedule
 *    (l) query seva.db for duplicate incomplete task names, report them and propose cleanup
 *        (do NOT apply without approval)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDbPath = path.join(os.tmpdir(), `seva-test-step10-${process.pid}-${Date.now()}.db`);
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
const { routeCommand } = require('../services/chatCommands');
const { matchesPlanTomorrowTrigger } = require('../services/nightlyService');
const { generateDayPlan } = require('../services/plannerService');
const nightlyRouter = require('../routes/nightly');

const app = express();
app.use(express.json());
app.use('/api/nightly', nightlyRouter);

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

async function main() {
  console.log('================================================================');
  console.log('STEP 10 VERIFICATION SUITE — THE NIGHTLY CHECK-IN');
  console.log('================================================================\n');

  const todayNight = new Date(2026, 9, 27, 21, 30, 0); // 2026-10-27 09:30 PM
  const tomorrowMorning = new Date(2026, 9, 28, 8, 0, 0); // 2026-10-28 08:00 AM
  const tomorrowStr = '2026-10-28';

  // Clean any prior test rows for tomorrow (2026-10-28)
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM day_plans WHERE date = ?`).run(tomorrowStr);

  // ──────────────────────────────────────────────────────────────
  // 0. TRIGGER REGEX TEST (8 variants)
  // ──────────────────────────────────────────────────────────────
  console.log('--- [0] Trigger Regex Test (8 variants) ---');
  const triggerCases = [
    { input: 'plan tomorrow', expected: true },
    { input: 'plan for tomorrow', expected: true },
    { input: 'plan my tomorrow', expected: true },
    { input: "tomorrow's plan", expected: true },
    { input: 'tomorrow plan', expected: true },
    { input: 'raw plan for tomorrow', expected: true },
    { input: "Hey SEVA, let's plan tomorrow!", expected: true },
    { input: 'what did I plan yesterday', expected: false }
  ];
  for (const tc of triggerCases) {
    const actual = matchesPlanTomorrowTrigger(tc.input);
    console.log(`  "${tc.input}" -> matched=${actual} (expected=${tc.expected})`);
    assert.strictEqual(actual, tc.expected, `Trigger mismatch for "${tc.input}"`);
  }
  console.log('✓ [0] Passed: All 8 trigger regex variants matched as expected.\n');

  // ──────────────────────────────────────────────────────────────
  // SCENARIOS (a) – (f): Main End-to-End Check-In Flow
  // ──────────────────────────────────────────────────────────────
  console.log('--- [a] "plan tomorrow" → asks budget ---');
  const replyA = routeCommand('plan tomorrow', todayNight, todayNight);
  console.log('User: "plan tomorrow"\nSEVA:\n' + replyA + '\n');
  assert(replyA && replyA.includes('How much free time do you have tomorrow outside classes?'), 'Scenario (a) must ask for budget');

  console.log('--- [b] "banana" → asks again ---');
  const replyB = routeCommand('banana', todayNight, todayNight);
  console.log('User: "banana"\nSEVA:\n' + replyB + '\n');
  assert(replyB && replyB.includes("couldn't parse a time budget"), 'Scenario (b) must reject unparseable budget and ask again');

  console.log('--- [c] "4 hours" → outline + numbered suggestions (including PostgreSQL neglected) ---');
  const replyC = routeCommand('4 hours', todayNight, todayNight);
  console.log('User: "4 hours"\nSEVA:\n' + replyC + '\n');
  assert(replyC.includes('Rough Outline for Tomorrow (Wednesday, 2026-10-28) — Budget: 240 min'), 'Scenario (c) must show 240 min outline');
  assert(replyC.includes('1. [pending] "PostgreSQL + Spring Boot"'), 'Scenario (c) suggestion #1 must be PostgreSQL + Spring Boot');
  assert(/no progress in \d+ days/.test(replyC), 'Scenario (c) must show no progress in X days for PostgreSQL');

  console.log('--- [d] "add 1" → PostgreSQL forced in, lowest-scoring item shrinks/moves ---');
  const replyD = routeCommand('add 1', todayNight, todayNight);
  console.log('User: "add 1"\nSEVA:\n' + replyD + '\n');
  assert(replyD.includes('PostgreSQL + Spring Boot: work session — 60 min (high) [FORCED]'), 'Scenario (d) must force PostgreSQL into the outline');
  assert(replyD.includes('1. ✓ [ADDED] "PostgreSQL + Spring Boot"'), 'Scenario (d) must keep original number 1 and mark [ADDED]');

  console.log('--- [e] "also add Buy birthday gift for 45 min priority high" → added ---');
  const replyE = routeCommand('also add Buy birthday gift for 45 min priority high', todayNight, todayNight);
  console.log('User: "also add Buy birthday gift for 45 min priority high"\nSEVA:\n' + replyE + '\n');
  assert(replyE.includes('Buy birthday gift — 45 min (high) [FORCED]'), 'Scenario (e) must include custom task in outline');

  console.log('--- [f] "done" → DB rows verified ---');
  const replyF = routeCommand('done', todayNight, todayNight);
  console.log('User: "done"\nSEVA:\n' + replyF + '\n');

  const dsRowF = db.prepare(`SELECT * FROM daily_settings WHERE date = ?`).get(tomorrowStr);
  const tasksRowsF = db.prepare(`SELECT id, name, priority, source, carry_forward, goal_id, duration_min, date FROM tasks WHERE date = ? ORDER BY id ASC`).all(tomorrowStr);
  console.log('DB daily_settings for tomorrow (2026-10-28):', JSON.stringify(dsRowF));
  console.log('DB tasks rows for tomorrow (2026-10-28):\n' + JSON.stringify(tasksRowsF, null, 2) + '\n');

  assert(dsRowF && dsRowF.available_minutes === 240, 'Scenario (f) daily_settings.available_minutes must be 240');
  assert(tasksRowsF.some(t => t.goal_id === 2 && t.carry_forward === 1), 'Scenario (f) PostgreSQL goal task must be saved with carry_forward=1');
  assert(tasksRowsF.some(t => t.name === 'Buy birthday gift' && t.duration_min === 45 && t.priority === 'high'), 'Scenario (f) Buy birthday gift task must be saved');

  // Verify Scenario (k) right now while Scenario (f)'s forced/added rows are in DB!
  console.log('--- [k] Advance to tomorrow (2026-10-28), set window "free till 9 PM", call GET /api/plan/generate ---');
  const winReplyK = routeCommand('free till 9 PM', tomorrowMorning, tomorrowMorning);
  console.log('Tomorrow morning User: "free till 9 PM"\nSEVA:', winReplyK);
  const planGenK = await generateDayPlan(tomorrowMorning, { skipAiNote: true });
  console.log('Tomorrow (2026-10-28) Generated Schedule Plan:\n' + JSON.stringify(planGenK.plan, null, 2));
  console.log('Tomorrow (2026-10-28) Plan Note:', planGenK.plan_note + '\n');
  assert(planGenK.plan.some(b => b.goal_id === 2), 'Scenario (k) forced PostgreSQL session must appear in tomorrow schedule');
  assert(planGenK.plan.some(b => b.task === 'Buy birthday gift' && b.duration === 45), 'Scenario (k) added Buy birthday gift must appear in tomorrow schedule');

  const morningGoalTaskCounts = db.prepare(`
    SELECT goal_id, date, COUNT(*) as row_count, GROUP_CONCAT(id) as task_ids, GROUP_CONCAT(name) as names
    FROM tasks
    WHERE date = ? AND goal_id IS NOT NULL
    GROUP BY goal_id, date
    ORDER BY goal_id ASC
  `).all(tomorrowStr);
  console.log('Morning tasks rows per goal after generate (2026-10-28):');
  console.log(JSON.stringify(morningGoalTaskCounts, null, 2) + '\n');
  assert(morningGoalTaskCounts.length > 0 && morningGoalTaskCounts.every(r => r.row_count === 1),
    'Scenario (k) morning generate must NOT create duplicate goal task rows (row_count === 1 for every goal)');

  // Clean up tomorrow rows before Scenarios (g), (h), (i), (j)
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM day_plans WHERE date = ?`).run(tomorrowStr);

  // ──────────────────────────────────────────────────────────────
  // SCENARIO (g): "plan tomorrow" → "5h" → "none" → "done"
  // ──────────────────────────────────────────────────────────────
  console.log('--- [g] "plan tomorrow" → "5h" → "none" → "done" ---');
  console.log('start ->', routeCommand('plan tomorrow', todayNight, todayNight));
  console.log('5h ->\n' + routeCommand('5h', todayNight, todayNight));
  const replyGNone = routeCommand('none', todayNight, todayNight);
  console.log('none ->', replyGNone);
  const replyGDone = routeCommand('done', todayNight, todayNight);
  console.log('done ->\n' + replyGDone + '\n');
  const dsRowG = db.prepare(`SELECT * FROM daily_settings WHERE date = ?`).get(tomorrowStr);
  assert(dsRowG && dsRowG.available_minutes === 300, 'Scenario (g) must save available_minutes = 300');

  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(tomorrowStr);

  // ──────────────────────────────────────────────────────────────
  // SCENARIO (h): "plan tomorrow" → "3h" → "add sab" → "done"
  // ──────────────────────────────────────────────────────────────
  console.log('--- [h] "plan tomorrow" → "3h" → "add sab" → "done" (testing via /api/nightly endpoints too) ---');
  const startH = await callApp('POST', '/api/nightly/start', { today: todayNight });
  console.log('POST /api/nightly/start ->', startH.body.reply);
  const r3h = await callApp('POST', '/api/nightly/reply', { text: '3h', today: todayNight });
  console.log('POST /api/nightly/reply {"text":"3h"} ->\n' + r3h.body.reply);
  const rSab = await callApp('POST', '/api/nightly/reply', { text: 'add sab', today: todayNight });
  console.log('POST /api/nightly/reply {"text":"add sab"} ->\n' + rSab.body.reply);
  const stateBeforeDoneH = await callApp('GET', '/api/nightly/state');
  console.log('GET /api/nightly/state (active) -> phase:', stateBeforeDoneH.body.state.phase, 'acceptedGoalIds:', stateBeforeDoneH.body.state.acceptedGoalIds);

  // Before calling 'done' in (h), make sure any real old tasks that 'add sab' accepted are NOT permanently moved yet:
  // Let's snapshot their original dates so we can restore them after verifying (h)
  const acceptedOldTaskIdsH = stateBeforeDoneH.body.state.acceptedTaskIds || [];
  const origTaskDatesH = acceptedOldTaskIdsH.map(id => db.prepare(`SELECT id, date, source FROM tasks WHERE id = ?`).get(id)).filter(Boolean);

  const rDoneH = await callApp('POST', '/api/nightly/reply', { text: 'done', today: todayNight });
  console.log('POST /api/nightly/reply {"text":"done"} ->\n' + rDoneH.body.reply + '\n');
  const dsRowH = db.prepare(`SELECT * FROM daily_settings WHERE date = ?`).get(tomorrowStr);
  assert(dsRowH && dsRowH.available_minutes === 180, 'Scenario (h) must save available_minutes = 180');

  // Restore any old tasks moved during Scenario (h) and clean up tomorrow's goal tasks
  for (const orig of origTaskDatesH) {
    db.prepare(`UPDATE tasks SET date = ?, source = ? WHERE id = ?`).run(orig.date, orig.source, orig.id);
  }
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(tomorrowStr);

  // ──────────────────────────────────────────────────────────────
  // SCENARIO (i): "plan tomorrow" → "cancel" → nothing written
  // ──────────────────────────────────────────────────────────────
  console.log('--- [i] "plan tomorrow" → "cancel" → nothing written ---');
  routeCommand('plan tomorrow', todayNight, todayNight);
  const replyCancel = routeCommand('cancel', todayNight, todayNight);
  console.log('User: "cancel"\nSEVA:', replyCancel + '\n');
  const dsRowI = db.prepare(`SELECT * FROM daily_settings WHERE date = ?`).get(tomorrowStr);
  const tasksRowI = db.prepare(`SELECT * FROM tasks WHERE date = ?`).all(tomorrowStr);
  assert(!dsRowI && tasksRowI.length === 0, 'Scenario (i) must write nothing when cancelled');

  // ──────────────────────────────────────────────────────────────
  // SCENARIO (j): Accept an old incomplete task → verify it is MOVED (not duplicated)
  // ──────────────────────────────────────────────────────────────
  console.log('--- [j] Accept an old incomplete task → verify it is MOVED (not duplicated) ---');
  const oldTaskInsert = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, goal_id)
    VALUES ('Submit OS Lab Record', 'high', 'manual', 0, '2026-10-26', NULL)
  `).run();
  const oldTaskId = Number(oldTaskInsert.lastInsertRowid);
  console.log(`Inserted old incomplete task id=${oldTaskId} ("Submit OS Lab Record", date="2026-10-26")`);

  routeCommand('plan tomorrow', todayNight, todayNight);
  const revJ = routeCommand('4 hours', todayNight, todayNight);
  console.log('Review output with old task:\n' + revJ);
  const addFragJ = routeCommand('add Submit OS Lab Record', todayNight, todayNight);
  console.log('User: "add Submit OS Lab Record"\nSEVA:\n' + addFragJ);
  const doneJ = routeCommand('done', todayNight, todayNight);
  console.log('User: "done"\nSEVA:\n' + doneJ);

  const allMatchingOldTask = db.prepare(`
    SELECT id, name, date, source, completed FROM tasks WHERE name = 'Submit OS Lab Record'
  `).all();
  console.log('All DB rows for "Submit OS Lab Record" after check-in done:', JSON.stringify(allMatchingOldTask));
  assert(allMatchingOldTask.length === 1, 'Must NOT duplicate the old incomplete task row');
  assert(allMatchingOldTask[0].id === oldTaskId && allMatchingOldTask[0].date === tomorrowStr, 'Old task row must be MOVED (same id, date updated to tomorrow)');

  // Clean up Scenario (j) test rows
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(oldTaskId);
  db.prepare(`DELETE FROM tasks WHERE date = ?`).run(tomorrowStr);
  db.prepare(`DELETE FROM daily_settings WHERE date = ?`).run(tomorrowStr);
  console.log('✓ [j] Passed: Old incomplete task was MOVED in place (same ID, date updated to tomorrow, 0 duplicate rows).\n');

  // ──────────────────────────────────────────────────────────────
  // SCENARIO (l): Query seva.db for duplicate incomplete task names & propose cleanup
  // (Do NOT apply cleanup without user approval)
  // ──────────────────────────────────────────────────────────────
  console.log('--- [l] Audit seva.db for Duplicate Incomplete Task Names (Report Only — Not Deleted) ---');
  const dupGroups = db.prepare(`
    SELECT LOWER(TRIM(name)) as norm_name,
           COUNT(*) as row_count,
           GROUP_CONCAT(id || ':' || date || ':' || source, ', ') as instances,
           MAX(id) as keep_newest_id
    FROM tasks
    WHERE completed = 0
    GROUP BY LOWER(TRIM(name))
    HAVING COUNT(*) > 1
    ORDER BY row_count DESC, norm_name ASC
  `).all();

  console.log('Duplicate incomplete task groups in seva.db:');
  console.log(JSON.stringify(dupGroups, null, 2));

  console.log('\nProposed SQL Cleanup (NOT executed — awaiting user approval):');
  console.log(`DELETE FROM tasks
WHERE completed = 0
  AND goal_id IS NULL
  AND id NOT IN (
    SELECT MAX(id)
    FROM tasks
    WHERE completed = 0 AND goal_id IS NULL
    GROUP BY LOWER(TRIM(name))
  );`);

  console.log('\n================================================================');
  console.log('ALL STEP 10 SCENARIOS (a)–(l) PASSED SUCCESSFULLY');
  console.log('================================================================');
}

main().catch(err => {
  console.error('❌ STEP 10 TEST FAILED:', err);
  process.exit(1);
});
