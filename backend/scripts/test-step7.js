/**
 * backend/scripts/test-step7.js
 *
 * Verifies Step 7 requirements:
 *  - GET /api/goals/reminders (deterministic, no AI):
 *    - progress_source === 'no_progress_data' skips behind-pace rules and gets an 'info' reminder:
 *      "No steps defined. Say 'steps for <goal>: a; b; c' or set progress manually."
 *    - deadline within 3 days with progress < 100, or is_overdue → 'urgent'
 *    - high and behind_by >= 10 → 'urgent'
 *    - medium and behind_by >= 20 → 'warning'
 *    - days_since_activity >= neglect_days → 'warning' ("No progress in N days")
 *    - low and behind_by >= 30 → 'info'
 *    - Sorted urgent → warning → info, then high → medium → low, max 6.
 *  - Shows raw output of GET /api/goals/reminders and Night Summary's behind_pace_goals.
 */

const assert = require('assert');
const express = require('express');
const goalsRouter = require('../routes/goals');
const summaryRouter = require('../routes/summary');
const { getGoalReminders } = require('../services/goalsService');
const { getBehindPaceGoals } = require('../services/summaryService');

const app = express();
app.use(express.json());
app.use('/api/goals', goalsRouter);
app.use('/api/summary', summaryRouter);

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
  console.log('STEP 7 VERIFICATION SUITE');
  console.log('================================================================\n');

  // 1. Call GET /api/goals/reminders via Express route
  const remRes = await callApp('GET', '/api/goals/reminders');
  console.log('--- [1] Raw Output of GET /api/goals/reminders ---');
  console.log(JSON.stringify(remRes.body, null, 2));

  assert(remRes.status === 200 && remRes.body.success === true, 'GET /api/goals/reminders must return 200 success');
  const reminders = remRes.body.reminders;
  assert(Array.isArray(reminders) && reminders.length <= 6, 'Reminders must be an array with max 6 items');

  // Verify sorting: urgent -> warning -> info, then high -> medium -> low
  const levelRank = { urgent: 1, warning: 2, info: 3 };
  const prioRank = { high: 1, medium: 2, low: 3 };
  for (let i = 1; i < reminders.length; i++) {
    const prev = reminders[i - 1];
    const curr = reminders[i];
    const lDiff = levelRank[prev.level] - levelRank[curr.level];
    assert(lDiff <= 0, `Sorting violated between ${prev.title} (${prev.level}) and ${curr.title} (${curr.level})`);
    if (lDiff === 0) {
      const pDiff = prioRank[prev.priority] - prioRank[curr.priority];
      assert(pDiff <= 0, `Priority sorting violated between ${prev.title} (${prev.priority}) and ${curr.title} (${curr.priority})`);
    }
  }

  // Verify no_progress_data goals include the "No steps defined..." reminder and skip behind-pace rules
  const shellRem = reminders.find(r => r.title === 'Shell Scripting Lab');
  assert(shellRem, 'Shell Scripting Lab should appear in reminders');
  assert(
    shellRem.reason.includes("No steps defined. Say 'steps for Shell Scripting Lab: a; b; c' or set progress manually."),
    'no_progress_data goal must include the No steps defined info message'
  );
  assert(!shellRem.reason.includes('Behind pace'), 'no_progress_data goal must skip behind-pace rules');

  // Also test on injected date 2026-10-27 where Shell Scripting Lab has days_left = 4 (>3) and days_since_activity = 1 (<3)
  // so its level is strictly 'info'
  const remOct27 = getGoalReminders(new Date(2026, 9, 27, 12, 0, 0));
  const shellOct27 = remOct27.find(r => r.title === 'Shell Scripting Lab');
  console.log('\n--- [2] Shell Scripting Lab Reminder on 2026-10-27 (days_left=4, no_progress_data) ---');
  console.log(JSON.stringify(shellOct27, null, 2));
  assert(shellOct27 && shellOct27.level === 'info', 'On 2026-10-27 Shell Scripting Lab should be level=info');

  // Verify PostgreSQL + Spring Boot includes "No progress in N days"
  const pgRem = reminders.find(r => r.title === 'PostgreSQL + Spring Boot');
  assert(pgRem && /No progress in \d+ days/.test(pgRem.reason), 'Neglected goal must include "No progress in N days"');

  // 2. Show raw output of Night Summary's behind_pace_goals
  const behindPace = getBehindPaceGoals(new Date(2026, 9, 27, 21, 0, 0));
  console.log('\n--- [3] Raw Output of Night Summary behind_pace_goals ---');
  console.log(JSON.stringify(behindPace, null, 2));
  assert(Array.isArray(behindPace) && behindPace.length > 0, 'behind_pace_goals must be non-empty');

  console.log('\n================================================================');
  console.log('ALL STEP 7 CHECKS PASSED SUCCESSFULLY');
  console.log('================================================================');
}

main().catch(err => {
  console.error('❌ STEP 7 TEST FAILED:', err);
  process.exit(1);
});
