const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const {
  getTodayDate,
  getTodayDayOfWeek,
  parseTimeToMinutes,
  minutesToTimeString,
  daysBetween
} = require('../utils/dateUtils');
const { getAllGoals } = require('./goalsService');
const {
  buildDaySchedule,
  buildFixedTimeline,
  computeGapObjects
} = require('./schedulerService');

// getTodayWindow is lazily required to avoid circular deps (settings route → db → plannerService)
function getTodayWindowSafe(todayStr) {
  try { return require('../routes/settings').getTodayWindow(todayStr); } catch { return null; }
}

// Config flag: PLANNER_ENGINE=scheduler|ai (default: scheduler)
function getPlannerEngine() {
  return (process.env.PLANNER_ENGINE || 'scheduler').toLowerCase().trim();
}

// Use the same model constant pattern as aiService.js
const PREFERRED_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';

// Allowed priority values (same whitelist as aiService.js)
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];

// ─────────────────────────────────────────────────────────────
// JSON EXTRACTION HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Extract a JSON OBJECT string from raw model output.
 * Strips from first '{' to last '}'.
 */
function extractObjectJsonString(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return rawText.substring(first, last + 1);
  }
  return null;
}

/**
 * Extract a JSON ARRAY string from raw model output.
 * Strips from first '[' to last ']'.
 */
