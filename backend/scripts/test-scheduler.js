/**
 * scripts/test-scheduler.js
 *
 * Step 4 scheduler test suite — scenarios (a) … (n) plus (b2) overlaps.
 * Every scenario has hard assertions via check(); any failure exits 1.
 *
 * Exit code:
 *   0  every assertion passed
 *   1  any assertion failed
 *
 * Usage:  node scripts/test-scheduler.js
 *         node scripts/test-scheduler.js --demo-failure   (feeds an overlapping
 *         plan into the SAME assertion path to prove a failure exits 1)
 *
 * The scheduler never reads the clock: `today` and `nowMinutes` are injected
 * here. (This test file may use Date to step simulated days; the service may not.)
 */

const {
  allocateFlexibleWork,
  buildDaySchedule,
  buildDayOutline,
  scheduleRefusal,
  assertNoOverlaps,
  enforceNoFlexibleOverlaps,
  MAX_GOAL_SHARE,
  MAX_BLOCK_MINS,
  FLOOR_MINS,
  MAX_FLOOR_PER_DAY,
  DEFAULT_NEGLECT_DAYS
} = require('../services/schedulerService');

const { minutesToTimeString, parseTimeToMinutes, getTomorrowDate, daysBetween } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// SHARED DATA
// ─────────────────────────────────────────────────────────────
const TODAY  = '2026-10-26';
const BUFFER = 15;

const SIX_GOALS = [
  { id:1, title:'Spring Boot Basics',       goal_type:'milestone', priority:'high',   status:'active',
    steps:[{id:101,done:false,step_text:'Controllers'},{id:102,done:false,step_text:'Services'},{id:103,done:false,step_text:'Repositories'}],
    is_overdue:true,  days_left:0, behind_by:100, days_since_activity:2, current_count:0, target_count:null },
  { id:2, title:'PostgreSQL + Spring Boot', goal_type:'milestone', priority:'high',   status:'active',
    steps:[], is_overdue:true, days_left:0, behind_by:100, days_since_activity:6, current_count:0, target_count:null },
  { id:3, title:'LeetCode 320',             goal_type:'count',     priority:'high',   status:'active',
    steps:[], is_overdue:false, days_left:5, behind_by:40, days_since_activity:0, current_count:3, target_count:40 },
  { id:4, title:'Trees topic',              goal_type:'milestone', priority:'medium', status:'active',
    steps:[{id:401,done:false,step_text:'BFS'},{id:402,done:false,step_text:'DFS'},{id:403,done:false,step_text:'traversals complete'}],
    is_overdue:true,  days_left:0, behind_by:80, days_since_activity:1, current_count:0, target_count:null },
  { id:5, title:'Shell Scripting Lab',      goal_type:'milestone', priority:'medium', status:'active',
    steps:[], is_overdue:false, days_left:5, behind_by:0, days_since_activity:0, current_count:0, target_count:null }
];
const HABIT_GOALS = [
  { id:6, title:'Daily run', days_this_week:1, per_week:5, last_logged_today:false }
];
const TWO_CLASSES = [
  { subject:'Software Engineering', start_time:'10:00 AM', end_time:'11:00 AM' },
  { subject:'Database Lab',         start_time:'2:00 PM',  end_time:'4:00 PM'  }
];

// ─────────────────────────────────────────────────────────────
// ASSERTION + PRINT HELPERS
// ─────────────────────────────────────────────────────────────
const HR = '─'.repeat(70);

