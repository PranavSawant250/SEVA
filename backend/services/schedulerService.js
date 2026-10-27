/**
 * backend/services/schedulerService.js
 *
 * PURE FUNCTIONS — no DB reads, no AI calls, no system-clock reads.
 * "now" and "today" are always passed in by the caller, so tests can
 * simulate any date/time.
 *
 * ─── EXPORTS ────────────────────────────────────────────────────────────────
 *   allocateFlexibleWork(opts)  → { blocks, deferred, shrunk, warnings, duplicates, scores, behind_pace }
 *   buildDaySchedule(opts)      → plan object, OR scheduleRefusal(...) when it cannot run
 *   buildDayOutline(opts)       → { fixedItems, freeBlocks, budgetUsed, deferred, behind_pace, scores, ... }
 *   scheduleRefusal(reason)     → { refused:true, reason, message, needs_window, hint }
 *   assertNoOverlaps(plan)      — throws if a FLEXIBLE block overlaps anything
 *   enforceNoFlexibleOverlaps(plan) — safety net: moves overlapping flexible blocks out of the plan
 *
 * ─── CLOCK MODE (buildDaySchedule) ──────────────────────────────────────────
 *   Refuses (returns scheduleRefusal) for: done_for_day, no_window,
 *   window_expired (now ≥ window end), zero_budget (no free gap at all).
 *   Budget = Σ(free gap sizes) after timetable + fixed tasks.
 *   Placement:
 *     A. Blocks with a preferred start (task.time_slot, habit run slot) are
 *        pinned there if that interval is free; otherwise they fall back to
 *        the earliest gap that fits (best effort, with a warning).
 *     B. Pinned blocks split gaps into segments. Remaining blocks are assigned
 *        first-fit-decreasing: urgent/forced first, then largest block into
 *        the segment with the most free space. If nothing fits at full size
 *        the block is shrunk (goals in whole units, min 1 unit; other blocks
 *        min MIN_BLOCK_MINS); else deferred with
 *        "no gap long enough (needs X min, largest free gap Y min (Z usable after buffers))".
 *     C. Inside each segment blocks are ordered urgent/forced first, then
 *        priority high → medium → low, then floor, then longer first.
 *   Buffers are charged only BETWEEN two flexible blocks, never against a
 *   fixed item or the window edge.
 *   Fixed items overlapping each other are a USER conflict: both are kept and
 *   a "conflicts with <item>" warning is added. A flexible block overlapping
 *   anything is a scheduler bug: it is moved to deferred and logged loudly.
 *
 * ─── OUTLINE MODE (buildDayOutline) ─────────────────────────────────────────
 *   Uses the user-stated budget directly. No gaps, no clock times.
 *
 * ─── LAYER ORDER (allocateFlexibleWork) ─────────────────────────────────────
 *   2  → Urgent academic (nearest due_date first)
 *   3  → Forced (items the user explicitly named)
 *   4  → Habits (frequency goals; halved on heavy days)
 *   4b → Neglect floor (active step-less milestone goals with
 *        days_since_activity >= preferences.neglect_days [default 3]:
 *        one FLOOR_MINS=30 session/day, highest score first, max MAX_FLOOR_PER_DAY=2)
 *   5  → Goal work (score descending, with starvation caps below)
 *   6  → Flexible tasks (manual + email-derived)
 *   Task names are de-duplicated case-insensitively across layers 2, 3 and 6.
 *
 * ─── SCORING ────────────────────────────────────────────────────────────────
 *   score = priority_weight × (remaining_units / effective_days_left)
 *           × (1 + behind_by/100) × aging
 *   aging = 1 + AGING_RATE × min(days_since_activity, AGING_CAP_DAYS)
 *   Overdue goals use effective_days_left = 1.
 *
 * ─── MILESTONE UNITS ────────────────────────────────────────────────────────
 *   Goal blocks carry `units`; milestone blocks also carry `step_ids` (the
 *   next N pending steps, in order). Completing the generated task ticks
 *   EXACTLY those step_ids — implemented in Step 5.
 */

const { minutesToTimeString, parseTimeToMinutes, daysBetween } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────────────────────
// ASSUMPTIONS (tunable constants)
// ─────────────────────────────────────────────────────────────────────────────
const MINS_PER_COUNT_UNIT   = 45;   // 1 count unit (e.g. one LeetCode problem) ≈ 45 min
const MINS_PER_STEP         = 60;   // 1 milestone step ≈ 60 min
const MINS_STEPLESS_SESSION = 60;   // step-less milestone: one work session = 60 min (always 1 unit)
const MINS_HABIT_SESSION    = 30;   // one habit session (e.g. a run)
const MIN_BLOCK_MINS        = 25;   // smallest non-goal block worth scheduling
const DEFAULT_FLEX_MINS     = 30;   // flexible task without duration_min
const PRIORITY_WEIGHT       = { high: 3, medium: 2, low: 1 };

// Starvation guards
const MAX_GOAL_SHARE        = 0.5;  // ASSUMPTION: one goal may take at most 50% of the flexible
                                    // budget while another active goal is eligible. A lone goal may
                                    // use all of it. Never reduces a goal below 1 unit (otherwise a
                                    // small budget would schedule nothing at all).
const MAX_BLOCK_MINS        = 120;  // ASSUMPTION: one block per goal per day, at most 120 min, in
                                    // whole units (LeetCode 2 × 45 = 90 min; milestone 2 × 60 = 120).

// Aging (anti-starvation boost for goals not worked on recently)
const AGING_RATE            = 0.1;  // ASSUMPTION: +10% score per day since last activity
const AGING_CAP_DAYS        = 10;   // ASSUMPTION: aging stops growing after 10 days (max ×2.0)