function extractArrayJsonString(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const first = rawText.indexOf('[');
  const last = rawText.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    return rawText.substring(first, last + 1);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// PER-ITEM VALIDATION (used by legacy AI planner)
// ─────────────────────────────────────────────────────────────

function validatePlanItem(item, allowedTaskNames = null) {
  if (!item || typeof item !== 'object') return null;

  if (!item.task || typeof item.task !== 'string' || !item.task.trim()) {
    return null;
  }

  const task = item.task.trim();

  if (allowedTaskNames && Array.isArray(allowedTaskNames) && allowedTaskNames.length > 0) {
    const normTask = task.toLowerCase();
    const isAllowed = allowedTaskNames.some(allowed => {
      const normAllowed = allowed.toLowerCase().trim();
      return normTask === normAllowed || normTask.includes(normAllowed) || normAllowed.includes(normTask);
    });
    if (!isAllowed) {
      console.warn(`⚠️ Dropping hallucinated task "${task}" — not found in active task whitelist.`);
      return null;
    }
  }

  const rawPriority = typeof item.priority === 'string' ? item.priority.toLowerCase().trim() : '';
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';

  let duration = parseInt(item.duration, 10);
  if (isNaN(duration) || duration <= 0) {
    duration = 30;
  }

  const time = (item.time && typeof item.time === 'string' && item.time.trim())
    ? item.time.trim()
    : null;

  const source = (item.source && typeof item.source === 'string' && item.source.trim())
    ? item.source.trim()
    : 'manual';

  return { time, task, priority, duration, source };
}

function parseAndValidatePlanArray(rawResponse, allowedTaskNames = null) {
  const extracted = extractArrayJsonString(rawResponse);
  if (!extracted) {
    console.warn('⚠️ Could not extract JSON array from AI response (no [ ] brackets found).');
    return { items: null, usedFallback: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(extracted);
  } catch (parseErr) {
    console.warn('⚠️ JSON.parse failed on extracted array string:', parseErr.message);
    return { items: null, usedFallback: true };
  }

  if (!Array.isArray(parsed)) {
    console.warn('⚠️ Parsed value is not an array — got:', typeof parsed);
    return { items: null, usedFallback: true };
  }

  const validItems = parsed.map(item => validatePlanItem(item, allowedTaskNames)).filter(item => item !== null);

  if (validItems.length === 0) {
    console.warn('⚠️ All items dropped after validation — empty/hallucinated plan from AI.');
    return { items: null, usedFallback: true };
  }

  const seenTaskNames = new Set();
  const dedupedItems = [];
  for (const item of validItems) {
    const normName = item.task.trim().toLowerCase();
    if (seenTaskNames.has(normName)) {
      console.warn(`⚠️ Dropping duplicate task "${item.task}" — already scheduled once in this plan.`);
    } else {
      seenTaskNames.add(normName);
      dedupedItems.push(item);
    }
  }

  if (dedupedItems.length === 0) {
    console.warn('⚠️ All items removed after deduplication — falling back to basic plan.');
    return { items: null, usedFallback: true };
  }

  const droppedTotal = parsed.length - dedupedItems.length;
  console.log(`   └─ AI plan: ${parsed.length} item(s) received, ${dedupedItems.length} kept (whitelist + dedup), ${droppedTotal} dropped.`);
  return { items: dedupedItems, usedFallback: false };
}

// ─────────────────────────────────────────────────────────────
// DAY PLAN — DB PERSISTENCE
// ─────────────────────────────────────────────────────────────

/**
 * Save (insert or overwrite) a plan for a given date in day_plans table.
 * If a row for that date already exists → UPDATE plan_json + generated_at.
 * If no row exists → INSERT new row.
 */
function savePlanToDb(date, planArray) {
  const planJson = JSON.stringify(planArray);
  const now = new Date();
  const generatedAt = `${getTodayDate(now)} ${minutesToTimeString(now.getHours() * 60 + now.getMinutes())}`;

  const existing = db.prepare(`SELECT id FROM day_plans WHERE date = ?`).get(date);

  if (existing) {
    db.prepare(`
      UPDATE day_plans
      SET plan_json = ?, generated_at = ?
      WHERE date = ?
    `).run(planJson, generatedAt, date);
    console.log(`💾 Updated existing day_plans row for date ${date}.`);
  } else {
    db.prepare(`
      INSERT INTO day_plans (date, plan_json, generated_at, completed_count, missed_count)
      VALUES (?, ?, ?, 0, 0)
    `).run(date, planJson, generatedAt);
    console.log(`💾 Inserted new day_plans row for date ${date}.`);
  }
}

/**
 * Persist goal-derived and habit-derived plan items as real `tasks` rows
 * (source = 'goal', goal_id, date = todayStr).
 * Reuses any existing row with the same (goal_id, date) so regenerating
 * the plan NEVER creates duplicate task rows.
 */
function persistGoalTasksForPlan(todayStr, planArray) {
  if (!Array.isArray(planArray)) return planArray;

  const findExistingStmt = db.prepare(`
    SELECT id, completed
    FROM tasks
    WHERE goal_id = ? AND date = ?
    ORDER BY id ASC
    LIMIT 1
  `);
  const updateExistingStmt = db.prepare(`
    UPDATE tasks
    SET name = ?, priority = ?, time_slot = ?, duration_min = ?, source = 'goal'
    WHERE id = ?
  `);
  const insertGoalTaskStmt = db.prepare(`
    INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward, goal_id, duration_min)
    VALUES (?, ?, ?, 'goal', 0, ?, 0, ?, ?)
  `);
  const findTaskStmt = db.prepare(`SELECT id, completed FROM tasks WHERE id = ?`);

  const tx = db.transaction(() => {
    for (const item of planArray) {
      if (item.goal_id != null && (item.source === 'goal' || item.source === 'habit' || item.source === 'forced')) {
        const existing = findExistingStmt.get(item.goal_id, todayStr);
        if (existing) {
          updateExistingStmt.run(
            item.task,
            item.priority || 'medium',
            item.time || null,
            item.duration || 30,
            existing.id
          );
          item.task_id = existing.id;
          item.completed = existing.completed;
        } else {
          const info = insertGoalTaskStmt.run(
            item.task,
            item.priority || 'medium',
            item.time || null,
            todayStr,
            item.goal_id,
            item.duration || 30
          );
          item.task_id = Number(info.lastInsertRowid);
          item.completed = 0;
        }
      } else if (item.task_id != null) {
        const row = findTaskStmt.get(item.task_id);
        if (row) {
          item.completed = row.completed;
        }
      }
    }
  });

  tx();
  return planArray;
}

// ─────────────────────────────────────────────────────────────
// DETERMINISTIC SCHEDULER WRAPPER (Step 5)
// Gathers DB inputs and calls pure schedulerService functions.
// ─────────────────────────────────────────────────────────────

/**
 * Gathers all DB inputs needed by buildDaySchedule for `todayDateObj`.
 * Reads the exact fields computed by `getAllGoals(dateObjForToday)` (Step 2).
 */
function gatherScheduleInputs(todayDateObj = new Date(), overrides = {}) {
  const dObj = todayDateObj instanceof Date ? todayDateObj : new Date(todayDateObj);
  const today = overrides.today || getTodayDate(dObj);
  const [ty, tm, td] = today.split('-').map(Number);
  const dateObjForToday = new Date(ty, tm - 1, td, dObj.getHours(), dObj.getMinutes(), dObj.getSeconds());
  const todayDayOfWeek = overrides.dayOfWeek || getTodayDayOfWeek(dateObjForToday);
  const nowMinutes = overrides.nowMinutes !== undefined
    ? overrides.nowMinutes
    : (dObj.getHours() * 60 + dObj.getMinutes());

  const windowData = getTodayWindowSafe(today);
  const windowEndMinutes = overrides.windowEndMinutes !== undefined
    ? overrides.windowEndMinutes
    : (windowData ? windowData.window_end_minutes : null);
  const doneForDay = overrides.doneForDay !== undefined
    ? overrides.doneForDay
    : Boolean(windowData && windowData.done_for_day === 1);

  const todaySettingsRow = db.prepare('SELECT available_minutes FROM daily_settings WHERE date = ?').get(today);
  const tonightBudgetHint = (todaySettingsRow && todaySettingsRow.available_minutes)
    ? todaySettingsRow.available_minutes
    : null;

  const prefs = db.prepare('SELECT * FROM preferences WHERE id = 1').get() || {};
  const bufferMinutes = overrides.bufferMinutes ?? prefs.buffer_minutes ?? 15;
  const defaultUrgentMins = overrides.defaultUrgentMins ?? prefs.default_urgent_minutes ?? 90;
  const runSlotStartMins = overrides.runSlotStartMins !== undefined
    ? overrides.runSlotStartMins
    : (prefs.run_slot_start ? parseTimeToMinutes(prefs.run_slot_start) : null);
  const neglectDays = overrides.neglectDays ?? prefs.neglect_days ?? 3;

  const timetableBlocks = overrides.timetableBlocks || db.prepare(`
    SELECT day_of_week, subject, start_time, end_time
    FROM timetable
    WHERE day_of_week = ?
    ORDER BY start_time ASC
  `).all(todayDayOfWeek);

  // Read goals using the exact Step 2 getAllGoals() function
  const allGoals = overrides.allGoals || getAllGoals(dateObjForToday);
  const activeGoals = allGoals.filter(g => g.status === 'active');

  // Check if any goal tasks for today were explicitly forced in during last night's check-in (carry_forward = 1)
  const forcedGoalRows = overrides.allGoals ? [] : db.prepare(`
    SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
           goal_id, duration_min
    FROM tasks
    WHERE date = ? AND completed = 0 AND goal_id IS NOT NULL AND carry_forward = 1
    ORDER BY id ASC
  `).all(today);
  const forcedGoalIdSet = new Set(forcedGoalRows.map(r => r.goal_id));

  const habitGoals = overrides.habitGoals || activeGoals.filter(
    g => g.goal_type === 'frequency' && !forcedGoalIdSet.has(g.id)
  );
  const goals = overrides.goals || activeGoals.filter(
    g => g.goal_type !== 'frequency' && !forcedGoalIdSet.has(g.id)
  );

  // Read incomplete non-goal tasks
  const rawTasks = db.prepare(`
    SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
           goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
    FROM tasks
    WHERE completed = 0 AND goal_id IS NULL
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all();

  const fixedTasks = [];
  const urgentTasks = [];
  const forced = [
    ...(overrides.forced || []),
    ...forcedGoalRows
  ];
  const flexibleTasks = [];

  for (const t of rawTasks) {
    const hasFixedStart = Boolean(t.fixed_start && String(t.fixed_start).trim());
    if (hasFixedStart) {
      if (t.date === today || t.due_date === today) {
        fixedTasks.push(t);
      }
      continue;
    }

    const isDueSoon = Boolean(
      t.due_date &&
      String(t.due_date).trim() &&
      daysBetween(today, t.due_date) <= 3 &&
      daysBetween(today, t.due_date) >= -30
    );
    if ((t.is_urgent === 1 && t.date <= today) || isDueSoon) {
      urgentTasks.push(t);
      continue;
    }

    if (t.date === today && t.source === 'forced') {
      forced.push(t);
      continue;
    }

    if (t.date <= today) {
      flexibleTasks.push(t);
    }
  }

  if (Array.isArray(overrides.extraFixedTasks)) {
    fixedTasks.push(...overrides.extraFixedTasks);
  }

  return {
    today,
    todayDayOfWeek,
    nowMinutes,
    windowEndMinutes,
    doneForDay,
    windowData,
    tonightBudgetHint,
    prefs,
    bufferMinutes,
    defaultUrgentMins,
    runSlotStartMins,
    neglectDays,
    timetableBlocks,
    fixedTasks,
    urgentTasks,
    forced,
    habitGoals,
    goals,
    flexibleTasks,
    allGoals
  };
}

/**
 * Wrapper that gathers DB inputs and runs buildDaySchedule.
 */
function buildScheduleFromDb(todayDateObj = new Date(), overrides = {}) {
  const inputs = gatherScheduleInputs(todayDateObj, overrides);
  const schedule = buildDaySchedule({
    today: inputs.today,
    nowMinutes: inputs.nowMinutes,
    windowEndMinutes: inputs.windowEndMinutes,
    doneForDay: inputs.doneForDay,
    timetableBlocks: inputs.timetableBlocks,
    fixedTasks: inputs.fixedTasks,
    bufferMinutes: inputs.bufferMinutes,
    urgentTasks: inputs.urgentTasks,
    forced: inputs.forced,
    habitGoals: inputs.habitGoals,
    goals: inputs.goals,
    flexibleTasks: inputs.flexibleTasks,
    defaultUrgentMins: inputs.defaultUrgentMins,
    runSlotStartMins: inputs.runSlotStartMins,
    neglectDays: inputs.neglectDays,
    enableFloor: overrides.enableFloor !== undefined ? overrides.enableFloor : true
  });
  return { schedule, inputs };
}

// ─────────────────────────────────────────────────────────────
// PLAN NOTE (AI 1-2 sentence summary with deterministic template fallback)
// ─────────────────────────────────────────────────────────────

function buildDeterministicPlanNote(schedule, userName = null) {
  const prefix = userName && String(userName).trim() ? `${String(userName).trim()}, ` : '';
  const workBlocks = (schedule.plan || []).filter(b => b.source !== 'fixed');
  const fixedBlocks = (schedule.plan || []).filter(b => b.source === 'fixed');
  const floorSessions = schedule.floorSessions || [];
  const shrunk = schedule.shrunk || [];
  const deferred = schedule.deferred || [];

  const parts = [];
  if (workBlocks.length === 0 && fixedBlocks.length === 0) {
    parts.push(`${prefix}no tasks or goal sessions fit in the current window.`);
  } else {
    parts.push(
      `${prefix}scheduled ${workBlocks.length} work block${workBlocks.length !== 1 ? 's' : ''}` +
      (fixedBlocks.length > 0 ? ` around ${fixedBlocks.length} fixed commitment${fixedBlocks.length !== 1 ? 's' : ''}` : '') +
      ` (${schedule.budgetMinutes || 0} min free budget).`
    );
  }

  const details = [];
  if (floorSessions.length > 0) {
    const names = floorSessions.map(f => f.item).join(' and ');
    details.push(`includes a short session to keep ${names} moving`);
  }
  if (shrunk.length > 0) {
    details.push(`shrunk ${shrunk.map(s => s.item).join(', ')} to fit`);
  }
  if (deferred.length > 0) {
    details.push(`deferred ${deferred.map(d => d.item).join(', ')}`);
  }
  if (details.length > 0) {
    const sentence2 = details.join('; ');
    parts.push(sentence2.charAt(0).toUpperCase() + sentence2.slice(1) + '.');
  }

  return parts.join(' ');
}

async function buildPlanNote(schedule, prefs = {}, opts = {}) {
  const userName = prefs && prefs.user_name ? prefs.user_name : null;
  const fallbackNote = buildDeterministicPlanNote(schedule, userName);

  if (opts.skipAiNote || process.env.SKIP_AI_PLAN_NOTE === '1') {
    return fallbackNote;
  }

  try {
    const workCount = (schedule.plan || []).filter(b => b.source !== 'fixed').length;
    const floorNames = (schedule.floorSessions || []).map(f => f.item);
    const shrunkNames = (schedule.shrunk || []).map(s => s.item);
    const deferredNames = (schedule.deferred || []).map(d => d.item);

    const prompt = [
      `Write a concise 1-2 sentence plan note for today's schedule.`,
      userName ? `Address the user as ${userName}.` : `Do NOT invent or use any person's name.`,
      `Scheduled work blocks: ${workCount}. Free budget: ${schedule.budgetMinutes} min.`,
      floorNames.length ? `Floor sessions (say "short session to keep <goal> moving"): ${floorNames.join(', ')}.` : '',
      shrunkNames.length ? `Shrunk items: ${shrunkNames.join(', ')}.` : '',
      deferredNames.length ? `Deferred items: ${deferredNames.join(', ')}.` : '',
      `Reply with plain text only (1-2 sentences, no bullet points, no markdown).`
    ].filter(Boolean).join('\n');

    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      messages: [
        { role: 'system', content: 'You write brief 1-2 sentence schedule summaries from exact facts provided. Never invent times or names.' },
        { role: 'user', content: prompt }
      ],
      options: { num_predict: 90 }
    });
    const text = response && response.message && response.message.content
      ? response.message.content.trim().replace(/\s+/g, ' ')
      : '';
    if (!text) return fallbackNote;

    // Guarantee floor session wording if floorSessions are present
    if (floorNames.length > 0 && !/keep .+ moving/i.test(text)) {
      return `${text} Includes a short session to keep ${floorNames.join(' and ')} moving.`;
    }
    return text;
  } catch (err) {
    console.warn(`⚠️ buildPlanNote AI call failed (${err.message}); using template fallback.`);
    return fallbackNote;
  }
}

