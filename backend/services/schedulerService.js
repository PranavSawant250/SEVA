/**
 * backend/services/schedulerService.js
 *
 * PURE FUNCTIONS — no DB reads, no AI calls, no clock reads (new Date()).
 * All inputs are injected. Tests can pass any date/time.
 *
 * Exports:
 *   allocateFlexibleWork(opts) → { blocks, deferred, shrunk, warnings }
 *   buildDaySchedule(opts)    → { plan, deferred, shrunk, warnings }
 *   buildDayOutline(opts)     → { fixedItems, freeBlocks, budgetUsed, budgetMinutes, deferred }
 *
 * Plan item shape (matches existing day_plans plan_json shape):
 *   { time, task, priority, duration, source, goal_id, task_id }
 *   time: "H:MM AM/PM" (clock mode) or null (outline mode)
 *   source: 'fixed'|'urgent'|'forced'|'habit'|'goal'|'flexible'|'buffer'
 *
 * ─── CONSTANTS (each commented as an assumption) ───────────────────────────
 */

// Minutes allocated per LeetCode-style count unit (assumption: ~45 min/problem)
const MINS_PER_COUNT_UNIT = 45;
// Minutes allocated per milestone step (assumption: ~60 min/step)
const MINS_PER_STEP = 60;
// Minutes for a step-less milestone session (assumption: 60 min to "work on" it)
const MINS_STEPLESS_SESSION = 60;
// Minutes for a habit session (e.g. daily run) — assumption: 30 min
const MINS_HABIT_SESSION = 30;
// Minimum block size: below this we don't schedule a partial unit (assumption: 25 min)
const MIN_BLOCK_MINS = 25;
// Priority weights for scoring
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };

const { minutesToTimeString, parseTimeToMinutes, getTodayDate, daysBetween } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute remaining work (in allocatable units) for a goal.
 * count  → target_count - current_count
 * milestone with steps → pending step count
 * milestone step-less  → 1 (one session)
 * frequency            → handled by habit layer, not here
 */
function goalRemainingUnits(goal) {
  if (goal.goal_type === 'count') {
    return Math.max(0, (goal.target_count || 0) - (goal.current_count || 0));
  }
  if (goal.goal_type === 'milestone') {
    const steps = goal.steps || [];
    if (steps.length === 0) return 1; // step-less: always 1 session
    const pending = steps.filter(s => !s.done).length;
    return Math.max(0, pending);
  }
  return 0; // frequency goals use habit layer
}

/**
 * Minutes needed for N units of a goal.
 */
function unitsToMinutes(goal, units) {
  if (goal.goal_type === 'count') return units * MINS_PER_COUNT_UNIT;
  const steps = goal.steps || [];
  if (steps.length === 0) return MINS_STEPLESS_SESSION; // step-less: always 1 session
  return units * MINS_PER_STEP;
}

/**
 * Get the text of the next pending step for a milestone goal, if any.
 */
function nextPendingStep(goal) {
  const steps = goal.steps || [];
  const pending = steps.find(s => !s.done);
  return pending ? pending.step_text : null;
}

/**
 * Build the task display text from a goal and unit count.
 * Rule 1: Code builds task text from templates.
 */
function buildGoalTaskText(goal, units) {
  if (goal.goal_type === 'count') {
    return `${goal.title}: solve ${units} problem${units !== 1 ? 's' : ''}`;
  }
  if (goal.goal_type === 'milestone') {
    const step = nextPendingStep(goal);
    if (step) return `${goal.title}: next step (${step})`;
    return `${goal.title}: work session`;
  }
  return goal.title;
}

/**
 * Overlap check: returns true if [aStart, aStart+aDur) overlaps [bStart, bStart+bDur).
 */
function overlaps(aStart, aDur, bStart, bDur) {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}

/**
 * Assert no two blocks in the plan overlap. Throws if they do.
 * Used in test scenarios to catch scheduling bugs.
 */
