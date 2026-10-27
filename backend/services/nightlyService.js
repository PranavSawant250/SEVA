/**
 * backend/services/nightlyService.js
 *
 * Step 10 — Deterministic Nightly Check-In ("plan tomorrow").
 * 100% deterministic code, ZERO AI calls.
 *
 * Session state is stored in server memory via chatCommands' single pending slot
 * (resets if the server restarts; expires after 30 minutes of inactivity).
 * Starting a check-in cancels any pending removal confirmation and says so;
 * starting a removal confirmation cancels any active check-in.
 *
 * All functions accept an injected `todayDateObj` (Date) for testability (Rule 8).
 * Never hardcodes a user's name — reads `preferences.user_name` (Rule 9).
 */

const db = require('../database/db');
const {
  getTodayDate,
  getTomorrowDate,
  getTomorrowDayOfWeek,
  parseTimeToMinutes,
  minutesToTimeString
} = require('../utils/dateUtils');
const { getAllGoals } = require('./goalsService');
const {
  buildDayOutline,
  buildGoalBlock
} = require('./schedulerService');
const {
  getPendingState,
  setPendingState,
  clearPending,
  consumeActivePendingCancellationNotice,
  getUserName
} = require('./chatCommands');

const CHECKIN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────
// REPLY GRAMMAR CONSTANTS TABLE (English + Hinglish, no AI)
// ─────────────────────────────────────────────────────────────
const GRAMMAR = {
  // Trigger phrases for starting the nightly check-in
  RE_TRIGGER: /\b(?:plan(?:\s+(?:my|for))?\s+tomorrow|tomorrow(?:'s)?\s+plan|raw\s+plan\s+for\s+tomorrow)\b/i,

  // Budget reply in phase 'await_budget': "5 hours", "5h", "90 minutes", "90 min", "1.5 hours"
  RE_BUDGET: /^\s*(?:i\s+have\s+|about\s+|around\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i,

  // Cancel words
  CANCEL_WORDS: new Set(['cancel', 'abort', 'quit', 'exit', 'stop', 'band karo']),

  // Confirm / save words
  DONE_WORDS: new Set(['done', 'confirm', 'looks good', 'save', 'theek hai', 'pakka', 'finalize']),

  // None / skip words
  NONE_WORDS: new Set(['none', 'no', 'nahi', 'nahin', 'nothing', 'skip', 'kuch nahi']),

  // Add all words
  ADD_ALL_PHRASES: new Set([
    'add all',
    'add sab',
    'haan add sab',
    'yes add all',
    'sab add karo',
    'include all'
  ]),

  // "add 1, 3" / "add 1 and 3" / "add 1 3"
  RE_ADD_NUMBERS: /^\s*(?:haan\s+|yes\s+|ok\s+)?add\s+([\d\s,and&]+)\s*$/i,

  // "also add <task text> [for <N> min|hour(s)] [at <time>] [priority high|medium|low]"
  RE_ALSO_ADD: /^\s*also\s+add\s+(.+?)\s*$/i,

  // "add <title fragment>" (checked after add all & add numbers)
  RE_ADD_FRAGMENT: /^\s*add\s+(.+?)\s*$/i
};

function matchesPlanTomorrowTrigger(text) {
  if (!text || typeof text !== 'string') return false;
  return GRAMMAR.RE_TRIGGER.test(text.trim());
}

/**
 * Parses a budget string like "5 hours", "5h", "90 minutes", "90 min", "1.5 hours".
 * Bounds: 15 minutes to 960 minutes (16 hours).
 * Returns { ok: true, minutes } or { ok: false, error }.
 */
function parseBudgetInput(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: `Please tell me how much free time you have tomorrow (e.g. '5 hours', '5h', '90 minutes', or '1.5 hours'), or reply 'cancel'.` };
  }
  const m = text.trim().match(GRAMMAR.RE_BUDGET);
  if (!m) {
    return { ok: false, error: `I couldn't parse a time budget from "${text.trim()}". Try something like '5 hours', '5h', '90 min', or '1.5 hours' (or reply 'cancel').` };
  }
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const minutes = unit.startsWith('h') ? Math.round(val * 60) : Math.round(val);

  if (isNaN(minutes) || minutes < 15 || minutes > 960) {
    return { ok: false, error: `That budget (${minutes} min) is outside the valid range (15 minutes to 16 hours / 960 minutes). Please enter a budget between 15 min and 16 hours.` };
  }
  return { ok: true, minutes };
}

/**
 * Parses "also add <task text> [for <N> min|hour(s)] [at <time>] [priority high|medium|low]"
 * in pure deterministic code.
 * Defaults: duration_min = 30, priority = 'medium', time_slot = null.
 */
function parseAlsoAddClause(rawAfterAlsoAdd) {
  let working = rawAfterAlsoAdd.trim();
  let durationMin = 30;
  let priority = 'medium';
  let timeSlot = null;

  // Extract [priority high|medium|low]
  const mPrio = working.match(/\bpriority\s+(high|medium|low)\b/i);
  if (mPrio) {
    priority = mPrio[1].toLowerCase();
    working = working.replace(mPrio[0], ' ').trim();
  }

  // Extract [at <time>] e.g. "at 4 PM", "at 4:30 PM", "at 9AM"
  const mAt = working.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i);
  if (mAt) {
    const parsedMins = parseTimeToMinutes(mAt[1]);
    if (parsedMins !== null) {
      timeSlot = minutesToTimeString(parsedMins);
    }
    working = working.replace(mAt[0], ' ').trim();
  }

  // Extract [for <N> min|minutes|hour|hours|hr|hrs|h|m]
  const mFor = working.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (mFor) {
    const amt = parseFloat(mFor[1]);
    const unit = mFor[2].toLowerCase();
    const mins = unit.startsWith('h') ? Math.round(amt * 60) : Math.round(amt);
    if (!isNaN(mins) && mins >= 5 && mins <= 480) {
      durationMin = mins;
    }
    working = working.replace(mFor[0], ' ').trim();
  }

  const cleanTitle = working.replace(/\s+/g, ' ').trim();
  if (!cleanTitle) {
    return { ok: false, error: `Please provide a task name after "also add", e.g. "also add Buy groceries for 45 min priority high".` };
  }

  return {
    ok: true,
    task: {
      id: `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: cleanTitle.substring(0, 200),
      duration_min: durationMin,
      priority,
      time_slot: timeSlot
    }
  };
}

/**
 * Gathers inputs and calls buildDayOutline for tomorrow.
 */
function computeTomorrowOutline(session, todayDateObj) {
  const prefs = db.prepare('SELECT * FROM preferences WHERE id = 1').get() || {};
  const neglectDays = prefs.neglect_days ?? 3;
  const bufferMinutes = prefs.buffer_minutes ?? 15;
  const defaultUrgentMins = prefs.default_urgent_minutes ?? 90;

  const timetableBlocks = db.prepare(`
    SELECT day_of_week, subject, start_time, end_time
    FROM timetable
    WHERE day_of_week = ?
    ORDER BY start_time ASC
  `).all(session.tomorrowWeekday);

  // All goals as of today
  const allGoals = getAllGoals(todayDateObj).filter(g => g.status === 'active');
  const habitGoals = allGoals
    .filter(g => g.goal_type === 'frequency' && !session.acceptedGoalIds.has(g.id))
    .map(g => ({ ...g, last_logged_today: false }));
  const nonForcedGoals = allGoals.filter(
    g => g.goal_type !== 'frequency' && !session.acceptedGoalIds.has(g.id)
  );

  // Build forced items array (Layer 3) from accepted goals, accepted tasks, and custom tasks
  const forced = [];

  for (const goalId of session.acceptedGoalIds) {
    const g = allGoals.find(x => x.id === goalId);
    if (!g) continue;
    if (g.goal_type === 'frequency') {
      forced.push({
        id: null,
        goal_id: g.id,
        name: `${g.title}: session`,
        priority: g.priority || 'medium',
        duration_min: 30
      });
    } else {
      const gb = buildGoalBlock(g, 1);
      forced.push({
        id: null,
        goal_id: g.id,
        name: gb.task,
        priority: g.priority || 'high',
        duration_min: gb.duration
      });
    }
  }

  for (const taskId of session.acceptedTaskIds) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (row) {
      forced.push({
        id: row.id,
        goal_id: null,
        name: row.name,
        priority: row.priority || 'medium',
        duration_min: row.duration_min || 30,
        time_slot: row.time_slot || null
      });
    }
  }

  for (const ct of session.customTasks) {
    forced.push({
      id: ct.id,
      goal_id: null,
      name: ct.name,
      priority: ct.priority || 'medium',
      duration_min: ct.duration_min || 30,
      time_slot: ct.time_slot || null
    });
  }

  // Pass enableFloor: false in the nightly check-in outline so neglected goals that
  // get squeezed out by score are surfaced in the numbered Suggestion List for the
  // user to review and explicitly force in.
  const outline = buildDayOutline({
    today: session.tomorrowDate,
    budgetMinutes: session.budgetMinutes,
    bufferMinutes,
    timetableBlocks,
    urgentTasks: [],
    forced,
    habitGoals,
    goals: nonForcedGoals,
    flexibleTasks: [],
    defaultUrgentMins,
    neglectDays,
    enableFloor: false
  });

  return { outline, allGoals, neglectDays };
}

/**
 * Builds the deterministic, de-duplicated Pending & Neglected Suggestion List (max 5).
 * Numbered 1..n ONCE when first entering phase 'review' and NEVER renumbered.
 *
 * Priority order:
 *  1. Active goals that did NOT fit in the initial outline (deferred) — "didn't fit in <N>h (<reason>)"
 *  2. Active goals with days_since_activity >= neglect_days — "no progress in <X> days"
 *  3. Overdue active goals not already in the outline — "overdue since <deadline> (<progress>%)"
 *  4. Active goals with behind_by >= 20 not already in the outline — "<behind_by>% behind pace (<progress>% vs <expected>%)"
 *  5. Incomplete tasks (date <= today, goal_id IS NULL), de-duplicated by case-insensitive name (keep most recent row only) — "incomplete task from <date> (<priority>)"
 */
function buildInitialSuggestions(outline, allGoals, neglectDays, budgetMinutes, todayStr) {
  const suggestions = [];
  const seenGoalIds = new Set();
  const scheduledGoalIds = new Set(
    (outline.freeBlocks || [])
      .filter(b => b.goal_id != null)
      .map(b => b.goal_id)
  );
  const budgetHoursLabel = `${+(budgetMinutes / 60).toFixed(1)}h`;

  const pushGoalSuggestion = (goal, reason) => {
    if (suggestions.length >= 5) return;
    if (seenGoalIds.has(goal.id)) return;
    seenGoalIds.add(goal.id);
    suggestions.push({
      number: suggestions.length + 1,
      kind: 'goal',
      goal_id: goal.id,
      title: goal.title,
      priority: goal.priority,
      reason,
      accepted: false
    });
  };

  // 1. Active goals that did NOT fit in the outline (deferred)
  // Prioritize deferred goals that are also neglected (days_since_activity >= neglectDays) first
  const deferredGoalEntries = (outline.deferred || [])
    .filter(def => def.goal_id != null)
    .map(def => ({ def, goal: allGoals.find(x => x.id === def.goal_id) }))
    .filter(x => x.goal)
    .sort((a, b) => {
      const aNeg = a.goal.days_since_activity >= neglectDays ? 0 : 1;
      const bNeg = b.goal.days_since_activity >= neglectDays ? 0 : 1;
      return aNeg - bNeg;
    });

  for (const { def, goal: g } of deferredGoalEntries) {
    const neglectSuffix = g.days_since_activity >= neglectDays
      ? `, no progress in ${g.days_since_activity} days`
      : '';
    pushGoalSuggestion(g, `didn't fit in ${budgetHoursLabel} (${def.reason}${neglectSuffix})`);
  }

  // 2. Active goals with days_since_activity >= neglect_days
  for (const g of allGoals) {
    if (g.progress >= 100) continue;
    if (g.days_since_activity >= neglectDays) {
      pushGoalSuggestion(g, `no progress in ${g.days_since_activity} days`);
    }
  }

  // 3. Overdue active goals not already in the outline
  for (const g of allGoals) {
    if (g.progress >= 100) continue;
    if (g.is_overdue && !scheduledGoalIds.has(g.id)) {
      pushGoalSuggestion(g, `overdue since ${g.deadline} (${g.progress}%)`);
    }
  }

  // 4. Active goals with behind_by >= 20 not already in the outline
  for (const g of allGoals) {
    if (g.progress >= 100 || g.progress_source === 'no_progress_data') continue;
    if (g.behind_by >= 20 && !scheduledGoalIds.has(g.id)) {
      pushGoalSuggestion(g, `${g.behind_by}% behind pace (${g.progress}% vs ${g.expected_progress}%)`);
    }
  }

  // 5. Incomplete standalone tasks (date <= today, goal_id IS NULL), de-duplicated by case-insensitive name (keep most recent row)
  if (suggestions.length < 5) {
    const rawTasks = db.prepare(`
      SELECT id, name, priority, date, duration_min, time_slot
      FROM tasks
      WHERE completed = 0 AND goal_id IS NULL AND date <= ?
      ORDER BY date DESC, id DESC
    `).all(todayStr);

    const seenTaskNames = new Set();
    for (const t of rawTasks) {
      if (suggestions.length >= 5) break;
      const norm = (t.name || '').trim().toLowerCase();
      if (!norm || seenTaskNames.has(norm)) continue;
      seenTaskNames.add(norm);
      suggestions.push({
        number: suggestions.length + 1,
        kind: 'task',
        task_id: t.id,
        title: t.name.trim(),
        priority: t.priority || 'medium',
        date: t.date,
        reason: `incomplete task from ${t.date} (${t.priority || 'medium'})`,
        accepted: false
      });
    }
  }

  return suggestions;
}

/**
 * Formats the review message showing the rough outline, shrunk/deferred notices,
 * and the numbered suggestions (preserving original numbers 1..n).
 */
function formatReviewMessage(session, headerNote = '') {
  const { outline } = session.lastOutlineResult;
  const blocks = outline.freeBlocks || [];
  const usedMins = outline.budgetUsed ?? blocks.reduce((acc, b) => acc + (b.duration || 0), 0);
  const lines = [];

  if (headerNote) {
    lines.push(headerNote);
    lines.push('');
  }

  lines.push(`📋 Rough Outline for Tomorrow (${session.tomorrowWeekday}, ${session.tomorrowDate}) — Budget: ${session.budgetMinutes} min (${usedMins} min used incl. buffers):`);
  if (blocks.length === 0) {
    lines.push('  • (No blocks scheduled yet)');
  } else {
    blocks.forEach((b, i) => {
      const forcedTag = b.source === 'forced' ? ' [FORCED]' : b.floor ? ' [30m FLOOR]' : '';
      lines.push(`  ${b.label || i + 1}. ${b.task} — ${b.duration} min (${b.priority || 'medium'})${forcedTag}`);
    });
  }

  if (outline.shrunk && outline.shrunk.length > 0) {
    lines.push('');
    lines.push('↘️ Shrunk to fit budget:');
    for (const s of outline.shrunk) {
      lines.push(`  • ${s.item}: ${s.reason}`);
    }
  }

  if (outline.deferred && outline.deferred.length > 0) {
    lines.push('');
    lines.push('⚠️ Could not fit in current budget:');
    for (const d of outline.deferred) {
      lines.push(`  • ${d.item} — ${d.reason}`);
    }
    const forcedDeferred = outline.deferred.filter(d =>
      (d.goal_id != null && session.acceptedGoalIds.has(d.goal_id)) ||
      (d.task_id != null && session.acceptedTaskIds.has(d.task_id))
    );
    if (forcedDeferred.length > 0) {
      lines.push(`  ⚠️ Your budget (${session.budgetMinutes} min) is too small to fit all selected items even after shrinking. Reply with a larger budget (e.g. '6 hours') or 'done' to save what fits.`);
    }
  }

  lines.push('');
  if (session.suggestions.length === 0) {
    lines.push('✅ All active goals are covered in this outline.');
  } else {
    lines.push('📌 Pending / Neglected Items (numbers stay fixed):');
    for (const s of session.suggestions) {
      const statusTag = s.accepted ? '✓ [ADDED]' : '[pending]';
      lines.push(`  ${s.number}. ${statusTag} "${s.title}" — ${s.reason}`);
    }
  }

  lines.push('');
  lines.push(`Which of these should I include tomorrow? Reply with numbers (e.g. 'add 1, 2'), 'add all', 'none', 'also add <new task>', or 'done' to save.`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// A. START NIGHTLY CHECK-IN (phase = 'await_budget')
// ─────────────────────────────────────────────────────────────
function startNightlyCheckIn(todayDateObj = new Date()) {
  const cancelNotice = consumeActivePendingCancellationNotice();
  const todayStr = getTodayDate(todayDateObj);
  const tomorrowDate = getTomorrowDate(todayDateObj);
  const tomorrowWeekday = getTomorrowDayOfWeek(todayDateObj);
  const userName = getUserName();
  const greetingName = userName ? `${userName}, let's` : `Let's`;

  const session = {
    type: 'checkin',
    phase: 'await_budget',
    todayStr,
    todayDateObj,
    tomorrowDate,
    tomorrowWeekday,
    budgetMinutes: null,
    suggestions: [],
    acceptedGoalIds: new Set(),
    acceptedTaskIds: new Set(),
    customTasks: [],
    lastOutlineResult: null,
    expiresAt: Date.now() + CHECKIN_TIMEOUT_MS,
    onReply: (replyText, replyDateObj) => handleNightlyReply(replyText, replyDateObj || todayDateObj)
  };

  setPendingState(session);

  const reply = `${cancelNotice}${greetingName} plan tomorrow (${tomorrowWeekday}, ${tomorrowDate}). How much free time do you have tomorrow outside classes? (e.g. '5 hours' or '300 minutes')`;

  return {
    reply,
    state: serializeSessionState(session)
  };
}

// ─────────────────────────────────────────────────────────────
// B-F. HANDLE REPLY IN ACTIVE CHECK-IN SESSION
// ─────────────────────────────────────────────────────────────
function handleNightlyReply(text, todayDateObj = new Date()) {
  const state = getPendingState();
  if (!state || state.type !== 'checkin') {
    return null;
  }

  // Refresh 30-min expiry on activity
  state.expiresAt = Date.now() + CHECKIN_TIMEOUT_MS;
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();

  // Check cancel in ANY phase
  if (GRAMMAR.CANCEL_WORDS.has(lower)) {
    clearPending();
    return `✓ Nightly check-in cancelled. Nothing was saved for tomorrow.`;
  }

  // ── PHASE 1: await_budget ──────────────────────────────────
  if (state.phase === 'await_budget') {
    const parsed = parseBudgetInput(raw);
    if (!parsed.ok) {
      return parsed.error;
    }

    state.budgetMinutes = parsed.minutes;
    state.phase = 'review';

    const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
    state.lastOutlineResult = { outline, allGoals, neglectDays };
    state.suggestions = buildInitialSuggestions(
      outline,
      allGoals,
      neglectDays,
      state.budgetMinutes,
      state.todayStr
    );

    return formatReviewMessage(state);
  }

  // ── PHASE 2: review ────────────────────────────────────────
  if (state.phase === 'review') {
    // 1. Check 'done' / 'confirm' / 'looks good'
    if (GRAMMAR.DONE_WORDS.has(lower)) {
      const saveMsg = commitTomorrowPlanTransaction(state);
      clearPending();
      return saveMsg;
    }

    // 2. Check 'none' / 'no' / 'nahi'
    if (GRAMMAR.NONE_WORDS.has(lower)) {
      return `Got it — keeping the outline as-is without extra suggestions. Reply 'done' to save tomorrow's plan, 'also add <task>', or 'cancel'.`;
    }

    // 3. Allow updating the budget during review if user replies with a budget like "6 hours"
    if (GRAMMAR.RE_BUDGET.test(raw) && !lower.startsWith('add') && !lower.startsWith('also')) {
      const parsed = parseBudgetInput(raw);
      if (parsed.ok) {
        state.budgetMinutes = parsed.minutes;
        const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
        state.lastOutlineResult = { outline, allGoals, neglectDays };
        return formatReviewMessage(state, `✓ Updated tomorrow's budget to ${parsed.minutes} minutes.`);
      }
    }

    // 4. Check "also add <task text> ..."
    const mAlso = raw.match(GRAMMAR.RE_ALSO_ADD);
    if (mAlso) {
      const parsedTask = parseAlsoAddClause(mAlso[1]);
      if (!parsedTask.ok) {
        return parsedTask.error;
      }
      state.customTasks.push(parsedTask.task);
      const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
      state.lastOutlineResult = { outline, allGoals, neglectDays };
      const timeNote = parsedTask.task.time_slot ? ` at ${parsedTask.task.time_slot}` : '';
      return formatReviewMessage(
        state,
        `✓ Added custom task "${parsedTask.task.name}" (${parsedTask.task.duration_min} min, ${parsedTask.task.priority}${timeNote}).`
      );
    }

    // 5. Check "add all" / "add sab" / "haan add sab"
    if (GRAMMAR.ADD_ALL_PHRASES.has(lower)) {
      if (state.suggestions.length === 0) {
        return `There are no pending suggestions to add. Reply 'also add <task>' or 'done' to save.`;
      }
      const addedTitles = [];
      for (const s of state.suggestions) {
        s.accepted = true;
        if (s.kind === 'goal') state.acceptedGoalIds.add(s.goal_id);
        if (s.kind === 'task') state.acceptedTaskIds.add(s.task_id);
        addedTitles.push(`#${s.number} "${s.title}"`);
      }
      const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
      state.lastOutlineResult = { outline, allGoals, neglectDays };
      return formatReviewMessage(state, `✓ Forced in all suggestions: ${addedTitles.join(', ')}.`);
    }

    // 6. Check "add 1, 3" / "add 1 and 3" / "add 1 3"
    const mNums = raw.match(GRAMMAR.RE_ADD_NUMBERS);
    if (mNums) {
      const nums = (mNums[1].match(/\d+/g) || []).map(n => parseInt(n, 10));
      if (nums.length === 0) {
        return `Please specify valid item numbers (1–${state.suggestions.length}), e.g. 'add 1, 2'.`;
      }
      const invalid = nums.filter(n => !state.suggestions.some(s => s.number === n));
      if (invalid.length > 0) {
        return `Invalid suggestion number(s): ${invalid.join(', ')}. Valid numbers are 1–${state.suggestions.length}.`;
      }
      const addedTitles = [];
      for (const n of nums) {
        const s = state.suggestions.find(x => x.number === n);
        if (s) {
          s.accepted = true;
          if (s.kind === 'goal') state.acceptedGoalIds.add(s.goal_id);
          if (s.kind === 'task') state.acceptedTaskIds.add(s.task_id);
          addedTitles.push(`#${s.number} "${s.title}"`);
        }
      }
      const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
      state.lastOutlineResult = { outline, allGoals, neglectDays };
      return formatReviewMessage(state, `✓ Forced into tomorrow's outline: ${addedTitles.join(', ')}.`);
    }

    // 7. Check "add <title fragment>"
    const mFrag = raw.match(GRAMMAR.RE_ADD_FRAGMENT);
    if (mFrag) {
      const frag = mFrag[1].trim().toLowerCase();
      const matched = state.suggestions.filter(s => s.title.toLowerCase().includes(frag));
      if (matched.length === 0) {
        return `No suggestion matches "${mFrag[1].trim()}". Reply with item numbers (e.g. 'add 1'), 'add all', or 'also add <new task>'.`;
      }
      if (matched.length > 1) {
        return `"${mFrag[1].trim()}" matches multiple suggestions (${matched.map(m => `#${m.number} "${m.title}"`).join(', ')}). Please reply with the item number (e.g. 'add ${matched[0].number}').`;
      }
      const s = matched[0];
      s.accepted = true;
      if (s.kind === 'goal') state.acceptedGoalIds.add(s.goal_id);
      if (s.kind === 'task') state.acceptedTaskIds.add(s.task_id);
      const { outline, allGoals, neglectDays } = computeTomorrowOutline(state, state.todayDateObj || todayDateObj);
      state.lastOutlineResult = { outline, allGoals, neglectDays };
      return formatReviewMessage(state, `✓ Forced into tomorrow's outline: #${s.number} "${s.title}".`);
    }

    // 8. Unrecognized input in review phase — restate valid options without calling AI
    return `I didn't recognize that command during the nightly check-in. Valid replies:\n  • 'add 1, 2' or 'add all' (or 'add sab')\n  • 'add <title fragment>'\n  • 'also add <task> [for N min] [at H:MM AM/PM] [priority high|medium|low]'\n  • 'none' (or 'nahi')\n  • 'done' (or 'confirm' / 'looks good') to save\n  • 'cancel' to abort`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// F. SAVE TOMORROW'S PLAN IN ONE TRANSACTION
// ─────────────────────────────────────────────────────────────
function commitTomorrowPlanTransaction(session) {
  const tomorrow = session.tomorrowDate;
  const budget = session.budgetMinutes;
  const blocks = (session.lastOutlineResult && session.lastOutlineResult.outline.freeBlocks) || [];

  const findExistingGoalTaskStmt = db.prepare(`
    SELECT id FROM tasks WHERE goal_id = ? AND date = ? ORDER BY id ASC LIMIT 1
  `);
  const updateGoalTaskStmt = db.prepare(`
    UPDATE tasks
    SET name = ?, priority = ?, duration_min = ?, source = 'goal', carry_forward = ?
    WHERE id = ?
  `);
  const insertGoalTaskStmt = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward, goal_id, duration_min)
    VALUES (?, ?, NULL, 'goal', 0, ?, ?, ?, ?)
  `);
  const moveOldTaskStmt = db.prepare(`
    UPDATE tasks SET date = ?, source = 'forced' WHERE id = ?
  `);
  const checkCustomDupStmt = db.prepare(`
    SELECT id FROM tasks
    WHERE date = ? AND completed = 0 AND LOWER(TRIM(name)) = LOWER(TRIM(?))
    LIMIT 1
  `);
  const insertCustomTaskStmt = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward, goal_id, duration_min)
    VALUES (?, ?, ?, 'forced', 0, ?, 0, NULL, ?)
  `);

  let goalTasksSaved = 0;
  let oldTasksMoved = 0;
  let customTasksInserted = 0;

  const tx = db.transaction(() => {
    // 1. Set tomorrow's daily_settings.available_minutes = budget
    db.prepare(`
      INSERT INTO daily_settings (date, available_minutes)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET available_minutes = excluded.available_minutes
    `).run(tomorrow, budget);

    // 2. Create/update tomorrow's goal task rows from the outline (reusing by goal_id + date)
    for (const b of blocks) {
      if (b.goal_id != null && (b.source === 'goal' || b.source === 'habit' || b.source === 'forced')) {
        const isForcedGoal = session.acceptedGoalIds.has(b.goal_id) ? 1 : 0;
        const existing = findExistingGoalTaskStmt.get(b.goal_id, tomorrow);
        if (existing) {
          updateGoalTaskStmt.run(b.task, b.priority || 'medium', b.duration || 30, isForcedGoal, existing.id);
        } else {
          insertGoalTaskStmt.run(b.task, b.priority || 'medium', tomorrow, isForcedGoal, b.goal_id, b.duration || 30);
        }
        goalTasksSaved++;
      }
    }

    // 3. Move accepted incomplete tasks from today or earlier to tomorrow (UPDATE date = tomorrow, no duplicate row!)
    for (const taskId of session.acceptedTaskIds) {
      const info = moveOldTaskStmt.run(tomorrow, taskId);
      if (info.changes > 0) oldTasksMoved++;
    }

    // 4. Insert "also add" custom tasks for tomorrow (with duplicate check by case-insensitive name)
    for (const ct of session.customTasks) {
      const dup = checkCustomDupStmt.get(tomorrow, ct.name);
      if (!dup) {
        insertCustomTaskStmt.run(
          ct.name,
          ct.priority || 'medium',
          ct.time_slot || null,
          tomorrow,
          ct.duration_min || 30
        );
        customTasksInserted++;
      }
    }
  });

  tx();

  return [
    `✅ Tomorrow's plan saved for ${session.tomorrowWeekday}, ${tomorrow}!`,
    `  • Free-time budget stored: ${budget} min (${+(budget / 60).toFixed(1)}h)`,
    `  • Goal sessions queued: ${goalTasksSaved}`,
    `  • Carried tasks moved to tomorrow: ${oldTasksMoved}`,
    `  • New custom tasks added: ${customTasksInserted}`,
    `Tomorrow morning, set your window (e.g. 'free till 9 PM') and SEVA will place these around your timetable.`
  ].join('\n');
}

function serializeSessionState(state) {
  if (!state || state.type !== 'checkin') {
    return { active: false };
  }
  return {
    active: true,
    phase: state.phase,
    tomorrowDate: state.tomorrowDate,
    tomorrowWeekday: state.tomorrowWeekday,
    budgetMinutes: state.budgetMinutes,
    suggestions: state.suggestions,
    acceptedGoalIds: Array.from(state.acceptedGoalIds || []),
    acceptedTaskIds: Array.from(state.acceptedTaskIds || []),
    customTasks: state.customTasks || [],
    outline: state.lastOutlineResult ? state.lastOutlineResult.outline : null,
    expiresAt: state.expiresAt
  };
}

function getNightlySessionState() {
  const state = getPendingState();
  return serializeSessionState(state);
}

function cancelNightlyCheckIn() {
  const state = getPendingState();
  if (state && state.type === 'checkin') {
    clearPending();
    return { cancelled: true, message: 'Nightly check-in cancelled. Nothing was saved.' };
  }
  return { cancelled: false, message: 'No active nightly check-in session.' };
}

module.exports = {
  GRAMMAR,
  matchesPlanTomorrowTrigger,
  parseBudgetInput,
  parseAlsoAddClause,
  startNightlyCheckIn,
  handleNightlyReply,
  getNightlySessionState,
  cancelNightlyCheckIn
};