// ─────────────────────────────────────────────────────────────
// FALLBACK PLAN (when legacy AI fails entirely)
// ─────────────────────────────────────────────────────────────

function buildFallbackPlan(tasks) {
  const sorted = [...tasks].sort((a, b) => {
    if (a.time_slot && !b.time_slot) return -1;
    if (!a.time_slot && b.time_slot) return 1;
    if (a.time_slot && b.time_slot) return a.time_slot.localeCompare(b.time_slot);
    return 0;
  });

  const seenNames = new Set();
  const dedupedSorted = sorted.filter(t => {
    const norm = (t.name || '').trim().toLowerCase();
    if (seenNames.has(norm)) {
      console.warn(`⚠️ Fallback plan: dropping duplicate task "${t.name}" — already scheduled once.`);
      return false;
    }
    seenNames.add(norm);
    return true;
  });

  return dedupedSorted.map(t => ({
    time: t.time_slot || null,
    task: t.name,
    priority: t.priority || 'medium',
    duration: 30,
    source: t.source || 'manual',
    task_id: t.id || null,
    goal_id: t.goal_id || null
  }));
}

// ─────────────────────────────────────────────────────────────
// LEGACY AI PLANNER (kept intact behind PLANNER_ENGINE=ai & error fallback)
// ─────────────────────────────────────────────────────────────