// Neglect floor (configurable policy assumptions, NOT universal rules;
// callers may override via neglectDays, floorMins, maxFloorPerDay options)
const FLOOR_MINS            = 30;   // POLICY ASSUMPTION (configurable): 30-min floor session for neglected step-less milestone goals
const MAX_FLOOR_PER_DAY     = 2;    // POLICY ASSUMPTION (configurable): at most 2 neglect floor sessions scheduled per day
const DEFAULT_NEGLECT_DAYS  = 3;    // POLICY ASSUMPTION (configurable): default preferences.neglect_days threshold

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const LAYER_RANK    = b => {
  if (b.source === 'urgent') return 0;
  if (b.source === 'forced') return 1;
  if (b.source === 'habit')  return 2;
  if (b.floor)               return 3;
  if (b.source === 'goal')   return 4;
  return 5;
};

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isFlexible = b => b.source !== 'fixed' && b.source !== 'surprise_event';
const tierOf     = b => (b.source === 'urgent' || b.source === 'forced') ? 0 : 1;
const rankOf     = b => PRIORITY_RANK[b.priority] ?? 1;
const normName   = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const endOf      = b => b.startMinutes + b.duration;
const overlaps   = (a, b) => a.startMinutes < endOf(b) && b.startMinutes < endOf(a);

function goalRemainingUnits(goal) {
  if (goal.goal_type === 'count') return Math.max(0, (goal.target_count || 0) - (goal.current_count || 0));
  if (goal.goal_type === 'milestone') {
    const steps = goal.steps || [];
    return steps.length === 0 ? 1 : steps.filter(s => !s.done).length;
  }
  return 0; // frequency goals are handled in the habit layer
}

const isStepless = goal => goal.goal_type !== 'count' && (goal.steps || []).length === 0;

function unitMinutes(goal) {
  if (goal.goal_type === 'count') return MINS_PER_COUNT_UNIT;
  return isStepless(goal) ? MINS_STEPLESS_SESSION : MINS_PER_STEP;
}

function unitsToMinutes(goal, units) {
  return isStepless(goal) ? MINS_STEPLESS_SESSION : units * unitMinutes(goal);
}

function pendingSteps(goal) {
  return (goal.steps || []).filter(s => !s.done);
}

function buildGoalTaskText(goal, units) {
  if (goal.goal_type === 'count') return `${goal.title}: solve ${units} problem${units !== 1 ? 's' : ''}`;
  const steps = pendingSteps(goal).slice(0, units);
  if (steps.length === 0) return `${goal.title}: work session`;
  if (steps.length === 1) return `${goal.title}: next step (${steps[0].step_text})`;
  return `${goal.title}: next ${steps.length} steps (${steps.map(s => s.step_text).join(', ')})`;
}

/**
 * Build a goal block of `units` whole units.
 * Milestone blocks carry step_ids = the next `units` pending steps.
 * Completing the generated task ticks EXACTLY these step_ids (Step 5).
 */
function buildGoalBlock(goal, units) {
  const stepIds = goal.goal_type === 'milestone'
    ? pendingSteps(goal).slice(0, units).map(s => s.id)
    : [];
  return {
    task:     buildGoalTaskText(goal, units),
    priority: goal.priority,
    duration: unitsToMinutes(goal, units),
    source:   'goal',
    goal_id:  goal.id,
    task_id:  null,
    units,
    step_ids: stepIds
  };
}

function scoreGoals(goals, agingRate, agingCapDays) {
  return goals
    .filter(g => g.status === 'active' && g.goal_type !== 'frequency')
    .map(g => {
      const remaining = goalRemainingUnits(g);
      if (remaining <= 0) return null;
      const rawDaysLeft       = g.days_left ?? 30;
      const effectiveDaysLeft = Math.max(1, g.is_overdue ? 1 : rawDaysLeft);
      const dailyNeed = isStepless(g) ? 1 : Math.ceil(remaining / effectiveDaysLeft);
      const dsa   = g.days_since_activity || 0;
      const aging = 1 + agingRate * Math.min(dsa, agingCapDays);
      const pw    = PRIORITY_WEIGHT[g.priority] || 2;
      const score = pw * (remaining / effectiveDaysLeft) * (1 + (g.behind_by || 0) / 100) * aging;
      return {
        goal_id: g.id, title: g.title, priority: g.priority,
        days_left: g.is_overdue ? 'overdue' : rawDaysLeft,
        remaining, daily_need: dailyNeed, unit_minutes: unitMinutes(g),
        aging: Number(aging.toFixed(2)), score: Number(score.toFixed(3)),
        units_given: 0, minutes_given: 0, limits: [],
        _goal: g, _rawScore: score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b._rawScore - a._rawScore);
}

/** Goals that got less than their daily need. Never dropped silently. */
function behindPaceFromScores(rows) {
  return rows
    .filter(r => r.units_given < r.daily_need)
    .map(r => ({
      goal_id:      r.goal_id,
      item:         r.title,
      needed_units: r.daily_need,
      given_units:  r.units_given,
      short_units:  r.daily_need - r.units_given,
      reason:       r.limits.join('; ') || 'not scheduled'
    }));
}

const publicRows = rows => rows.map(({ _goal, _rawScore, ...rest }) => rest);

// ─────────────────────────────────────────────────────────────────────────────
// assertNoOverlaps — throws if any FLEXIBLE block overlaps anything.
// Fixed-vs-fixed overlaps are user conflicts (reported as warnings), not bugs.
// ─────────────────────────────────────────────────────────────────────────────
function assertNoOverlaps(plan) {
  const placed = plan.filter(b => b.startMinutes != null);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (!isFlexible(a) && !isFlexible(b)) continue;
      if (overlaps(a, b)) {
        throw new Error(
          `OVERLAP: "${a.task}" [${minutesToTimeString(a.startMinutes)}, ${a.duration}min) ` +
          `overlaps "${b.task}" [${minutesToTimeString(b.startMinutes)}, ${b.duration}min)`
        );
      }
    }
  }
}

