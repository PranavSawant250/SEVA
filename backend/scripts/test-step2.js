/**
 * Step 2 test script — Progress tracking for all three goal types
 * Run: node scripts/test-step2.js
 *
 * Tests:
 * - Log 3 LeetCode problems (count goal)
 * - Log Daily run on 2 different days (frequency, one-per-day rule)
 * - Try to log Daily run twice on same day (cap test)
 * - Tick a Spring Boot step (milestone step)
 * - GET /api/goals — show computed progress for all goals
 * - Cap test: log enough to hit 40/40
 */
const http = require('http');
const db = require('../database/db');

const BASE = 'http://localhost:3001';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3001, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function patch(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3001, path,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('=== STEP 2 TESTS ===\n');
  await new Promise(r => setTimeout(r, 300));

  // Find goal IDs directly from DB
  const leetcode = db.prepare("SELECT id FROM goals WHERE title = 'LeetCode 320'").get();
  const dailyRun = db.prepare("SELECT id FROM goals WHERE title = 'Daily run'").get();
  const springBoot = db.prepare("SELECT id FROM goals WHERE title = 'Spring Boot Basics'").get();
  const jpaGoal = db.prepare("SELECT id FROM goals WHERE title = 'PostgreSQL + Spring Boot'").get();

  console.log(`IDs: LeetCode=${leetcode.id}, DailyRun=${dailyRun.id}, SpringBoot=${springBoot.id}, JPA=${jpaGoal.id}`);

  // TEST 2-1: Log 3 LeetCode problems (count goal, amount=3)
  console.log('\n--- TEST 2-1: Log 3 LeetCode problems ---');
  const t21 = await post(`/api/goals/${leetcode.id}/log`, { amount: 3, note: 'easy-medium mix' });
  console.log(`Status: ${t21.status} — ${JSON.stringify(t21.body)}`);

  // TEST 2-2: Log Daily run today (frequency — first log)
  console.log('\n--- TEST 2-2: Log Daily run today (should count) ---');
  const t22 = await post(`/api/goals/${dailyRun.id}/log`, {});
  console.log(`Status: ${t22.status} — ${JSON.stringify(t22.body)}`);

  // TEST 2-3: Log Daily run again TODAY (one-per-day rule — should NOT count again)
  console.log('\n--- TEST 2-3: Log Daily run again today (one-per-day — should NOT count) ---');
  const t23 = await post(`/api/goals/${dailyRun.id}/log`, {});
  console.log(`Status: ${t23.status} — ${JSON.stringify(t23.body)}`);

  // TEST 2-4: Simulate a second day by inserting a log directly for yesterday
  console.log('\n--- TEST 2-4: Simulate run on a second day (direct DB insert for yesterday) ---');
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yd = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
  db.prepare('INSERT INTO goal_progress_log (goal_id, date, amount, note) VALUES (?, ?, 1, ?)').run(dailyRun.id, yd, 'test-yesterday');
  console.log(`  Inserted log for ${yd} directly into DB.`);

  // TEST 2-5: Tick first Spring Boot step (Steps[0] = id 1 = "Controllers")
  const step1 = db.prepare("SELECT id FROM goal_steps WHERE goal_id = ? AND step_text = 'Controllers'").get(springBoot.id);
  console.log(`\n--- TEST 2-5: Tick step "${step1 ? 'Controllers' : '?'}" (id=${step1?.id}) ---`);
  const t25 = await patch(`/api/goals/${springBoot.id}/steps/${step1.id}`, { done: 1 });
  console.log(`Status: ${t25.status} — ${JSON.stringify(t25.body)}`);

  // TEST 2-6: PATCH manual_progress on JPA goal
  console.log('\n--- TEST 2-6: Set manual_progress=50 on PostgreSQL + Spring Boot ---');
  const t26 = await patch(`/api/goals/${jpaGoal.id}`, { manual_progress: 50 });
  console.log(`Status: ${t26.status} — ${JSON.stringify(t26.body)}`);

  // TEST 2-7: Clear manual_progress (explicit null)
  console.log('\n--- TEST 2-7: Clear manual_progress (explicit null) ---');
  const t27 = await patch(`/api/goals/${jpaGoal.id}`, { manual_progress: null });
  console.log(`Status: ${t27.status} — ${JSON.stringify(t27.body)}`);

  // TEST 2-8: Cap test — add 40 more to LeetCode (should cap at 40 total)
  console.log('\n--- TEST 2-8: Cap test — log 40 more on LeetCode (should cap at 40, auto-complete) ---');
  const t28 = await post(`/api/goals/${leetcode.id}/log`, { amount: 40 });
  console.log(`Status: ${t28.status} — ${JSON.stringify(t28.body)}`);
  const lcAfter = db.prepare('SELECT current_count, status FROM goals WHERE id = ?').get(leetcode.id);
  console.log(`  DB after cap: current_count=${lcAfter.current_count} status=${lcAfter.status}`);

  // TEST 2-9: Try to log on completed goal (should reject)
  console.log('\n--- TEST 2-9: Log on completed goal (should reject) ---');
  const t29 = await post(`/api/goals/${leetcode.id}/log`, { amount: 1 });
  console.log(`Status: ${t29.status} — ${JSON.stringify(t29.body)}`);

  // TEST 2-10: GET /api/goals — show computed progress with math
  console.log('\n--- TEST 2-10: GET /api/goals — computed progress ---');
  const t210 = await get('/api/goals');
  const goals = t210.body.goals || [];
  goals.forEach(g => {
    let extra = '';
    if (g.goal_type === 'count') extra = ` (${g.current_count}/${g.target_count})`;
    if (g.goal_type === 'frequency') extra = ` (${g.days_this_week}/${g.per_week} this week)`;
    if (g.steps && g.steps.length > 0) extra = ` (${g.steps.filter(s=>s.done).length}/${g.steps.length} steps done)`;
    console.log(`  [${g.id}] "${g.title}" type=${g.goal_type} progress=${g.progress}% source=${g.progress_source} behind=${g.behind_by}% overdue=${g.is_overdue} days_left=${g.days_left} days_since_activity=${g.days_since_activity}${extra}`);
  });

  console.log('\n=== STEP 2 TESTS COMPLETE ===');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