async function generateDayPlanAI(todayDateObj = new Date()) {
  const today = getTodayDate(todayDateObj);
  const todayDayOfWeek = getTodayDayOfWeek(todayDateObj);

  console.log(`\n🗓️  generateDayPlanAI() [legacy AI engine] called for date: ${today} (${todayDayOfWeek})`);

  const tasks = db.prepare(`
    SELECT id, name, priority, time_slot, source, completed, goal_id
    FROM tasks
    WHERE date <= ? AND completed = 0
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all(today);

  const timetable = db.prepare(`
    SELECT day_of_week, subject, start_time, end_time
    FROM timetable
    WHERE day_of_week = ?
    ORDER BY start_time ASC
  `).all(todayDayOfWeek);

  if (tasks.length === 0) {
    const emptyPlan = [];
    savePlanToDb(today, emptyPlan);
    return emptyPlan;
  }

  const timetableText = timetable.length > 0
    ? timetable.map(t => `  - ${t.subject}: ${t.start_time} to ${t.end_time}`).join('\n')
    : '  (No classes scheduled today)';

  const tasksText = tasks.map(t =>
    `  - "${t.name}" | priority: ${t.priority} | preferred time: ${t.time_slot || 'flexible'} | source: ${t.source}`
  ).join('\n');

  const systemPrompt = `You are SEVA, a personal planning assistant. Your job is to create a clear, realistic hour-by-hour day plan.

Output ONLY a valid JSON array. No markdown, no explanation, no extra text.

Required format for each item:
{"time": "HH:MM AM/PM", "task": "task name", "priority": "high|medium|low", "duration": <minutes as number>, "source": "manual|email"}`;

  const userPrompt = `Create an hour by hour day plan based on the following:

Timetable (fixed classes — NEVER schedule tasks during these time slots):
${timetableText}

Tasks to schedule:
${tasksText}

Rules:
- Schedule high priority tasks in the morning
- Leave 15 minute gaps between tasks
- Do not schedule anything during timetable class hours
- Return a JSON array only — no extra text
- Format: [{"time": "9:00 AM", "task": "task name", "priority": "high", "duration": 45, "source": "manual"}]`;

  let rawResponse = '';
  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    rawResponse = response.message ? response.message.content : '';
  } catch (ollamaErr) {
    console.error(`❌ Ollama call failed in generateDayPlanAI: ${ollamaErr.message}`);
    const fallbackPlan = buildFallbackPlan(tasks);
    savePlanToDb(today, fallbackPlan);
    return fallbackPlan;
  }

  const allowedTaskNames = tasks.map(t => t.name);
  const { items, usedFallback } = parseAndValidatePlanArray(rawResponse, allowedTaskNames);

  const finalPlan = (usedFallback || !items) ? buildFallbackPlan(tasks) : items;
  savePlanToDb(today, finalPlan);
  return finalPlan;
}

function createSurpriseEventSlot(surpriseEvent, fallbackTime = null, duration = 60) {
  let extractedTime = fallbackTime;
  const timeMatch = surpriseEvent.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/i);
  if (timeMatch) {
    const parsed = parseTimeToMinutes(timeMatch[1]);
    extractedTime = parsed !== null ? minutesToTimeString(parsed) : timeMatch[1].toUpperCase();
  }

  return {
    time: extractedTime,
    task: surpriseEvent.trim(),
    priority: 'high',
    duration,
    source: 'surprise_event'
  };
}

async function replanAI(surpriseEvent, todayDateObj = new Date()) {
  const today = getTodayDate(todayDateObj);
  const nowMins = todayDateObj.getHours() * 60 + todayDateObj.getMinutes();
  const windowData = getTodayWindowSafe(today);
  const endMins = (windowData && windowData.window_end_minutes !== null)
    ? windowData.window_end_minutes
    : (23 * 60 + 59);
  const remainingMins = Math.max(0, endMins - nowMins);
  const remainingHours = (remainingMins / 60).toFixed(1);

  const incompleteTasks = db.prepare(`
    SELECT id, name, priority, time_slot, source, completed, goal_id
    FROM tasks
    WHERE date <= ? AND completed = 0
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all(today);

  if (incompleteTasks.length === 0) {
    const emptyPlan = [createSurpriseEventSlot(surpriseEvent)];
    savePlanToDb(today, emptyPlan);
    return emptyPlan;
  }

  const tasksText = incompleteTasks.map(t =>
    `  - "${t.name}" | priority: ${t.priority} | source: ${t.source}`
  ).join('\n');

  const systemPrompt = `You are SEVA, a personal planning assistant. Replan the remaining day around an unexpected event.

Output ONLY a valid JSON array. No markdown, no explanation, no extra text.

Required format for each item:
{"time": "HH:MM AM/PM", "task": "task name", "priority": "high|medium|low", "duration": <minutes as number>}`;

  const userPrompt = `Replan the remaining day.

Surprise event: ${surpriseEvent}
Remaining hours in day: ${remainingHours} hours
Incomplete tasks to fit in:
${tasksText}

Rules:
- Fit ALL incomplete tasks around the surprise event
- Keep high priority tasks first
- Leave 15 minute gaps between tasks
- Return a JSON array only`;

  let rawResponse = '';
  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    rawResponse = response.message ? response.message.content : '';
  } catch (ollamaErr) {
    const fallbackPlan = buildFallbackPlan(incompleteTasks);
    const mergedFallback = [createSurpriseEventSlot(surpriseEvent), ...fallbackPlan];
    savePlanToDb(today, mergedFallback);
    return mergedFallback;
  }

  const allowedTaskNames = incompleteTasks.map(t => t.name);
  const { items, usedFallback } = parseAndValidatePlanArray(rawResponse, allowedTaskNames);
  const taskSlots = (usedFallback || !items) ? buildFallbackPlan(incompleteTasks) : items;
  const surpriseSlot = createSurpriseEventSlot(surpriseEvent);
  const finalPlan = [surpriseSlot, ...taskSlots];
  savePlanToDb(today, finalPlan);
  return finalPlan;
}