/** Assertion helper: a failed check prints and exits 1 immediately. */
function check(cond, msg) {
  if (!cond) {
    console.error(`\n❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

function header(label) {
  console.log(`\n${HR}\nSCENARIO ${label}\n${HR}`);
}

const fmtAmt = (v, unit) => `${v}${unit === 'units' ? ' units' : 'min'}`;
const endOf  = b => b.startMinutes + b.duration;

function printLists(result) {
  if (result.deferred?.length) {
    console.log('\nDEFERRED:');
    result.deferred.forEach(d => console.log(`  ✗ ${d.item}: ${d.reason}`));
  }
  if (result.shrunk?.length) {
    console.log('\nSHRUNK:');
    result.shrunk.forEach(s => console.log(`  ⬇ ${s.item}: given=${fmtAmt(s.given, s.unit)} needed=${fmtAmt(s.needed, s.unit)} (${s.reason})`));
  }
  if (result.behind_pace?.length) {
    console.log('\nBEHIND PACE (never dropped silently):');
    result.behind_pace.forEach(b => console.log(`  ⏳ ${b.item}: needs ${b.needed_units}, given ${b.given_units} — ${b.reason}`));
  }
  if (result.duplicates?.length) {
    console.log('\nDUPLICATES:');
    result.duplicates.forEach(d => console.log(`  ⧉ ${d.item}: ${d.reason}`));
  }
  if (result.warnings?.length) {
    console.log('\nWARNINGS:');
    result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  }
}

function printSchedule(result) {
  console.log(`\ntoday (injected) = ${result.today}   now = ${minutesToTimeString(result.nowMinutes)}`);
  console.log('\nFREE GAPS:');
  result.gapSummary.forEach(g => console.log(`  ${g.start_time.padEnd(9)} → ${g.end_time.padEnd(9)} = ${g.size_min}min`));
  console.log(`  TOTAL BUDGET = ${result.budgetMinutes}min   (window end ${minutesToTimeString(result.windowEndMinutes)})`);

  console.log('\nPLAN (chronological):');
  if (!result.plan.length) console.log('  (empty)');
  let prevEnd = null;
  for (const b of result.plan) {
    if (prevEnd !== null && b.startMinutes > prevEnd) console.log(`  ${''.padEnd(9)}   [--- ${b.startMinutes - prevEnd}min free/buffer ---]`);
    const tags = [b.pinned ? 'pinned' : null, b.floor ? 'floor' : null, b.units ? `units=${b.units}` : null,
                  b.step_ids?.length ? `step_ids=[${b.step_ids}]` : null,
                  b.conflicts_with ? `conflicts_with=${JSON.stringify(b.conflicts_with)}` : null].filter(Boolean).join(' ');
    console.log(`  ${b.time.padEnd(9)}  [${b.source.padEnd(8)}] ${b.task}  (${b.priority})`);
    console.log(`  ${''.padEnd(9)}   → ends ${minutesToTimeString(endOf(b))} (${b.duration}min)${tags ? '  ' + tags : ''}`);
    prevEnd = Math.max(prevEnd ?? 0, endOf(b));
  }
  printLists(result);
  try {
    assertNoOverlaps(result.plan);
    console.log('\n✅ No flexible block overlaps anything');
  } catch (e) {
    console.error(`\n❌ ASSERTION FAILED: ${e.message}`);
    process.exit(1);
  }
}

function printScoreTable(result) {
  console.log(`\nSCORE TABLE   today = ${result.today}   budget = ${result.budgetMinutes}min   caps: MAX_GOAL_SHARE=${MAX_GOAL_SHARE}, MAX_BLOCK_MINS=${MAX_BLOCK_MINS}`);
  console.log('  goal                      | prio   | days_left | remaining | score  | aging | need | given | minutes');
  console.log('  ' + '─'.repeat(100));
  for (const r of result.scores) {
    console.log(
      `  ${r.title.padEnd(25)} | ${r.priority.padEnd(6)} | ${String(r.days_left).padStart(9)} | ${String(r.remaining).padStart(9)} | ` +
      `${r.score.toFixed(3).padStart(6)} | ${r.aging.toFixed(2).padStart(5)} | ${String(r.daily_need).padStart(4)} | ${String(r.units_given).padStart(5)} | ${String(r.minutes_given).padStart(7)}`
    );
  }
}

/** Starvation caps: ≤MAX_BLOCK_MINS per goal, one block per goal, ≤share when >1 eligible, shortfall visible. */
function checkCaps(result, label, blocks) {
  const eligible = result.scores.length;
  const shareLimit = MAX_GOAL_SHARE * result.budgetMinutes;
  for (const r of result.scores) {
    const mine = blocks.filter(b => b.source === 'goal' && b.goal_id === r.goal_id);
    check(mine.length <= 1, `${label} "${r.title}": at most one block today (has ${mine.length})`);
    check(r.minutes_given <= MAX_BLOCK_MINS, `${label} "${r.title}": ${r.minutes_given}min ≤ MAX_BLOCK_MINS ${MAX_BLOCK_MINS}`);
    if (eligible > 1) {
      check(r.minutes_given <= Math.max(shareLimit, r.unit_minutes),
        `${label} "${r.title}": ${r.minutes_given}min ≤ 50% share (${shareLimit}min) or 1 unit`);
    }
    if (r.units_given < r.daily_need) {
      check(result.behind_pace.some(b => b.goal_id === r.goal_id),
        `${label} "${r.title}" got ${r.units_given}/${r.daily_need} units → listed as behind pace`);
    }
  }
}

/** Item 8: inside each gap segment (split by fixed and pinned blocks) urgent/forced first, then high→medium→low. */
function checkSegmentOrder(result, label) {
  const RANK = { high: 0, medium: 1, low: 2 };
  const tier = b => (b.source === 'urgent' || b.source === 'forced') ? 0 : 1;
  let run = [];
  const flush = () => {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      const ok = tier(a) < tier(b) || (tier(a) === tier(b) && (RANK[a.priority] ?? 1) <= (RANK[b.priority] ?? 1));
      if (!ok) check(false, `${label} segment order: "${a.task}" (${a.source}/${a.priority}) before "${b.task}" (${b.source}/${b.priority})`);
    }
    run = [];
  };
  for (const b of result.plan) {
    if (b.source === 'fixed' || b.pinned) { flush(); continue; }
    run.push(b);
  }
  flush();
  check(true, `${label} inside every segment: urgent/forced first, then priority high → low`);
}

function baseOpts(extra) {
  return { today: TODAY, bufferMinutes: BUFFER, timetableBlocks: [], fixedTasks: [], urgentTasks: [],
           forced: [], habitGoals: [], goals: [], flexibleTasks: [], defaultUrgentMins: 90, ...extra };
}

// ─────────────────────────────────────────────────────────────
// (a) Normal day — 8-hour window, WITHOUT and WITH a neglected step-less goal
// ─────────────────────────────────────────────────────────────
function scenarioA() {
  header('(a1) Normal day WITHOUT a neglected step-less goal (PostgreSQL dsa=1 < neglect_days=3)');
  const goalsNoNeglect = SIX_GOALS.map(g => g.id === 2 ? { ...g, days_since_activity: 1 } : g);
  const resNoNeglect = buildDaySchedule(baseOpts({
    nowMinutes: 480, windowEndMinutes: 960, timetableBlocks: TWO_CLASSES,
    habitGoals: HABIT_GOALS, goals: goalsNoNeglect
  }));
  printSchedule(resNoNeglect);
  printScoreTable(resNoNeglect);
  console.log('');
  const work1 = resNoNeglect.plan.filter(b => b.source !== 'fixed');
  check(work1.length > 0, '(a1) at least one flexible block placed');
  check(work1.every(b => b.startMinutes >= 480 && endOf(b) <= 960), '(a1) every block inside 8:00 AM–4:00 PM');
  checkCaps(resNoNeglect, '(a1)', resNoNeglect.plan);
  checkSegmentOrder(resNoNeglect, '(a1)');
  check(!resNoNeglect.plan.some(b => b.goal_id === 2), '(a1) without neglect floor trigger, PostgreSQL (60m, lower score) is not placed');
  check(resNoNeglect.deferred.some(d => d.goal_id === 2 && /largest free gap 30 min \(15 usable after buffers\)/.test(d.reason)),
    '(a1) PostgreSQL is deferred with "largest free gap 30 min (15 usable after buffers)"');
  const lc1 = resNoNeglect.scores.find(r => r.title === 'LeetCode 320');
  check(lc1.daily_need > lc1.units_given && resNoNeglect.behind_pace.some(b => b.item === 'LeetCode 320'),
    `(a1) LeetCode needs ${lc1.daily_need}/day, capped to ${lc1.units_given} → visible as behind pace`);

  header('(a2) Normal day WITH a neglected step-less goal (PostgreSQL dsa=6 >= neglect_days=3)');
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 480, windowEndMinutes: 960, timetableBlocks: TWO_CLASSES,
    habitGoals: HABIT_GOALS, goals: SIX_GOALS
  }));
  printSchedule(result);
  printScoreTable(result);
  console.log('');
  const work = result.plan.filter(b => b.source !== 'fixed');
  check(work.length > 0, '(a2) at least one flexible block placed');
  check(work.every(b => b.startMinutes >= 480 && endOf(b) <= 960), '(a2) every block inside 8:00 AM–4:00 PM');
  checkCaps(result, '(a2)', result.plan);
  checkSegmentOrder(result, '(a2)');
  const pgBlock = result.plan.find(b => b.goal_id === 2);
  check(!!pgBlock && pgBlock.floor === true && pgBlock.duration === FLOOR_MINS,
    `(a2) neglected step-less goal PostgreSQL gets a ${FLOOR_MINS}-min neglect floor session in plan`);
  check(result.shrunk.some(s => s.goal_id === 2 && s.given === FLOOR_MINS && s.needed === 60),
    '(a2) PostgreSQL floor session appears in shrunk (30 min given vs 60 min full session)');
  check(result.deferred.every(d => /largest free gap \d+ min \(\d+ usable after buffers\)/.test(d.reason)),
    '(a2) deferred goals show both numbers: "largest free gap X min (Y usable after buffers)"');
  const lc = result.scores.find(r => r.title === 'LeetCode 320');
  check(lc.daily_need > lc.units_given && result.behind_pace.some(b => b.item === 'LeetCode 320'),
    `(a2) LeetCode needs ${lc.daily_need}/day, capped to ${lc.units_given} → visible as behind pace`);
}

// ─────────────────────────────────────────────────────────────
// (b) Emergency — urgent 90-min submission before an exam
// ─────────────────────────────────────────────────────────────
function scenarioB() {
  header('(b) Emergency — urgent 90-min submission + exam at 2:00 PM');
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 480, windowEndMinutes: 780,
    timetableBlocks: [
      { subject:'Software Engineering', start_time:'10:00 AM', end_time:'11:00 AM' },
      { subject:'Exam — DBMS',          start_time:'2:00 PM',  end_time:'4:30 PM'  }
    ],
    urgentTasks: [{ id:10, name:'Submit Assignment (urgent)', priority:'high', duration_min:90, due_date:TODAY }],
    goals: SIX_GOALS
  }));
  printSchedule(result);
  console.log('');
  const urg = result.plan.find(b => b.source === 'urgent');
  check(!!urg && urg.duration === 90, '(b) urgent submission placed at full 90 min');
  check(endOf(urg) <= 840, '(b) urgent submission finishes before the 2:00 PM exam');
  check(result.deferred.every(d => /largest free gap 30 min \(15 usable after buffers\)/.test(d.reason)),
    '(b) deferrals show both numbers: "largest free gap 30 min (15 usable after buffers)"');
  checkSegmentOrder(result, '(b)');
}

// ─────────────────────────────────────────────────────────────
// (b2) Overlaps — fixed-vs-fixed conflict, plus quarantine safety net
// ─────────────────────────────────────────────────────────────
function scenarioB2() {
  header('(b2) Overlaps — 3:30 PM surprise viva inside the 2–4 PM Database Lab');
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 780, windowEndMinutes: 1080,
    timetableBlocks: [{ subject:'Database Lab', start_time:'2:00 PM', end_time:'4:00 PM' }],
    fixedTasks: [{ id:40, name:'Surprise viva', fixed_start:'3:30 PM', fixed_end:'4:30 PM', priority:'high' }],
    goals: SIX_GOALS
  }));
  printSchedule(result);
  console.log('');
  const lab  = result.plan.find(b => b.task === 'Database Lab');
  const viva = result.plan.find(b => b.task === 'Surprise viva');
  check(!!lab && !!viva, '(b2) both Database Lab and Surprise viva are kept in the plan');
  check(result.warnings.some(w => w.includes('conflicts with')), '(b2) warning says "conflicts with <item>"');
  check(!result.warnings.some(w => w.includes('SCHEDULER BUG')), '(b2) no "SCHEDULER BUG" for a fixed-vs-fixed conflict');
  const flex = result.plan.filter(b => b.source !== 'fixed');
  check(flex.length > 0, '(b2) flexible blocks were placed (gaps 1–2 PM and 4:30–6 PM)');
  check(flex.every(b => endOf(b) <= lab.startMinutes || b.startMinutes >= endOf(viva)),
    '(b2) no flexible block overlaps the lab or the viva (2:00–4:30 PM)');

  console.log('\n  Safety net: feeding enforceNoFlexibleOverlaps a goal block at 3:00 PM inside the lab →');
  const guard = enforceNoFlexibleOverlaps([
    { task:'Database Lab', startMinutes:840, duration:120, source:'fixed' },
    { task:'Rogue goal block', startMinutes:900, duration:60, source:'goal', goal_id:99 },
    { task:'Good goal block',  startMinutes:780, duration:45, source:'goal', goal_id:98 }
  ]);
  check(guard.quarantined.length === 1 && guard.quarantined[0].item === 'Rogue goal block', '(b2) overlapping flexible block moved to quarantined/deferred');
  check(!guard.plan.some(b => b.task === 'Rogue goal block'), '(b2) returned plan does not contain the overlapping block');
  check(guard.plan.some(b => b.task === 'Good goal block'), '(b2) non-overlapping block kept');
  check(guard.warnings[0].includes('SCHEDULER BUG'), '(b2) flexible overlap is logged loudly as SCHEDULER BUG');
}

// ─────────────────────────────────────────────────────────────
// (c) 40-minute window — WITHOUT and WITH a neglected step-less goal
// ─────────────────────────────────────────────────────────────
function scenarioC() {
  header('(c1) 40-minute window WITHOUT a neglected step-less goal — all need ≥45 min');
  const goalsNoNeglect = SIX_GOALS.map(g => g.id === 2 ? { ...g, days_since_activity: 1 } : g);
  const resNoNeglect = buildDaySchedule(baseOpts({ nowMinutes: 1340, windowEndMinutes: 1380, goals: goalsNoNeglect }));
  printSchedule(resNoNeglect);
  console.log('');
  check(resNoNeglect.plan.length === 0, '(c1) nothing placed in 40-min window when no step-less goal is neglected');
  check(resNoNeglect.deferred.length > 0 && resNoNeglect.deferred.every(d => /no gap long enough \(needs \d+ min, largest free gap 40 min \(40 usable after buffers\)\)/.test(d.reason)),
    '(c1) every deferral says "no gap long enough (needs N min, largest free gap 40 min (40 usable after buffers))"');

  header('(c2) 40-minute window WITH a neglected step-less goal (PostgreSQL dsa=6 >= neglect_days=3)');
  const result = buildDaySchedule(baseOpts({ nowMinutes: 1340, windowEndMinutes: 1380, goals: SIX_GOALS }));
  printSchedule(result);
  console.log('');
  check(result.plan.length === 1 && result.plan[0].goal_id === 2 && result.plan[0].floor === true && result.plan[0].duration === FLOOR_MINS,
    `(c2) neglected step-less goal PostgreSQL fits as a ${FLOOR_MINS}-min floor session in the 40-min window`);
  check(result.shrunk.some(s => s.goal_id === 2 && s.given === FLOOR_MINS && s.needed === 60),
    '(c2) PostgreSQL floor session is listed in shrunk (30 min vs 60 min)');
  check(result.deferred.length === 4 && result.deferred.every(d => /no gap long enough \(needs \d+ min, largest free gap 10 min \(0 usable after buffers\)\)/.test(d.reason)),
    '(c2) remaining 4 goals deferred with "no gap long enough (needs N min, largest free gap 10 min (0 usable after buffers))"');

  // Also verify MAX_FLOOR_PER_DAY = 2 and deferred floor session when 3 step-less goals are neglected
  const threeNeglected = [
    ...SIX_GOALS.map(g => g.id === 5 ? { ...g, days_since_activity: 5 } : g),
    { id: 99, title: 'Extra Stepless Goal', goal_type: 'milestone', priority: 'low', status: 'active',
      steps: [], is_overdue: false, days_left: 10, behind_by: 10, days_since_activity: 4, current_count: 0, target_count: null }
  ];
  const res3 = buildDaySchedule(baseOpts({ nowMinutes: 1340, windowEndMinutes: 1380, goals: threeNeglected }));
  check(res3.deferred.some(d => d.goal_id === 5 && /needs 30 min, largest free gap 10 min \(0 usable after buffers\)/.test(d.reason)),
    '(c2) 2nd neglected step-less goal (Shell Scripting Lab) deferred by 10-min leftover gap');
  check(res3.deferred.some(d => d.goal_id === 99 && /neglect floor limit reached \(max 2 floor sessions\/day\)/.test(d.reason)),
    `(c2) 3rd neglected step-less goal beyond MAX_FLOOR_PER_DAY=${MAX_FLOOR_PER_DAY} stays deferred`);
}

// ─────────────────────────────────────────────────────────────
// (d) Refusals returned by buildDaySchedule itself
// ─────────────────────────────────────────────────────────────
function scenarioD() {
  header('(d) Refusals — buildDaySchedule returns scheduleRefusal(...), not "largest gap 0" deferrals');
  const cases = [
    ['window passed (now 11:20 PM, end 11:00 PM)', { nowMinutes: 1400, windowEndMinutes: 1380 }, 'window_expired'],
    ['done for day',                               { nowMinutes: 600,  windowEndMinutes: 1260, doneForDay: true }, 'done_for_day'],
    ['zero gaps (class covers whole window)',      { nowMinutes: 840,  windowEndMinutes: 960, timetableBlocks: TWO_CLASSES }, 'zero_budget']
  ];
  for (const [desc, opts, reason] of cases) {
    const r = buildDaySchedule(baseOpts({ goals: SIX_GOALS, ...opts }));
    console.log(`\n  ${desc} →`);
    console.log(JSON.stringify(r, null, 4));
    check(r.refused === true && r.reason === reason && !('deferred' in r), `(d) ${desc}: refusal reason=${reason}, no deferral list`);
  }
}

// ─────────────────────────────────────────────────────────────
// (e) Overdue high (shorter block) beats fresh low (longer block)
// ─────────────────────────────────────────────────────────────
function scenarioE() {
  header('(e) Only one block fits (60-min window). Overdue HIGH has the SHORTER block (45), fresh LOW the longer (60)');
  const goals = [
    { id:20, title:'Fresh Low Goal', goal_type:'milestone', priority:'low', status:'active',
      steps:[{id:2001,done:false,step_text:'Outline'},{id:2002,done:false,step_text:'Draft'},{id:2003,done:false,step_text:'Polish'}],
      is_overdue:false, days_left:20, behind_by:0, days_since_activity:0, current_count:0, target_count:null },
    { id:21, title:'Overdue High Goal', goal_type:'count', priority:'high', status:'active',
      steps:[], is_overdue:true, days_left:0, behind_by:100, days_since_activity:3, current_count:0, target_count:2 }
  ];
  const result = buildDaySchedule(baseOpts({ nowMinutes: 480, windowEndMinutes: 540, goals }));
  printSchedule(result);
  printScoreTable(result);
  console.log('');
  const goalBlocks = result.plan.filter(b => b.source === 'goal');
  check(goalBlocks.length === 1 && goalBlocks[0].goal_id === 21 && goalBlocks[0].duration === 45,
    '(e) the overdue high goal (45-min block) is placed');
  check(!goalBlocks.some(b => b.goal_id === 20) && result.deferred.some(d => d.goal_id === 20),
    '(e) the fresh low goal (60-min block) is deferred, even though duration ordering would favour it');
}

// ─────────────────────────────────────────────────────────────
// (f) Fixed block mid-window — goals BEFORE and AFTER (approved as is)
//     + item 6: a 120-min milestone block lists 2 steps
// ─────────────────────────────────────────────────────────────
function scenarioF() {
  header('(f) Fixed block mid-window — goals placed BEFORE AND AFTER; 120-min milestone = 2 steps');
  const goals = [
    SIX_GOALS[0], SIX_GOALS[1],
    { id:3, title:'LeetCode 320', goal_type:'count', priority:'high', status:'active',
      steps:[], is_overdue:false, days_left:5, behind_by:40, days_since_activity:0, current_count:3, target_count:10 }
  ];
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 540, windowEndMinutes: 840, goals,
    fixedTasks: [{ id:30, name:'Doctor appointment (fixed)', fixed_start:'11:00 AM', fixed_end:'12:00 PM', priority:'high' }]
  }));
  printSchedule(result);
  console.log('');
  const appt = result.plan.find(b => b.task.includes('Doctor'));
  const goalBlocks = result.plan.filter(b => b.source === 'goal');
  check(!!appt, '(f) doctor appointment present in plan');
  const before = goalBlocks.filter(b => endOf(b) <= appt.startMinutes);
  const after  = goalBlocks.filter(b => b.startMinutes >= endOf(appt));
  console.log(`\n  Doctor appointment: ${appt.time} – ${minutesToTimeString(endOf(appt))}`);
  console.log(`  BEFORE: ${before.map(b => `"${b.task}" ${b.time}–${minutesToTimeString(endOf(b))}`).join(', ') || '(none)'}`);
  console.log(`  AFTER : ${after.map(b => `"${b.task}" ${b.time}–${minutesToTimeString(endOf(b))}`).join(', ') || '(none)'}`);
  check(before.length > 0, '(f) at least one goal block placed BEFORE the appointment');
  check(after.length > 0,  '(f) at least one goal block placed AFTER the appointment');
  check(goalBlocks.every(b => endOf(b) <= appt.startMinutes || b.startMinutes >= endOf(appt)), '(f) no goal block overlaps 11:00 AM–12:00 PM');

  const sb = goalBlocks.find(b => b.goal_id === 1);
  console.log(`\n  Milestone block: ${JSON.stringify({ task: sb.task, duration: sb.duration, units: sb.units, step_ids: sb.step_ids })}`);
  check(sb.duration === 120 && sb.units === 2, '(f) Spring Boot block is 120 min = 2 units');
  check(JSON.stringify(sb.step_ids) === '[101,102]', '(f) step_ids = [101,102] (the next 2 pending steps, in order)');
  check(sb.task === 'Spring Boot Basics: next 2 steps (Controllers, Services)', '(f) text names the steps: "next 2 steps (Controllers, Services)"');
}

// ─────────────────────────────────────────────────────────────
// (g) No goals
// ─────────────────────────────────────────────────────────────
function scenarioG() {
  header('(g) No goals — empty plan (not a refusal)');
  const result = buildDaySchedule(baseOpts({ nowMinutes: 480, windowEndMinutes: 720 }));
  printSchedule(result);
  console.log('');
  check(result.refused === false && result.plan.length === 0, '(g) refused=false and plan is empty');
}

// ─────────────────────────────────────────────────────────────
// (h) No window — refusal objects (approved as is)
// ─────────────────────────────────────────────────────────────
function scenarioH() {
  header('(h) No window set — buildDaySchedule refusal + all refusal objects');
  const r = buildDaySchedule(baseOpts({ nowMinutes: 600, windowEndMinutes: null, goals: SIX_GOALS }));
  console.log('\n  buildDaySchedule({ windowEndMinutes: null }) →');
  console.log(JSON.stringify(r, null, 4));
  for (const reason of ['window_expired', 'done_for_day', 'zero_budget']) {
    console.log(`\n  scheduleRefusal('${reason}'):`);
    console.log(JSON.stringify(scheduleRefusal(reason), null, 4));
  }
  check(r.refused === true && r.reason === 'no_window' && r.needs_window === true, '(h) no window → refused=true, reason=no_window, needs_window=true');
}

// ─────────────────────────────────────────────────────────────
// (i) AGING A/B — 8 days, caps OFF, room for one block a day
// ─────────────────────────────────────────────────────────────
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (let i = 0; i < n; i++) { const [yy, mm, dd] = out.split('-').map(Number); out = getTomorrowDate(new Date(yy, mm - 1, dd)); }
  return out;
}

function runAging(agingRate) {
  let compDone = 169, compDaysLeft = 30;   // competitor: 31 remaining, 30 days → score ≈ 3.1, roughly constant
  let starveDsa = 0;                        // starving goal: days since activity
  let firstDay = null;
  const rows = [];
  for (let day = 1; day <= 8; day++) {
    const today = addDays(TODAY, day - 1);
    const competitor = { id:200, title:'LeetCode 200', goal_type:'count', priority:'high', status:'active', steps:[],
      is_overdue:false, days_left:compDaysLeft, behind_by:0, days_since_activity:0, current_count:compDone, target_count:200 };
    const starving   = { id:201, title:'Portfolio site', goal_type:'milestone', priority:'medium', status:'active', steps:[],
      is_overdue:true, days_left:0, behind_by:0, days_since_activity:starveDsa, current_count:0, target_count:null };
    const res = allocateFlexibleWork({ budgetMinutes: 60, bufferMinutes: 0, goals: [competitor, starving], today,
                                       applyCaps: false, enableFloor: false, agingRate });
    const c = res.scores.find(s => s.goal_id === 200);
    const s = res.scores.find(s => s.goal_id === 201);
    const winners = res.blocks.map(b => b.goal_id);
    check(res.blocks.length === 1, `(i) day ${day} rate=${agingRate}: exactly one block fits`);
    const starvedWon = winners.includes(201);
    rows.push({ day, today, cRem: c.remaining, cDays: c.days_left, cScore: c.score, dsa: starveDsa, aging: s.aging, sScore: s.score,
                winner: starvedWon ? 'Portfolio site ⭐' : 'LeetCode 200' });
    if (starvedWon) { if (firstDay === null) firstDay = day; starveDsa = 0; }
    else { compDone += 1; starveDsa += 1; }
    compDaysLeft -= 1;
  }
  return { rows, firstDay };
}

function printAgingTable(title, rows) {
  console.log(`\n  ${title}`);
  console.log('  day | today      | comp rem/days | comp score | starve dsa | aging | starve score | scheduled');
  console.log('  ' + '─'.repeat(96));
  for (const r of rows) {
    console.log(`  ${String(r.day).padStart(3)} | ${r.today} | ${String(r.cRem).padStart(6)}/${String(r.cDays).padEnd(6)} | ${r.cScore.toFixed(3).padStart(10)} | ` +
                `${String(r.dsa).padStart(10)} | ${r.aging.toFixed(2).padStart(5)} | ${r.sScore.toFixed(3).padStart(12)} | ${r.winner}`);
  }
}

function scenarioI() {
  header('(i) AGING A/B — 8 days, caps OFF, 60-min budget (room for one block/day)');
  console.log('  Competitor: LeetCode 200 (high, count, 31 left / 30 days, worked daily → aging stays 1.00)');
  console.log('  Starving:   Portfolio site (medium, step-less, overdue → effective days 1, behind_by held at 0 to isolate aging)');
  const A = runAging(0);
  const B = runAging(0.1);
  printAgingTable('RUN A — aging forced to 1 (agingRate = 0)', A.rows);
  printAgingTable('RUN B — aging enabled (AGING_RATE = 0.1, cap 10 days)', B.rows);
  console.log('');
  check(A.firstDay === null, '(i) RUN A: without aging the starving goal is NEVER scheduled in 8 days');
  check(B.firstDay !== null, `(i) RUN B: with aging the starving goal IS scheduled — on day ${B.firstDay} (${B.rows[B.firstDay - 1]?.today})`);
}

// ─────────────────────────────────────────────────────────────
// (j) Outline mode — 5h user-stated budget, caps applied
// ─────────────────────────────────────────────────────────────
function scenarioJ() {
  header('(j) Outline mode — 5h user-stated budget, buffers counted, no clock times, caps applied');
  const result = buildDayOutline(baseOpts({ budgetMinutes: 300, timetableBlocks: TWO_CLASSES, habitGoals: HABIT_GOALS, goals: SIX_GOALS }));
  console.log(`\ntoday (injected) = ${result.today}`);
  console.log('\nFIXED CLASSES (not in budget):');
  result.fixedItems.forEach(f => console.log(`  ${f.start_time} – ${f.end_time}: ${f.task}`));
  console.log(`\nFREE BLOCKS (budget ${result.budgetMinutes}min, used ${result.budgetUsed}min incl. buffers):`);
  result.freeBlocks.forEach(b => console.log(`  (${b.label}) [${b.source.padEnd(8)}] ${b.task} — ${b.duration}min${b.floor ? '  floor' : ''}${b.units ? `  units=${b.units}` : ''}${b.step_ids?.length ? `  step_ids=[${b.step_ids}]` : ''}`));
  printLists(result);
  printScoreTable(result);
  console.log('');
  check(result.freeBlocks.length > 0, '(j) outline placed free blocks');
  check(result.budgetUsed <= result.budgetMinutes, `(j) outline budget respected (${result.budgetUsed} ≤ ${result.budgetMinutes})`);
  check(result.freeBlocks.every(b => b.time === undefined && b.startMinutes === undefined), '(j) outline blocks carry no clock times');
  checkCaps(result, '(j)', result.freeBlocks);
}

// ─────────────────────────────────────────────────────────────
// (k) Flexible tasks — manual + email, each placed once, time_slot honoured
// ─────────────────────────────────────────────────────────────
function scenarioK() {
  header('(k) Flexible tasks — 3 manual (one time_slot 3:30 PM, one 90 min) + 1 email-derived');
  const flexibleTasks = [
    { id:51, name:'Read OS chapter 5',          priority:'medium', source:'manual' },
    { id:52, name:'Group project prep',         priority:'high',   source:'manual', time_slot:'3:30 PM', duration_min:30 },
    { id:53, name:'Write networks lab report',  priority:'medium', source:'manual', duration_min:90 },
    { id:54, name:'Reply to placement cell',    priority:'high',   source:'email',  duration_min:20 }
  ];
  const result = buildDaySchedule(baseOpts({ nowMinutes: 780, windowEndMinutes: 1080, flexibleTasks }));
  printSchedule(result);
  console.log('');
  for (const t of flexibleTasks) {
    const n = result.plan.filter(b => b.task_id === t.id).length;
    check(n === 1, `(k) "${t.name}" placed exactly once`);
  }
  const slot = result.plan.find(b => b.task_id === 52);
  check(slot.startMinutes === parseTimeToMinutes('3:30 PM') && slot.pinned === true, '(k) time_slot task starts at its preferred 3:30 PM');
  check(result.plan.find(b => b.task_id === 53).duration === 90, '(k) duration_min 90 respected');
  check(result.plan.find(b => b.task_id === 54).origin === 'email', '(k) email-derived task carries origin=email');
  checkSegmentOrder(result, '(k)');
}

// ─────────────────────────────────────────────────────────────
// (l) Duplicate names (case-insensitive) placed once
// ─────────────────────────────────────────────────────────────
function scenarioL() {
  header('(l) Same task name twice (case-insensitive) → placed once');
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 780, windowEndMinutes: 1080,
    forced: [{ id:60, name:'Revise DBMS notes', duration_min:30 }],
    flexibleTasks: [
      { id:61, name:'Buy groceries',        source:'manual' },
      { id:62, name:'  buy   GROCERIES ',   source:'email'  },
      { id:63, name:'revise dbms NOTES',    source:'manual' }
    ]
  }));
  printSchedule(result);
  console.log('');
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
  check(result.plan.filter(b => norm(b.task) === 'buy groceries').length === 1, '(l) "Buy groceries" placed once');
  check(result.plan.filter(b => norm(b.task) === 'revise dbms notes').length === 1, '(l) "Revise DBMS notes" placed once (forced vs flexible)');
  check(result.duplicates.length === 2, '(l) two duplicates reported');
}

// ─────────────────────────────────────────────────────────────
// (m) Habit run slot 6:30 AM inside a 5–9 AM window
// ─────────────────────────────────────────────────────────────
function scenarioM() {
  header('(m) Habit with run slot 6:30 AM inside a 5:00–9:00 AM window');
  const result = buildDaySchedule(baseOpts({
    nowMinutes: 300, windowEndMinutes: 540, habitGoals: HABIT_GOALS, goals: SIX_GOALS, runSlotStartMins: 390
  }));
  printSchedule(result);
  console.log('');
  const run = result.plan.find(b => b.source === 'habit');
  check(!!run && run.startMinutes === 390, '(m) run starts at 6:30 AM');
  checkSegmentOrder(result, '(m)');
}

// ─────────────────────────────────────────────────────────────
// (n) Realistic starvation over 14 days (PostgreSQL step-less, LeetCode 40, Spring Boot steps)
//     Real behind_by computed from dates; 'worked' logged whenever scheduled.
//     Run with floor OFF and floor ON.
// ─────────────────────────────────────────────────────────────
function computeRealDateMetrics(g, today, dsa) {
  const totalDays   = daysBetween(g.created_date, g.deadline);
  const elapsedDays = daysBetween(g.created_date, today);
  const expected_progress = totalDays > 0
    ? Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)))
    : 0;
  const progress   = 0; // logging 'worked' does not change progress
  const behind_by  = Math.max(0, expected_progress - progress);
  const days_left  = Math.max(0, daysBetween(today, g.deadline));
  const is_overdue = daysBetween(g.deadline, today) > 0;
  return { ...g, days_left, expected_progress, behind_by, is_overdue, days_since_activity: dsa };
}

function runStarvation14Days(enableFloor, neglectDays = DEFAULT_NEGLECT_DAYS) {
  const startDate = '2026-10-01';
  const baseGoals = [
    { id: 1, title: 'Spring Boot Basics',       goal_type: 'milestone', priority: 'high', status: 'active',
      created_date: startDate, deadline: '2026-10-15',
      steps: [{id:101,done:false,step_text:'Controllers'},{id:102,done:false,step_text:'Services'},{id:103,done:false,step_text:'Repositories'}],
      current_count: 0, target_count: null },
    { id: 2, title: 'PostgreSQL + Spring Boot', goal_type: 'milestone', priority: 'high', status: 'active',
      created_date: startDate, deadline: '2026-10-20',
      steps: [], current_count: 0, target_count: null },
    { id: 3, title: 'LeetCode 320',             goal_type: 'count',     priority: 'high', status: 'active',
      created_date: startDate, deadline: '2026-10-31',
      steps: [], current_count: 0, target_count: 40 }
  ];

  const dsaById = { 1: 0, 2: 0, 3: 0 };
  const scheduledDays = [];
  const dailyLog = [];

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`SCENARIO (n) — 14-DAY SIMULATION (${enableFloor ? `FLOOR ON: FLOOR_MINS=${FLOOR_MINS}, MAX_FLOOR_PER_DAY=${MAX_FLOOR_PER_DAY}, neglect_days=${neglectDays}` : 'FLOOR OFF'})`);
  console.log('═'.repeat(70));

  for (let day = 1; day <= 14; day++) {
    const today = addDays(startDate, day - 1);
    const goalsToday = baseGoals.map(g => computeRealDateMetrics(g, today, dsaById[g.id]));
    const pgBefore = goalsToday.find(g => g.id === 2);

    const res = buildDaySchedule(baseOpts({
      today,
      nowMinutes: 600,        // 10:00 AM
      windowEndMinutes: 780,  // 1:00 PM (180 min free window)
      goals: goalsToday,
      enableFloor,
      neglectDays
    }));

    const pgBlock = res.plan.find(b => b.goal_id === 2);
    const pgScheduled = !!pgBlock;
    if (pgScheduled) scheduledDays.push(day);

    console.log(`\n  Day ${String(day).padStart(2)} (${today}) | PostgreSQL dsa=${pgBefore.days_since_activity} (behind_by=${pgBefore.behind_by}%) | PostgreSQL scheduled: ${pgScheduled ? `YES (${pgBlock.duration}min${pgBlock.floor ? ', floor' : ''})` : 'NO'}`);
    console.log('    goal                      | prio | days_left | rem | behind% | dsa | aging | score  | need | given | mins');
    console.log('    ' + '─'.repeat(98));
    for (const r of res.scores) {
      const gMeta = goalsToday.find(g => g.id === r.goal_id);
      console.log(
        `    ${r.title.padEnd(25)} | ${r.priority.padEnd(4)} | ${String(r.days_left).padStart(9)} | ${String(r.remaining).padStart(3)} | ` +
        `${String(gMeta.behind_by).padStart(6)}% | ${String(gMeta.days_since_activity).padStart(3)} | ${r.aging.toFixed(2).padStart(5)} | ` +
        `${r.score.toFixed(3).padStart(6)} | ${String(r.daily_need).padStart(4)} | ${String(r.units_given).padStart(5)} | ${String(r.minutes_given).padStart(4)}`
      );
    }

    dailyLog.push({ day, today, pgDsa: pgBefore.days_since_activity, pgScheduled, scores: res.scores });

    // Log 'worked' whenever a goal is scheduled (resets dsa to 0; unscheduled goals increment dsa)
    for (const g of baseGoals) {
      const wasScheduled = res.plan.some(b => b.goal_id === g.id);
      if (wasScheduled) dsaById[g.id] = 0;
      else dsaById[g.id] += 1;
    }
  }

  const firstDay = scheduledDays.length > 0 ? scheduledDays[0] : null;
  console.log(`\n  Summary (${enableFloor ? 'FLOOR ON' : 'FLOOR OFF'}): PostgreSQL first scheduled day = ${firstDay === null ? 'never' : `day ${firstDay}`}; all scheduled days = [${scheduledDays.join(', ') || 'none'}]`);
  return { firstDay, scheduledDays, dailyLog };
}

function scenarioN() {
  header('(n) Realistic starvation over 14 days — PostgreSQL (high, step-less, deadline day 20), LeetCode (40), Spring Boot (steps)');
  const neglectDays = DEFAULT_NEGLECT_DAYS;
  const off = runStarvation14Days(false, neglectDays);
  const on  = runStarvation14Days(true, neglectDays);

  console.log('');
  check(off.firstDay === null, `(n) Floor OFF: PostgreSQL first scheduled = ${off.firstDay ?? 'never'} (starved all 14 days despite aging + caps)`);
  check(on.firstDay !== null && on.firstDay <= neglectDays + 1,
    `(n) Floor ON: PostgreSQL first scheduled on day ${on.firstDay} (<= neglect_days+1 = ${neglectDays + 1})`);

  for (let i = 1; i < on.scheduledDays.length; i++) {
    const prev = on.scheduledDays[i - 1];
    const curr = on.scheduledDays[i];
    const gap  = curr - prev;
    check(gap <= neglectDays + 1,
      `(n) Floor ON: scheduled again on day ${curr} (${gap} days after day ${prev}, <= neglect_days+1 = ${neglectDays + 1})`);
  }
  const lastScheduled = on.scheduledDays[on.scheduledDays.length - 1];
  check(14 - lastScheduled < neglectDays + 1,
    `(n) Floor ON: after last session on day ${lastScheduled}, only ${14 - lastScheduled} day(s) remain (< neglect_days+1 = ${neglectDays + 1})`);
}

// ── Optional: prove a failing assertion exits non-zero ──
if (process.argv.includes('--demo-failure')) {
  console.log('--demo-failure: feeding an overlapping plan into the SAME assertion path');
  printSchedule({
    today: TODAY, nowMinutes: 480, windowEndMinutes: 600, budgetMinutes: 120,
    gapSummary: [{ start_time: '8:00 AM', end_time: '10:00 AM', size_min: 120 }],
    plan: [
      { task: 'Block A', startMinutes: 480, duration: 90, time: '8:00 AM', source: 'goal', priority: 'high' },
      { task: 'Block B', startMinutes: 510, duration: 60, time: '8:30 AM', source: 'goal', priority: 'high' }
    ]
  });
  console.log('UNREACHABLE: assertion did not fire');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// RUN ALL
// ─────────────────────────────────────────────────────────────
console.log('═'.repeat(70));
console.log(`SCHEDULER TEST SUITE — scenarios (a)–(n) + (b2)   today=${TODAY}`);
console.log('═'.repeat(70));

scenarioA();
scenarioB();
scenarioB2();
scenarioC();
scenarioD();
scenarioE();
scenarioF();
scenarioG();
scenarioH();
scenarioI();
scenarioJ();
scenarioK();
scenarioL();
scenarioM();
scenarioN();

console.log('\n' + '═'.repeat(70));
console.log('ALL SCENARIOS (a)–(n) + (b2) PASSED');
console.log('═'.repeat(70));
process.exit(0);