/**
 * Safety net. Any flexible block that overlaps a fixed item or an earlier
 * flexible block is removed from the plan, logged loudly, and returned in
 * `quarantined` so the caller can list it as deferred. Never returns an
 * overlapping plan.
 */
function enforceNoFlexibleOverlaps(plan) {
  const kept = plan.filter(b => !isFlexible(b));
  const quarantined = [];
  const warnings = [];
  const flex = plan.filter(isFlexible).sort((a, b) => a.startMinutes - b.startMinutes);
  for (const b of flex) {
    const hit = kept.find(k => overlaps(k, b));
    if (hit) {
      const msg = `🚨 SCHEDULER BUG — flexible block "${b.task}" (${minutesToTimeString(b.startMinutes)}, ${b.duration}min) ` +
                  `overlapped "${hit.task}"; moved to deferred instead of returning an overlapping plan.`;
      console.error(msg);
      warnings.push(msg);
      quarantined.push({ item: b.task, goal_id: b.goal_id ?? null, reason: `removed: overlapped "${hit.task}" (scheduler bug, logged)` });
    } else {
      kept.push(b);
    }
  }
  kept.sort((a, b) => a.startMinutes - b.startMinutes);
  return { plan: kept, quarantined, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXED TIMELINE + GAPS
// ─────────────────────────────────────────────────────────────────────────────
function buildFixedTimeline(timetableBlocks, fixedTasks) {
  const items = [];
  for (const tb of (timetableBlocks || [])) {
    const s = parseTimeToMinutes(tb.start_time);
    const e = parseTimeToMinutes(tb.end_time);
    if (s !== null && e !== null && e > s) {
      items.push({ task: tb.subject, startMinutes: s, duration: e - s, source: 'fixed', kind: 'class', priority: 'medium', goal_id: null, task_id: null });
    }
  }
  for (const ft of (fixedTasks || [])) {
    const s = parseTimeToMinutes(ft.fixed_start);
    if (s === null) continue;
    const e = ft.fixed_end ? parseTimeToMinutes(ft.fixed_end) : null;
    const dur = e !== null ? (e - s) : (ft.duration_min || 60);
    items.push({ task: ft.name, startMinutes: s, duration: dur, source: ft.source || 'fixed', kind: 'task', priority: ft.priority || 'high', goal_id: ft.goal_id || null, task_id: ft.id || null });
  }
  return items.sort((a, b) => a.startMinutes - b.startMinutes);
}

/** Fixed-vs-fixed overlaps: user conflicts. Both are kept; warn on each pair. */
function findFixedConflicts(fixedTimeline) {
  const warnings = [];
  const conflictsWith = new Map();
  for (let i = 0; i < fixedTimeline.length; i++) {
    for (let j = i + 1; j < fixedTimeline.length; j++) {
      const a = fixedTimeline[i], b = fixedTimeline[j];
      if (!overlaps(a, b)) continue;
      warnings.push(
        `⚠️ "${b.task}" (${minutesToTimeString(b.startMinutes)}–${minutesToTimeString(endOf(b))}) conflicts with ` +
        `"${a.task}" (${minutesToTimeString(a.startMinutes)}–${minutesToTimeString(endOf(a))}) — both kept; decide which to attend.`
      );
      if (!conflictsWith.has(a)) conflictsWith.set(a, []);
      if (!conflictsWith.has(b)) conflictsWith.set(b, []);
      conflictsWith.get(a).push(b.task);
      conflictsWith.get(b).push(a.task);
    }
  }
  return { warnings, conflictsWith };
}

/** Free intervals { start, end } between nowMinutes and windowEndMinutes. */
function computeGapObjects(fixedTimeline, nowMinutes, windowEndMinutes) {
  const inWindow = fixedTimeline
    .filter(b => b.startMinutes < windowEndMinutes && endOf(b) > nowMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const gaps = [];
  let cursor = nowMinutes;
  for (const fb of inWindow) {
    const gapEnd = Math.min(fb.startMinutes, windowEndMinutes);
    if (gapEnd > cursor) gaps.push({ start: cursor, end: gapEnd });
    cursor = Math.max(cursor, endOf(fb));
  }
  if (cursor < windowEndMinutes) gaps.push({ start: cursor, end: windowEndMinutes });
  return gaps;
}

/**
 * Unified segment buffer accounting for [seg.start, seg.end]:
 * - committedBuffers: buffers already consumed before/between the k existing
 *   blocks in seg (`(k - 1) + (seg.leftFlex ? 1 : 0)` when k >= 1, else 0).
 * - rawFree: unallocated clock minutes remaining in seg after existing blocks
 *   and their committedBuffers (matches the [--- Xmin free/buffer ---] span).
 * - nextBuffers: additional buffers required to insert one more block into seg
 *   (`(seg.leftFlex ? 1 : 0) + (seg.rightFlex ? 1 : 0)` when k === 0;
 *    `1 + (seg.rightFlex ? 1 : 0)` when k >= 1).
 * - avail: usable minutes for the next block (`max(0, rawFree - nextBuffers * bufferMinutes)`).
 */
function segMetrics(seg, bufferMinutes) {
  const k = seg.blocks.length;
  const used = seg.blocks.reduce((s, b) => s + b.duration, 0);
  const committedBuffers = k === 0 ? 0 : (k - 1) + (seg.leftFlex ? 1 : 0);
  const rawFree = Math.max(0, seg.end - seg.start - used - committedBuffers * bufferMinutes);
  const nextBuffers = k === 0
    ? (seg.leftFlex ? 1 : 0) + (seg.rightFlex ? 1 : 0)
    : 1 + (seg.rightFlex ? 1 : 0);
  const avail = Math.max(0, rawFree - nextBuffers * bufferMinutes);
  return { rawFree, avail, committedBuffers, nextBuffers };
}

function segRawFree(seg, bufferMinutes) {
  return segMetrics(seg, bufferMinutes).rawFree;
}

function segAvail(seg, bufferMinutes) {
  return segMetrics(seg, bufferMinutes).avail;
}

function formatGapStats(maxRaw, maxAvail) {
  return `largest free gap ${maxRaw} min (${maxAvail} usable after buffers)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// allocateFlexibleWork
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Pure budget allocation. Does NOT assign clock times.
 * Clock mode passes Σ(gap sizes); outline mode passes the user-stated budget.
 * Buffer is charged before the 2nd, 3rd, … block.
 *
 * Test knobs (production callers leave the defaults):
 *   applyCaps   — false disables MAX_GOAL_SHARE / MAX_BLOCK_MINS (used to isolate aging)
 *   agingRate   — 0 forces aging = 1
 *   enableFloor — false disables the neglect floor (used to compare floor off vs on)
 *   neglectDays — preferences.neglect_days threshold (default 3)
 */
function allocateFlexibleWork({
  budgetMinutes,
  bufferMinutes     = 15,
  urgentTasks       = [],
  forced            = [],
  habitGoals        = [],
  goals             = [],
  flexibleTasks     = [],
  today,
  defaultUrgentMins = 90,
  runSlotStartMins  = null,
  applyCaps         = true,
  agingRate         = AGING_RATE,
  agingCapDays      = AGING_CAP_DAYS,
  neglectDays       = DEFAULT_NEGLECT_DAYS,
  enableFloor       = true
}) {
  const blocks = [], deferred = [], shrunk = [], floorSessions = [], warnings = [], duplicates = [];
  const seenNames = new Set();
  let remaining = budgetMinutes;

  const bufCost  = () => (blocks.length > 0 ? bufferMinutes : 0);
  const fits     = mins => remaining >= mins + bufCost();
  const addBlock = block => { remaining -= block.duration + bufCost(); blocks.push(block); };
  const prefOf   = t => (t.time_slot ? parseTimeToMinutes(String(t.time_slot)) : null);
  const badPref  = t => Boolean(t.time_slot && String(t.time_slot).trim() && parseTimeToMinutes(String(t.time_slot)) === null);

  function isDuplicate(name) {
    const key = normName(name);
    if (seenNames.has(key)) {
      duplicates.push({ item: name, reason: 'same task name already scheduled (case-insensitive)' });
      warnings.push(`Duplicate task "${String(name).trim()}" skipped — already scheduled once.`);
      return true;
    }
    seenNames.add(key);
    return false;
  }

  // ── LAYER 2: URGENT ACADEMIC ──────────────────────────────────────────────
  const sortedUrgent = [...urgentTasks].sort((a, b) => {
    const da = a.due_date ? daysBetween(today, a.due_date) : 999;
    const db = b.due_date ? daysBetween(today, b.due_date) : 999;
    return da - db;
  });
  for (const task of sortedUrgent) {
    if (isDuplicate(task.name)) continue;
    const dur = task.duration_min || defaultUrgentMins;
    const base = { task: task.name, priority: task.priority || 'high', source: 'urgent', task_id: task.id ?? null, goal_id: task.goal_id ?? null, preferredStartMins: prefOf(task), ...(badPref(task) ? { placeEarliest: true } : {}) };
    if (fits(dur)) {
      addBlock({ ...base, duration: dur });
    } else if (fits(MIN_BLOCK_MINS)) {
      const given = Math.max(MIN_BLOCK_MINS, Math.min(remaining - bufCost(), dur));
      addBlock({ ...base, duration: given });
      shrunk.push({ item: task.name, given, needed: dur, unit: 'min', reason: `budget tight; urgent block shrunk to ${given}min` });
    } else {
      deferred.push({ item: task.name, goal_id: task.goal_id ?? null, task_id: task.id ?? null, reason: `no budget (needs ${dur} min, have ${Math.max(0, remaining - bufCost())} min)` });
      warnings.push(`⚠️ Urgent task "${task.name}" didn't fit — budget exhausted.`);
    }
  }

  // ── LAYER 3: FORCED ───────────────────────────────────────────────────────
  for (const item of forced) {
    if (isDuplicate(item.name)) continue;
    const dur = item.duration_min || MIN_BLOCK_MINS;
    const base = { task: item.name, priority: item.priority || 'medium', source: 'forced', task_id: item.id ?? null, goal_id: item.goal_id ?? null, preferredStartMins: prefOf(item), ...(badPref(item) ? { placeEarliest: true } : {}) };
    if (fits(dur)) {
      addBlock({ ...base, duration: dur });
    } else if (fits(MIN_BLOCK_MINS)) {
      addBlock({ ...base, duration: MIN_BLOCK_MINS });
      shrunk.push({ item: item.name, given: MIN_BLOCK_MINS, needed: dur, unit: 'min', reason: `budget tight; forced item shrunk to ${MIN_BLOCK_MINS}min` });
    } else {
      deferred.push({ item: item.name, goal_id: item.goal_id ?? null, task_id: item.id ?? null, reason: `no budget even at ${MIN_BLOCK_MINS} min minimum (have ${Math.max(0, remaining - bufCost())} min)` });
      warnings.push(`⚠️ Forced item "${item.name}" couldn't fit at minimum size.`);
    }
  }

  // ── LAYER 4: HABITS ───────────────────────────────────────────────────────
  for (const habit of habitGoals) {
    if (habit.last_logged_today) continue;
    if (habit.days_this_week >= habit.per_week) continue;
    const heavyDay = remaining < budgetMinutes * 0.4;
    let dur = MINS_HABIT_SESSION;
    if (heavyDay) {
      dur = Math.max(MIN_BLOCK_MINS, Math.floor(MINS_HABIT_SESSION / 2));
      shrunk.push({ item: habit.title, given: dur, needed: MINS_HABIT_SESSION, unit: 'min', reason: 'heavy day — habit session halved' });
    }
    if (fits(dur)) {
      addBlock({ task: `${habit.title}: session`, priority: 'medium', duration: dur, source: 'habit', goal_id: habit.id, task_id: null, preferredStartMins: runSlotStartMins });
    } else {
      deferred.push({ item: habit.title, goal_id: habit.id ?? null, reason: `no budget for ${dur} min habit session (have ${Math.max(0, remaining - bufCost())} min)` });
      warnings.push(`Habit "${habit.title}" skipped — not enough budget.`);
    }
  }

  // ── Score active non-frequency goals once (highest score first) ───────────
  const rows = scoreGoals(goals, agingRate, agingCapDays);
  const eligibleCount = rows.length;

  // ── LAYER 4b: NEGLECT FLOOR (step-less milestone goals with dsa >= neglectDays)
  // Placed after urgent, forced and habit blocks and BEFORE score-ranked goal work.
  // Highest score first; goals beyond MAX_FLOOR_PER_DAY stay deferred.
  if (enableFloor) {
    let floorUsed = 0;
    for (const row of rows) {
      const goal = row._goal;
      if (goal.goal_type !== 'milestone' || !isStepless(goal)) continue;
      const dsa = goal.days_since_activity || 0;
      if (dsa < neglectDays) continue;

      row.is_floor_candidate = true;
      row.cap_units = 1;

      if (floorUsed >= MAX_FLOOR_PER_DAY) {
        const reason = `neglect floor limit reached (max ${MAX_FLOOR_PER_DAY} floor sessions/day)`;
        row.limits.push(reason);
        deferred.push({ item: goal.title, goal_id: goal.id, floor: true, reason });
        continue;
      }
      floorUsed++;

      if (fits(FLOOR_MINS)) {
        const block = {
          task:     buildGoalTaskText(goal, 1),
          priority: goal.priority,
          duration: FLOOR_MINS,
          source:   'goal',
          floor:    true,
          goal_id:  goal.id,
          task_id:  null,
          units:    1,
          step_ids: []
        };
        addBlock(block);
        row.units_given   = 1;
        row.minutes_given = FLOOR_MINS;
        row.limits.push(`neglect floor: ${FLOOR_MINS} min session (${dsa}d inactive >= ${neglectDays}d)`);
        floorSessions.push({
          item: goal.title, goal_id: goal.id,
          duration: FLOOR_MINS, needed: MINS_STEPLESS_SESSION, days_since_activity: dsa,
          reason: `short ${FLOOR_MINS}-min session to keep ${goal.title} moving (${dsa}d inactive)`
        });
      } else {
        const reason = `no budget for ${FLOOR_MINS} min floor session (${FLOOR_MINS} min + ${bufCost()} min buffer, have ${remaining} min)`;
        row.limits.push(`budget: ${reason}`);
        deferred.push({ item: goal.title, goal_id: goal.id, floor: true, want_units: 1, min_needed: FLOOR_MINS, reason });
      }
    }
  }

  // ── LAYER 5: GOAL WORK (with starvation caps) ─────────────────────────────
  for (const row of rows) {
    if (row.is_floor_candidate) continue;
    const goal  = row._goal;
    const uMins = row.unit_minutes;
    let capUnits = row.daily_need;

    if (applyCaps) {
      const blockCapUnits = Math.max(1, Math.floor(MAX_BLOCK_MINS / uMins));
      if (blockCapUnits < capUnits) {
        capUnits = blockCapUnits;
        row.limits.push(`MAX_BLOCK_MINS: one ${MAX_BLOCK_MINS}-min block/day = ${blockCapUnits} unit(s)`);
      }
      if (eligibleCount > 1) {
        const shareUnits = Math.max(1, Math.floor((MAX_GOAL_SHARE * budgetMinutes) / uMins));
        if (shareUnits < capUnits) {
          capUnits = shareUnits;
          row.limits.push(`MAX_GOAL_SHARE: ≤${MAX_GOAL_SHARE * 100}% of ${budgetMinutes}min = ${shareUnits} unit(s)`);
        }
      }
    }
    row.cap_units = capUnits;

    let units = capUnits;
    while (units > 0 && !fits(unitsToMinutes(goal, units))) units--;

    if (units === 0) {
      const reason = `no budget for 1 unit (${uMins} min + ${bufCost()} min buffer, have ${remaining} min)`;
      row.limits.push(`budget: ${reason}`);
      deferred.push({ item: goal.title, goal_id: goal.id, want_units: capUnits, reason });
      continue;
    }
    if (units < capUnits) {
      const reason = `budget: only ${units} of ${capUnits} unit(s) fit (${remaining} min left)`;
      row.limits.push(reason);
      shrunk.push({ item: goal.title, goal_id: goal.id, given: units, needed: capUnits, unit: 'units', reason });
    }
    const block = buildGoalBlock(goal, units);
    addBlock(block);
    row.units_given   = units;
    row.minutes_given = block.duration;
  }

  // ── LAYER 6: FLEXIBLE TASKS (manual + email-derived) ──────────────────────
  for (const t of flexibleTasks) {
    if (isDuplicate(t.name)) continue;
    const dur = t.duration_min || DEFAULT_FLEX_MINS;
    const block = {
      task: String(t.name).trim(), priority: t.priority || 'medium', duration: dur,
      source: 'flexible', origin: t.source || 'manual',
      task_id: t.id ?? null, goal_id: t.goal_id ?? null, preferredStartMins: prefOf(t),
      ...(badPref(t) ? { placeEarliest: true } : {})
    };
    if (fits(dur)) {
      addBlock(block);
    } else {
      deferred.push({ item: block.task, reason: `no budget (needs ${dur} min, have ${remaining - bufCost()} min)` });
    }
  }

  return {
    blocks, deferred, shrunk, floorSessions, warnings, duplicates,
    scoreRows: rows,                          // internal (mutable) rows for buildDaySchedule
    scores: publicRows(rows),
    behind_pace: behindPaceFromScores(rows)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDaySchedule
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Full clock-mode scheduler. See file header for the algorithm.
 *
 * @param {object} opts
 *   today            "YYYY-MM-DD" (injected)
 *   nowMinutes       current time, minutes since midnight (injected)
 *   windowEndMinutes end of today's work window, or null if not set
 *   doneForDay       true if the user said they are done for today
 *   timetableBlocks  [{subject, start_time, end_time}]
 *   fixedTasks       [{name, fixed_start, fixed_end, duration_min, priority, id, goal_id}]
 *   flexibleTasks    [{id, name, duration_min, time_slot, priority, source:'manual'|'email'}]
 *   + all allocateFlexibleWork options
 *
 * @returns scheduleRefusal(...) or
 *   { refused:false, today, nowMinutes, windowEndMinutes, budgetMinutes, plan,
 *     deferred, shrunk, warnings, duplicates, behind_pace, scores, gapSummary }
 */
function buildDaySchedule({
  today,
  nowMinutes,
  windowEndMinutes,
  doneForDay        = false,
  timetableBlocks   = [],
  fixedTasks        = [],
  bufferMinutes     = 15,
  urgentTasks       = [],
  forced            = [],
  habitGoals        = [],
  goals             = [],
  flexibleTasks     = [],
  defaultUrgentMins = 90,
  runSlotStartMins  = null,
  applyCaps         = true,
  agingRate         = AGING_RATE,
  agingCapDays      = AGING_CAP_DAYS,
  neglectDays       = DEFAULT_NEGLECT_DAYS,
  enableFloor       = true
}) {
  // ── Refusals ──────────────────────────────────────────────────────────────
  if (doneForDay)                     return scheduleRefusal('done_for_day');
  if (windowEndMinutes == null)       return scheduleRefusal('no_window');
  if (nowMinutes >= windowEndMinutes) return scheduleRefusal('window_expired');

  // ── Fixed timeline, conflicts, gaps ───────────────────────────────────────
  const fixedTimeline = buildFixedTimeline(timetableBlocks, fixedTasks);
  const { warnings: conflictWarnings, conflictsWith } = findFixedConflicts(fixedTimeline);
  const gaps = computeGapObjects(fixedTimeline, nowMinutes, windowEndMinutes);
  const budgetMinutes = gaps.reduce((s, g) => s + (g.end - g.start), 0);
  if (budgetMinutes === 0) return scheduleRefusal('zero_budget');

  const gapSummary = gaps.map(g => ({
    start_time: minutesToTimeString(g.start), end_time: minutesToTimeString(g.end), size_min: g.end - g.start
  }));

  // ── Allocate against Σ gaps ───────────────────────────────────────────────
  const alloc = allocateFlexibleWork({
    budgetMinutes, bufferMinutes, urgentTasks, forced, habitGoals, goals, flexibleTasks,
    today, defaultUrgentMins, runSlotStartMins, applyCaps, agingRate, agingCapDays,
    neglectDays, enableFloor
  });
  const rows     = alloc.scoreRows;
  const rowById  = new Map(rows.map(r => [r.goal_id, r]));
  const goalById = new Map(goals.map(g => [g.id, g]));
  const deferred = [...alloc.deferred];
  const shrunk   = [...alloc.shrunk];
  const floorSessions = [...alloc.floorSessions];
  const warnings = [...conflictWarnings, ...alloc.warnings];

  function shrinkToFit(block, avail) {
    if (block.floor) return avail >= FLOOR_MINS ? { ...block, duration: FLOOR_MINS } : null;
    const goal = block.source === 'goal' ? goalById.get(block.goal_id) : null;
    if (goal) {
      const units = isStepless(goal)
        ? (avail >= MINS_STEPLESS_SESSION ? 1 : 0)
        : Math.min(block.units, Math.floor(avail / unitMinutes(goal)));
      return units >= 1 ? buildGoalBlock(goal, units) : null;
    }
    if (avail < MIN_BLOCK_MINS) return null;
    return { ...block, duration: Math.min(block.duration, avail) };
  }
  const minNeeded = block => {
    if (block.floor) return FLOOR_MINS;
    const goal = block.source === 'goal' ? goalById.get(block.goal_id) : null;
    return goal ? unitMinutes(goal) : MIN_BLOCK_MINS;
  };

  // ── A. Pin preferred-time blocks ──────────────────────────────────────────
  const ordered = [...alloc.blocks].sort((a, b) => LAYER_RANK(a) - LAYER_RANK(b) || rankOf(a) - rankOf(b));
  const pinned = [];
  const floating = [];
  for (const b of ordered) {
    if (b.preferredStartMins == null) { floating.push(b); continue; }
    const p = b.preferredStartMins, e = p + b.duration;
    const gap = gaps.find(g => g.start <= p && e <= g.end);
    const clash = gap && pinned.some(q => q.gap === gap && p < q.end + bufferMinutes && q.start < e + bufferMinutes);
    if (gap && !clash) {
      pinned.push({ block: b, gap, start: p, end: e });
    } else {
      floating.push({ ...b, placeEarliest: true });
      warnings.push(`Preferred time ${minutesToTimeString(p)} for "${b.task}" is not free — placed in the earliest gap that fits instead.`);
    }
  }

  // ── B. Segments (gaps split by pinned blocks), FFD assignment ────────────
  function buildSegments() {
    const segs = [];
    for (const g of gaps) {
      const pins = pinned.filter(x => x.gap === g).sort((a, b) => a.start - b.start);
      let cur = g.start, leftFlex = false;
      for (const pn of pins) {
        segs.push({ start: cur, end: pn.start, leftFlex, rightFlex: true, blocks: [] });
        cur = pn.end; leftFlex = true;
      }
      segs.push({ start: cur, end: g.end, leftFlex, rightFlex: false, blocks: [] });
    }
    return segs;
  }

  let segments = buildSegments();

  function assignOn(segs, block) {
    const ranked = segs.map(s => ({
      s,
      avail: segAvail(s, bufferMinutes),
      raw:   segRawFree(s, bufferMinutes)
    }));
    const bySize = [...ranked].sort((a, b) => b.avail - a.avail || b.raw - a.raw);
    const best = bySize[0];
    const maxAvail = best ? best.avail : 0;
    const maxRaw   = ranked.reduce((m, r) => Math.max(m, r.raw), 0);
    const target = block.placeEarliest
      ? ranked.find(r => r.avail >= block.duration)
      : (best && best.avail >= block.duration ? best : null);
    if (target) { target.s.blocks.push(block); return { placed: block, maxAvail, maxRaw }; }
    const small = best ? shrinkToFit(block, maxAvail) : null;
    if (small) { best.s.blocks.push(small); return { placed: small, maxAvail, maxRaw, shrunkFrom: block.duration }; }
    return { placed: null, maxAvail, maxRaw };
  }

  const assign = block => assignOn(segments, block);

  // Try FFD first (packs larger blocks before smaller ones into multi-gap days);
  // if FFD places every allocated block at full size, use it. Otherwise fall back
  // to strict layer order (urgent → forced → habit → floor → goal → flexible).
  const ffdOrder   = [...floating].sort((a, b) => tierOf(a) - tierOf(b) || b.duration - a.duration);
  const trialSegs  = buildSegments();
  const ffdPerfect = ffdOrder.every(b => {
    const res = assignOn(trialSegs, b);
    return res.placed && !res.shrunkFrom;
  });
  const packOrder  = ffdPerfect
    ? ffdOrder
    : [...floating].sort((a, b) => LAYER_RANK(a) - LAYER_RANK(b) || b.duration - a.duration);

  for (const block of packOrder) {
    const r = assign(block);
    const row = block.source === 'goal' ? rowById.get(block.goal_id) : null;
    if (r.placed && r.shrunkFrom) {
      const gapDesc = formatGapStats(r.maxRaw, r.maxAvail);
      if (row) {
        const lim = `placement: no gap fits ${r.shrunkFrom} min (${gapDesc}) → ${r.placed.units} unit(s)`;
        row.limits.push(lim);
        shrunk.push({ item: block.task, goal_id: block.goal_id, given: r.placed.duration, needed: r.shrunkFrom, unit: 'min', reason: `no gap long enough for ${r.shrunkFrom} min (${gapDesc})` });
      } else {
        shrunk.push({ item: block.task, given: r.placed.duration, needed: r.shrunkFrom, unit: 'min', reason: `no gap long enough for ${r.shrunkFrom} min (${gapDesc})` });
      }
    } else if (!r.placed) {
      const reason = `no gap long enough (needs ${minNeeded(block)} min, ${formatGapStats(r.maxRaw, r.maxAvail)})`;
      deferred.push({ item: block.task, goal_id: block.goal_id ?? null, floor: !!block.floor, reason });
      if (block.floor) {
        const fi = floorSessions.findIndex(f => f.goal_id === block.goal_id);
        if (fi !== -1) floorSessions.splice(fi, 1);
      }
      if (row) row.limits.push(`placement: ${reason}`);
    }
  }

  // ── B2. Second chance for goals the budget pass deferred ─────────────────
  // The budget pass charges a buffer per block; on the clock buffers only fall
  // between blocks in the same segment, so leftover gap time may still fit.
  for (const d of [...deferred]) {
    const goal = d.want_units ? goalById.get(d.goal_id) : null;
    if (!goal) continue;
    const row = rowById.get(goal.id);
    const candidateBlock = d.floor
      ? { task: buildGoalTaskText(goal, 1), priority: goal.priority, duration: FLOOR_MINS, source: 'goal', floor: true, goal_id: goal.id, task_id: null, units: 1, step_ids: [] }
      : buildGoalBlock(goal, d.want_units);
    const r = assign(candidateBlock);
    const gapDesc = formatGapStats(r.maxRaw, r.maxAvail);
    if (r.placed) {
      deferred.splice(deferred.indexOf(d), 1);
      row.limits = row.limits.filter(l => !l.startsWith('budget:'));
      if (d.floor) {
        const dsa = goal.days_since_activity || 0;
        floorSessions.push({
          item: goal.title, goal_id: goal.id,
          duration: FLOOR_MINS, needed: MINS_STEPLESS_SESSION, days_since_activity: dsa,
          reason: `short ${FLOOR_MINS}-min session to keep ${goal.title} moving (${dsa}d inactive)`
        });
      } else if (r.placed.units < d.want_units) {
        const lim = `placement: leftover gap (${gapDesc}) fits ${r.placed.units} of ${d.want_units} unit(s)`;
        row.limits.push(lim);
        shrunk.push({ item: goal.title, goal_id: goal.id, given: r.placed.units, needed: d.want_units, unit: 'units', reason: lim });
      }
    } else {
      const needMins = d.floor ? FLOOR_MINS : unitMinutes(goal);
      d.reason = `no gap long enough (needs ${needMins} min, ${gapDesc})`;
      row.limits = row.limits.filter(l => !l.startsWith('budget:'));
      row.limits.push(`placement: ${d.reason}`);
    }
  }

  // ── C. Layout: order inside each segment by tier, priority, floor, length ─
  const placed = pinned.map(pn => ({ ...pn.block, startMinutes: pn.start, time: minutesToTimeString(pn.start), pinned: true }));
  for (const seg of segments) {
    const inOrder = [...seg.blocks].sort((a, b) =>
      tierOf(a) - tierOf(b) ||
      rankOf(a) - rankOf(b) ||
      (b.floor ? 1 : 0) - (a.floor ? 1 : 0) ||
      b.duration - a.duration
    );
    let cur = seg.start + (seg.leftFlex ? bufferMinutes : 0);
    for (const b of inOrder) {
      const { placeEarliest, ...clean } = b;
      placed.push({ ...clean, startMinutes: cur, time: minutesToTimeString(cur) });
      cur += b.duration + bufferMinutes;
    }
  }

  // ── Safety net + final assertion ─────────────────────────────────────────
  const fixedPlan = fixedTimeline.map(f => ({
    ...f, time: minutesToTimeString(f.startMinutes),
    ...(conflictsWith.has(f) ? { conflicts_with: conflictsWith.get(f) } : {})
  }));
  const guard = enforceNoFlexibleOverlaps([...fixedPlan, ...placed]);
  deferred.push(...guard.quarantined);
  warnings.push(...guard.warnings);
  const plan = guard.plan;
  assertNoOverlaps(plan); // cannot fire after the guard; kept as a tripwire

  // ── Final per-goal accounting (behind pace) ──────────────────────────────
  for (const row of rows) {
    const mine = plan.filter(b => b.source === 'goal' && b.goal_id === row.goal_id);
    row.units_given   = mine.reduce((s, b) => s + b.units, 0);
    row.minutes_given = mine.reduce((s, b) => s + b.duration, 0);
  }

  return {
    refused: false, today, nowMinutes, windowEndMinutes, budgetMinutes,
    plan, deferred, shrunk, floorSessions, warnings, duplicates: alloc.duplicates,
    behind_pace: behindPaceFromScores(rows),
    scores: publicRows(rows),
    gapSummary
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDayOutline
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Outline mode (future day — user-stated budget, no clock times).
 * Timetable classes are listed separately and do NOT consume the budget.
 * Buffers between free blocks DO consume budget. Same caps as clock mode.
 * Preferred times (time_slot / run slot) are ignored here.
 */
function buildDayOutline({
  today,
  budgetMinutes,
  bufferMinutes     = 15,
  timetableBlocks   = [],
  urgentTasks       = [],
  forced            = [],
  habitGoals        = [],
  goals             = [],
  flexibleTasks     = [],
  defaultUrgentMins = 90,
  applyCaps         = true,
  agingRate         = AGING_RATE,
  agingCapDays      = AGING_CAP_DAYS,
  neglectDays       = DEFAULT_NEGLECT_DAYS,
  enableFloor       = true
}) {
  const fixedItems = (timetableBlocks || []).map(tb => ({
    task: tb.subject, start_time: tb.start_time, end_time: tb.end_time, source: 'fixed'
  }));

  const result = allocateFlexibleWork({
    budgetMinutes, bufferMinutes, urgentTasks, forced, habitGoals, goals, flexibleTasks,
    today, defaultUrgentMins, runSlotStartMins: null, applyCaps, agingRate, agingCapDays,
    neglectDays, enableFloor
  });

  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const freeBlocks = result.blocks.map((b, i) => ({
    label:    letters[i] || String(i + 1),
    task:     b.task,
    duration: b.duration,
    source:   b.source,
    priority: b.priority,
    goal_id:  b.goal_id ?? null,
    ...(b.floor ? { floor: true } : {}),
    ...(b.source === 'goal' ? { units: b.units, step_ids: b.step_ids } : {})
  }));

  const blockSum   = result.blocks.reduce((s, b) => s + b.duration, 0);
  const bufferSum  = Math.max(0, result.blocks.length - 1) * bufferMinutes;
  const budgetUsed = blockSum + bufferSum;

  return {
    today, fixedItems, freeBlocks, budgetUsed, budgetMinutes,
    deferred: result.deferred, shrunk: result.shrunk, floorSessions: result.floorSessions,
    warnings: result.warnings, duplicates: result.duplicates,
    behind_pace: result.behind_pace, scores: result.scores
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// scheduleRefusal
// ─────────────────────────────────────────────────────────────────────────────
function scheduleRefusal(reason) {
  const messages = {
    no_window:      'No daily window is set. Tell me: "free till 9 PM" or "I have 4 hours".',
    window_expired: 'Your work window has already passed for today.',
    done_for_day:   'You marked yourself as done for today — no more scheduling.',
    zero_budget:    'No free time remains in your current window.'
  };
  return {
    refused:      true,
    reason,
    needs_window: reason === 'no_window',
    message:      messages[reason] || `Scheduling refused: ${reason}`,
    hint:         reason === 'no_window' ? 'Say "free till 9 PM" or "I have 4 hours" to set your window.' : null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  allocateFlexibleWork,
  buildDaySchedule,
  buildDayOutline,
  scheduleRefusal,
  assertNoOverlaps,
  enforceNoFlexibleOverlaps,
  // Helpers exported for tests
  goalRemainingUnits,
  unitsToMinutes,
  buildGoalTaskText,
  buildGoalBlock,
  buildFixedTimeline,
  computeGapObjects,
  segMetrics,
  segRawFree,
  segAvail,
  // Constants
  MINS_PER_COUNT_UNIT,
  MINS_PER_STEP,
  MINS_STEPLESS_SESSION,
  MINS_HABIT_SESSION,
  MIN_BLOCK_MINS,
  DEFAULT_FLEX_MINS,
  PRIORITY_WEIGHT,
  MAX_GOAL_SHARE,
  MAX_BLOCK_MINS,
  AGING_RATE,
  AGING_CAP_DAYS,
  FLOOR_MINS,
  MAX_FLOOR_PER_DAY,
  DEFAULT_NEGLECT_DAYS
};