// ─────────────────────────────────────────────────────────────
// UNIFIED ENTRY POINTS: generateDayPlan() and replan()
// Default: deterministic scheduler (PLANNER_ENGINE=scheduler)
// Switchable to AI via PLANNER_ENGINE=ai, with AI as loud error fallback.
// ─────────────────────────────────────────────────────────────

async function generateDayPlan(todayDateObj = new Date(), opts = {}) {
  const engine = (opts.engine || getPlannerEngine()).toLowerCase();
  const dObj = todayDateObj instanceof Date ? todayDateObj : new Date(todayDateObj);
  const today = opts.today || getTodayDate(dObj);

  if (engine === 'ai') {
    const plan = await generateDayPlanAI(dObj);
    const windowData = getTodayWindowSafe(today);
    return {
      success: true,
      engine: 'ai',
      date: today,
      count: plan.length,
      plan,
      deferred: [],
      shrunk: [],
      floorSessions: [],
      warnings: [],
      window: windowData ? {
        window_set: true,
        source: windowData.source,
        window_end_minutes: windowData.window_end_minutes,
        window_end_time: minutesToTimeString(windowData.window_end_minutes),
        done_for_day: windowData.done_for_day === 1
      } : { window_set: false },
      plan_note: 'Generated with legacy AI planner (PLANNER_ENGINE=ai).'
    };
  }

  try {
    const { schedule, inputs } = buildScheduleFromDb(dObj, opts);

    if (schedule.refused) {
      let hint = schedule.hint || null;
      if (schedule.needs_window && inputs.tonightBudgetHint) {
        const hrs = +(inputs.tonightBudgetHint / 60).toFixed(1);
        hint = `Last night you planned about ${hrs} hour${hrs !== 1 ? 's' : ''} (${inputs.tonightBudgetHint} min). Say "free till 9 PM" or "I have ${hrs} hours".`;
      }
      return {
        success: false,
        engine: 'scheduler',
        date: inputs.today,
        refused: true,
        reason: schedule.reason,
        needs_window: Boolean(schedule.needs_window),
        message: schedule.message,
        hint,
        window: {
          window_set: inputs.windowEndMinutes !== null,
          now_minutes: inputs.nowMinutes,
          now_time: minutesToTimeString(inputs.nowMinutes),
          window_end_minutes: inputs.windowEndMinutes,
          window_end_time: inputs.windowEndMinutes !== null ? minutesToTimeString(inputs.windowEndMinutes) : null,
          done_for_day: inputs.doneForDay,
          tonight_budget_hint: inputs.tonightBudgetHint
        }
      };
    }

    persistGoalTasksForPlan(inputs.today, schedule.plan);
    savePlanToDb(inputs.today, schedule.plan);
    const plan_note = await buildPlanNote(schedule, inputs.prefs, opts);

    return {
      success: true,
      engine: 'scheduler',
      date: inputs.today,
      count: schedule.plan.length,
      plan: schedule.plan,
      deferred: schedule.deferred,
      shrunk: schedule.shrunk,
      floorSessions: schedule.floorSessions,
      warnings: schedule.warnings,
      behind_pace: schedule.behind_pace,
      scores: schedule.scores,
      window: {
        window_set: true,
        source: inputs.windowData ? inputs.windowData.source : 'override',
        now_minutes: inputs.nowMinutes,
        now_time: minutesToTimeString(inputs.nowMinutes),
        window_end_minutes: inputs.windowEndMinutes,
        window_end_time: minutesToTimeString(inputs.windowEndMinutes),
        budget_minutes: schedule.budgetMinutes,
        gaps: schedule.gapSummary,
        done_for_day: inputs.doneForDay
      },
      plan_note
    };
  } catch (schedErr) {
    console.error(`🚨 SCHEDULER ERROR in generateDayPlan — falling back to legacy AI planner:`, schedErr);
    const fallbackPlan = await generateDayPlanAI(dObj);
    return {
      success: true,
      engine: 'ai_fallback',
      date: today,
      count: fallbackPlan.length,
      plan: fallbackPlan,
      deferred: [],
      shrunk: [],
      floorSessions: [],
      warnings: [`Scheduler error fallback triggered: ${schedErr.message}`],
      window: { window_set: false },
      plan_note: 'Generated via fallback planner due to an unexpected scheduler error.'
    };
  }
}