function assertNoOverlaps(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.startMinutes == null || b.startMinutes == null) continue;
      if (overlaps(a.startMinutes, a.duration, b.startMinutes, b.duration)) {
        throw new Error(
          `OVERLAP: "${a.task}" (${minutesToTimeString(a.startMinutes)}, ${a.duration}min) ` +
          `and "${b.task}" (${minutesToTimeString(b.startMinutes)}, ${b.duration}min)`
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// allocateFlexibleWork
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Pure allocation: given a budget and layers of work, returns ordered blocks.
 * Does NOT assign clock times. buildDaySchedule places these into free gaps.
 *
 * @param {object} opts
 *   budgetMinutes  {number}   — total free minutes available
 *   bufferMinutes  {number}   — gap between blocks (from preferences)
 *   urgentTasks    {Array}    — tasks with is_urgent=1 or due_date within 3 days
 *                               each: { id, name, priority, duration_min, default_urgent_minutes, due_date }
 *   habitGoals     {Array}    — frequency goals needing a session today
 *                               each: { id, title, days_this_week, per_week, last_logged_today }
 *   goals          {Array}    — active non-frequency goals with full progress data
 *   forced         {Array}    — items forced in by nightly check-in
 *                               each: { id, name, duration_min, goal_id?, type: 'goal'|'task' }
 *   today          {string}   — "YYYY-MM-DD" (for scoring: days_since_activity)
 *   defaultUrgentMins {number}
 *   runSlotStartMins {number|null} — preferred slot for habits (null = first gap)
 *
 * @returns {{ blocks, deferred, shrunk, warnings }}
 *   blocks  — ordered plan blocks without clock times
 *   deferred — items that didn't fit: [{ item, reason }]
 *   shrunk   — items given fewer units than needed: [{ item, given, needed, reason }]
 *   warnings — informational strings
 */
function allocateFlexibleWork({
  budgetMinutes,
  bufferMinutes = 15,
  urgentTasks = [],
  habitGoals = [],
  goals = [],
  forced = [],
  today,
  defaultUrgentMins = 90,
  runSlotStartMins = null
}) {
  const blocks = [];
  const deferred = [];
  const shrunk = [];
  const warnings = [];
  let remaining = budgetMinutes;

  // Buffer is charged BETWEEN blocks, so only added from the 2nd block onward.
  // addBlock: subtracts duration, then adds bufferMinutes if there are already blocks.
  function addBlock(block) {
    const bufCost = blocks.length > 0 ? bufferMinutes : 0;
    remaining -= (block.duration + bufCost);
    blocks.push(block);
  }

  // fits(mins): returns true if budget can accommodate mins + upcoming buffer
  function fits(mins) {
    const bufCost = blocks.length > 0 ? bufferMinutes : 0;
    return remaining >= mins + bufCost;
  }

  // ── LAYER 2: URGENT ACADEMIC ───────────────────────────────────────────────
  // Sort by nearest due_date first
  const sortedUrgent = [...urgentTasks].sort((a, b) => {
    const da = a.due_date ? daysBetween(today, a.due_date) : 999;
    const db2 = b.due_date ? daysBetween(today, b.due_date) : 999;
    return da - db2;
  });

  for (const task of sortedUrgent) {
    const dur = task.duration_min || defaultUrgentMins;
    if (fits(dur)) {
      addBlock({ task: task.name, priority: task.priority || 'high', duration: dur, source: 'urgent', task_id: task.id, goal_id: task.goal_id || null });
    } else if (fits(MIN_BLOCK_MINS)) {
      const given = Math.floor(remaining / 1) - (blocks.length > 0 ? bufferMinutes : 0);
      const actual = Math.max(MIN_BLOCK_MINS, Math.min(given, dur));
      if (fits(actual)) {
        addBlock({ task: task.name, priority: 'high', duration: actual, source: 'urgent', task_id: task.id, goal_id: null });
        shrunk.push({ item: task.name, given: actual, needed: dur, reason: 'budget too small for full urgent block' });
      } else {
        deferred.push({ item: task.name, reason: 'not enough budget even for minimum urgent block' });
      }
    } else {
      deferred.push({ item: task.name, reason: 'no budget left for urgent task' });
      warnings.push(`⚠️ Urgent task "${task.name}" didn't fit — budget exhausted.`);
    }
  }

  // ── LAYER 3: FORCED (from nightly check-in) ────────────────────────────────
  for (const item of forced) {
    const dur = item.duration_min || MIN_BLOCK_MINS;
    if (fits(dur)) {
      addBlock({ task: item.name, priority: item.priority || 'medium', duration: dur, source: 'forced', task_id: item.id || null, goal_id: item.goal_id || null });
    } else if (fits(MIN_BLOCK_MINS)) {
      addBlock({ task: item.name, priority: item.priority || 'medium', duration: MIN_BLOCK_MINS, source: 'forced', task_id: item.id || null, goal_id: item.goal_id || null });
      shrunk.push({ item: item.name, given: MIN_BLOCK_MINS, needed: dur, reason: 'budget too small for full forced block' });
    } else {
      deferred.push({ item: item.name, reason: 'no budget left — forced item could not fit even at minimum size' });
      warnings.push(`⚠️ Forced item "${item.name}" doesn't fit even at minimum size (${MIN_BLOCK_MINS} min). Consider raising your time budget.`);
    }
  }

  // ── LAYER 4: HABITS ────────────────────────────────────────────────────────
  for (const habit of habitGoals) {
    if (habit.last_logged_today) continue; // already done today
    if (habit.days_this_week >= habit.per_week) continue; // quota met

    const isHeavyDay = remaining < budgetMinutes * 0.4; // less than 40% budget left = heavy day
    let dur = MINS_HABIT_SESSION;
    if (isHeavyDay) {
      dur = Math.floor(MINS_HABIT_SESSION / 2);
      shrunk.push({ item: habit.title, given: dur, needed: MINS_HABIT_SESSION, reason: 'heavy day — habit halved' });
    }

    if (fits(dur)) {
      addBlock({ task: `${habit.title}: session`, priority: 'medium', duration: dur, source: 'habit', goal_id: habit.id, task_id: null, preferredStartMins: runSlotStartMins });
    } else {
      deferred.push({ item: habit.title, reason: `no budget for habit session (need ${dur} min)` });
      warnings.push(`Habit "${habit.title}" skipped — not enough budget.`);
    }
  }

  // ── LAYER 5: GOAL WORK ─────────────────────────────────────────────────────
  // Score each goal and sort descending
  const scoredGoals = goals
    .filter(g => g.status === 'active' && g.goal_type !== 'frequency')
    .map(g => {
      const remUnits = goalRemainingUnits(g);
      if (remUnits <= 0) return null;

      const isOverdue = g.is_overdue;
      const rawDaysLeft = g.days_left !== null ? g.days_left : 30;
      const daysLeft = Math.max(1, isOverdue ? 1 : rawDaysLeft);
      const dailyNeed = Math.ceil(remUnits / daysLeft);
      const behindBy = g.behind_by || 0;
      const daysSinceActivity = g.days_since_activity || 0;

      // Aging factor: 1 + 0.1 × min(days_since_activity, 10)
      // NEW: ensures goals that keep losing out slowly rise in score
      const aging = 1 + 0.1 * Math.min(daysSinceActivity, 10);
      const pw = PRIORITY_WEIGHT[g.priority] || 2;
      // score = priority_weight × (remaining_work / days_left) × (1 + behind_by/100) × aging
      const score = pw * (remUnits / daysLeft) * (1 + behindBy / 100) * aging;
      // Overdue: multiply days_left by 1.5 for duration estimate only
      const effectiveDaysLeft = isOverdue ? 1 : daysLeft;

      return { goal: g, remUnits, daysLeft: effectiveDaysLeft, dailyNeed, score, aging, behindBy };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  for (const entry of scoredGoals) {
    const { goal, remUnits, dailyNeed, score } = entry;
    // Try to allocate dailyNeed units; if not, largest whole number; if not even 1 unit, defer
    let unitsToGive = dailyNeed;

    // Try daily_need first, then shrink to what fits
    while (unitsToGive > 0 && !fits(unitsToMinutes(goal, unitsToGive))) {
      unitsToGive--;
    }

    if (unitsToGive === 0) {
      deferred.push({ item: goal.title, reason: `not enough budget (need ${MIN_BLOCK_MINS}+ min for 1 unit)`, score: score.toFixed(2) });
      continue;
    }

    const dur = unitsToMinutes(goal, unitsToGive);
    if (!fits(dur)) {
      deferred.push({ item: goal.title, reason: 'no remaining budget', score: score.toFixed(2) });
      continue;
    }

    const taskText = buildGoalTaskText(goal, unitsToGive);
    addBlock({ task: taskText, priority: goal.priority, duration: dur, source: 'goal', goal_id: goal.id, task_id: null, units: unitsToGive });

    if (unitsToGive < dailyNeed) {
      shrunk.push({ item: goal.title, given: unitsToGive, needed: dailyNeed, reason: 'budget too small for full daily need' });
    }
  }

  // ── LAYER 6: FLEXIBLE TASKS ────────────────────────────────────────────────
  for (const task of (goals._flexTasks || [])) {
    const dur = task.duration_min || 30;
    if (fits(dur)) {
      addBlock({ task: task.name, priority: task.priority || 'medium', duration: dur, source: 'flexible', task_id: task.id, goal_id: null, preferredTimeSlot: task.time_slot });
    } else {
      deferred.push({ item: task.name, reason: 'no budget for flexible task' });
    }
  }

  return { blocks, deferred, shrunk, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDaySchedule
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Assigns clock times to blocks by fitting them into free gaps between fixed items.
 * Fixed blocks are never moved; flexible blocks are never split across fixed blocks.
 *
 * @param {object} opts
 *   today          {string}   "YYYY-MM-DD"
 *   nowMinutes     {number}   current time in minutes since midnight
 *   windowEndMinutes {number} end of work window
 *   timetableBlocks {Array}  [{subject, start_time, end_time}] — TODAY's classes
 *   fixedTasks     {Array}   tasks with fixed_start — [{name, fixed_start, fixed_end, duration_min, priority, id, goal_id}]
 *   allocResult    {object}  output of allocateFlexibleWork
 *   bufferMinutes  {number}
 *
 * @returns {{ plan, deferred, shrunk, warnings, windowEndMinutes }}
 */
function buildDaySchedule({
  today,
  nowMinutes,
  windowEndMinutes,
  timetableBlocks = [],
  fixedTasks = [],
  allocResult,
  bufferMinutes = 15
}) {
  const { blocks: allocBlocks, deferred, shrunk, warnings } = allocResult;
  const plan = [];
  const extraDeferred = [...deferred];
  const extraWarnings = [...warnings];

  // Build fixed timeline: timetable + fixed_start tasks, sorted by start
  const fixedTimeline = [];

  for (const tb of timetableBlocks) {
    const startMins = parseTimeToMinutes(tb.start_time);
    const endMins = parseTimeToMinutes(tb.end_time);
    if (startMins !== null && endMins !== null) {
      fixedTimeline.push({ task: tb.subject, startMinutes: startMins, duration: endMins - startMins, source: 'fixed', priority: 'medium', goal_id: null, task_id: null });
    }
  }

  for (const ft of fixedTasks) {
    const startMins = parseTimeToMinutes(ft.fixed_start);
    const dur = ft.fixed_end
      ? (parseTimeToMinutes(ft.fixed_end) - startMins)
      : (ft.duration_min || 60);
    if (startMins !== null) {
      fixedTimeline.push({ task: ft.name, startMinutes: startMins, duration: dur, source: 'fixed', priority: ft.priority || 'high', goal_id: ft.goal_id || null, task_id: ft.id || null });
    }
  }

  fixedTimeline.sort((a, b) => a.startMinutes - b.startMinutes);
  plan.push(...fixedTimeline.map(b => ({ ...b, time: minutesToTimeString(b.startMinutes) })));

  // Compute free gaps between nowMinutes and windowEndMinutes
  function computeGaps() {
    const occupied = fixedTimeline
      .filter(b => b.startMinutes >= nowMinutes && b.startMinutes < windowEndMinutes)
      .map(b => ({ start: b.startMinutes, end: b.startMinutes + b.duration }))
      .sort((a, b) => a.start - b.start);

    const gaps = [];
    let cursor = nowMinutes;
    for (const occ of occupied) {
      if (occ.start > cursor) gaps.push({ start: cursor, end: occ.start });
      cursor = Math.max(cursor, occ.end);
    }
    if (cursor < windowEndMinutes) gaps.push({ start: cursor, end: windowEndMinutes });
    return gaps;
  }

  // Place allocBlocks into gaps
  let gaps = computeGaps();
  let gapIdx = 0;
  let cursorInGap = gaps.length > 0 ? gaps[0].start : windowEndMinutes;

  for (const block of allocBlocks) {
    const needed = block.duration + (plan.filter(p => p.source !== 'fixed').length > 0 ? bufferMinutes : 0);

    // Find a gap that fits
    let placed = false;
    while (gapIdx < gaps.length) {
      const gap = gaps[gapIdx];
      const gapCursor = Math.max(cursorInGap, gap.start);
      const avail = gap.end - gapCursor;

      if (avail >= block.duration) {
        plan.push({ ...block, startMinutes: gapCursor, time: minutesToTimeString(gapCursor) });
        cursorInGap = gapCursor + block.duration + bufferMinutes;
        placed = true;
        break;
      } else {
        // Move to next gap
        gapIdx++;
        if (gapIdx < gaps.length) cursorInGap = gaps[gapIdx].start;
      }
    }

    if (!placed) {
      extraDeferred.push({ item: block.task, reason: 'no free gap large enough in window' });
      extraWarnings.push(`"${block.task}" couldn't fit in any free gap.`);
    }
  }

  // Sort final plan by startMinutes (fixed blocks already have it)
  plan.sort((a, b) => (a.startMinutes ?? Infinity) - (b.startMinutes ?? Infinity));

  // Assert no overlaps (catches bugs)
  try { assertNoOverlaps(plan); } catch (e) { extraWarnings.push(`BUG: ${e.message}`); }

  return { plan, deferred: extraDeferred, shrunk, warnings: extraWarnings, windowEndMinutes };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDayOutline
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Builds a rough outline for a future day (used by the nightly check-in).
 * Returns blocks with durations but NO clock times.
 * Fixed timetable classes are listed separately; they do NOT consume the free budget.
 * Buffers between blocks DO consume budget.
 *
 * @param {object} opts
 *   budgetMinutes  {number}   — user's stated free time budget
 *   bufferMinutes  {number}
 *   timetableBlocks {Array}  — tomorrow's classes (shown separately, not in budget)
 *   allocOpts      {object}  — same opts as allocateFlexibleWork
 *
 * @returns {{ fixedItems, freeBlocks, budgetUsed, budgetMinutes, deferred }}
 */
function buildDayOutline({ budgetMinutes, bufferMinutes = 15, timetableBlocks = [], allocOpts }) {
  const fixedItems = timetableBlocks.map(tb => ({
    task: tb.subject, start_time: tb.start_time, end_time: tb.end_time, source: 'fixed'
  }));

  const result = allocateFlexibleWork({ ...allocOpts, budgetMinutes, bufferMinutes });

  // Label free blocks with letters (a, b, c, …)
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const freeBlocks = result.blocks.map((b, i) => ({
    label: letters[i] || String(i + 1),
    task: b.task,
    duration: b.duration,
    source: b.source,
    goal_id: b.goal_id || null
  }));

  // Budget used: sum of block durations + buffers between blocks
  const blockSum = result.blocks.reduce((s, b) => s + b.duration, 0);
  const bufferSum = Math.max(0, result.blocks.length - 1) * bufferMinutes;
  const budgetUsed = blockSum + bufferSum;

  return {
    fixedItems,
    freeBlocks,
    budgetUsed,
    budgetMinutes,
    deferred: result.deferred,
    shrunk: result.shrunk,
    warnings: result.warnings
  };
}

module.exports = {
  allocateFlexibleWork,
  buildDaySchedule,
  buildDayOutline,
  assertNoOverlaps,
  goalRemainingUnits,
  unitsToMinutes,
  buildGoalTaskText,
  // Constants exposed for tests
  MINS_PER_COUNT_UNIT,
  MINS_PER_STEP,
  MINS_STEPLESS_SESSION,
  MINS_HABIT_SESSION,
  MIN_BLOCK_MINS,
  PRIORITY_WEIGHT
};