async function replan(surpriseEvent, todayDateObj = new Date(), opts = {}) {
  const engine = (opts.engine || getPlannerEngine()).toLowerCase();
  const dObj = todayDateObj instanceof Date ? todayDateObj : new Date(todayDateObj);
  const today = opts.today || getTodayDate(dObj);

  if (engine === 'ai') {
    const plan = await replanAI(surpriseEvent, dObj);
    return {
      success: true,
      engine: 'ai',
      date: today,
      surpriseEvent: surpriseEvent.trim(),
      count: plan.length,
      plan,
      deferred: [],
      shrunk: [],
      floorSessions: [],
      warnings: [],
      plan_note: `Replanned around "${surpriseEvent.trim()}" using legacy AI planner (PLANNER_ENGINE=ai).`
    };
  }

  try {
    const inputs = gatherScheduleInputs(dObj, opts);
    const effectiveWindowEnd = inputs.windowEndMinutes !== null
      ? inputs.windowEndMinutes
      : (23 * 60 + 59);
    const extraWarnings = [];
    if (inputs.windowEndMinutes === null) {
      console.warn('⚠️ replan(): no daily window set. Using 11:59 PM fallback for emergency replan.');
      extraWarnings.push('No daily window was set; used 11:59 PM for this replan.');
    }

    // Parse time from surpriseEvent using the shared helper
    const timeMatch = surpriseEvent.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i);
    let eventStartMins = timeMatch ? parseTimeToMinutes(timeMatch[1]) : null;

    // Parse optional duration from surpriseEvent (default 60 min)
    let eventDuration = 60;
    const durMatch = surpriseEvent.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i);
    if (durMatch) {
      const val = parseFloat(durMatch[1]);
      const unit = durMatch[2].toLowerCase();
      const parsedDur = unit.startsWith('h') ? Math.round(val * 60) : Math.round(val);
      if (parsedDur >= 5 && parsedDur <= 480) eventDuration = parsedDur;
    }

    if (eventStartMins === null) {
      // Place at the next free time in the window and say so
      const existingFixed = buildFixedTimeline(inputs.timetableBlocks, inputs.fixedTasks);
      const gaps = computeGapObjects(existingFixed, inputs.nowMinutes, effectiveWindowEnd);
      const fitGap = gaps.find(g => (g.end - g.start) >= eventDuration) || gaps[0];
      eventStartMins = fitGap ? fitGap.start : inputs.nowMinutes;
      const placedTimeStr = minutesToTimeString(eventStartMins);
      extraWarnings.push(`No time found in "${surpriseEvent.trim()}" — placed at next free time (${placedTimeStr}).`);
    }

    const surpriseStartStr = minutesToTimeString(eventStartMins);
    const surpriseEndStr = minutesToTimeString(Math.min(1439, eventStartMins + eventDuration));

    const surpriseFixedTask = {
      id: null,
      name: surpriseEvent.trim(),
      priority: 'high',
      source: 'surprise_event',
      fixed_start: surpriseStartStr,
      fixed_end: surpriseEndStr,
      duration_min: eventDuration
    };

    const effectiveNowMins = Math.min(inputs.nowMinutes, eventStartMins);
    const schedule = buildDaySchedule({
      today: inputs.today,
      nowMinutes: effectiveNowMins,
      windowEndMinutes: Math.max(effectiveWindowEnd, eventStartMins + eventDuration),
      doneForDay: false,
      timetableBlocks: inputs.timetableBlocks,
      fixedTasks: [...inputs.fixedTasks, surpriseFixedTask],
      bufferMinutes: inputs.bufferMinutes,
      urgentTasks: inputs.urgentTasks,
      forced: inputs.forced,
      habitGoals: inputs.habitGoals,
      goals: inputs.goals,
      flexibleTasks: inputs.flexibleTasks,
      defaultUrgentMins: inputs.defaultUrgentMins,
      runSlotStartMins: inputs.runSlotStartMins,
      neglectDays: inputs.neglectDays,
      enableFloor: opts.enableFloor !== undefined ? opts.enableFloor : true
    });

    if (schedule.refused) {
      // Guarantee the surprise event slot even if zero free budget remains for other tasks
      const fallbackSlot = {
        time: surpriseStartStr,
        startMinutes: eventStartMins,
        task: surpriseEvent.trim(),
        priority: 'high',
        duration: eventDuration,
        source: 'surprise_event',
        goal_id: null,
        task_id: null
      };
      savePlanToDb(inputs.today, [fallbackSlot]);
      return {
        success: true,
        engine: 'scheduler',
        date: inputs.today,
        surpriseEvent: surpriseEvent.trim(),
        count: 1,
        plan: [fallbackSlot],
        deferred: [],
        shrunk: [],
        floorSessions: [],
        warnings: [...extraWarnings, schedule.message],
        window: {
          window_set: inputs.windowEndMinutes !== null,
          now_minutes: effectiveNowMins,
          window_end_minutes: effectiveWindowEnd
        },
        plan_note: `Scheduled "${surpriseEvent.trim()}" at ${surpriseStartStr}. ${schedule.message}`
      };
    }

    schedule.warnings = [...extraWarnings, ...(schedule.warnings || [])];
    persistGoalTasksForPlan(inputs.today, schedule.plan);
    savePlanToDb(inputs.today, schedule.plan);
    const plan_note = await buildPlanNote(schedule, inputs.prefs, opts);

    return {
      success: true,
      engine: 'scheduler',
      date: inputs.today,
      surpriseEvent: surpriseEvent.trim(),
      count: schedule.plan.length,
      plan: schedule.plan,
      deferred: schedule.deferred,
      shrunk: schedule.shrunk,
      floorSessions: schedule.floorSessions,
      warnings: schedule.warnings,
      behind_pace: schedule.behind_pace,
      window: {
        window_set: inputs.windowEndMinutes !== null,
        now_minutes: effectiveNowMins,
        now_time: minutesToTimeString(effectiveNowMins),
        window_end_minutes: effectiveWindowEnd,
        window_end_time: minutesToTimeString(effectiveWindowEnd),
        budget_minutes: schedule.budgetMinutes,
        gaps: schedule.gapSummary
      },
      plan_note
    };
  } catch (replanErr) {
    console.error(`🚨 SCHEDULER ERROR in replan — falling back to legacy AI replan:`, replanErr);
    const fallbackPlan = await replanAI(surpriseEvent, dObj);
    return {
      success: true,
      engine: 'ai_fallback',
      date: today,
      surpriseEvent: surpriseEvent.trim(),
      count: fallbackPlan.length,
      plan: fallbackPlan,
      deferred: [],
      shrunk: [],
      floorSessions: [],
      warnings: [`Scheduler error fallback triggered: ${replanErr.message}`],
      plan_note: `Replanned around "${surpriseEvent.trim()}" using fallback planner.`
    };
  }
}

module.exports = {
  generateDayPlan,
  replan,
  generateDayPlanAI,
  replanAI,
  gatherScheduleInputs,
  buildScheduleFromDb,
  persistGoalTasksForPlan,
  buildPlanNote,
  buildDeterministicPlanNote,
  getPlannerEngine
};
