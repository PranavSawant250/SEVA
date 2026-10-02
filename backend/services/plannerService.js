const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const { getTodayDate, getTodayDayOfWeek } = require('../utils/dateUtils');

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
 * Used by: aiService.js (imported separately there, duplicated here for clarity)
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
 * SEPARATE from the object extractor — do not confuse the two.
 * Used by: generateDayPlan() and replan()
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
// PER-ITEM VALIDATION
// Shared by generateDayPlan() and replan() — single source of truth
// ─────────────────────────────────────────────────────────────

/**
 * Validates and normalizes a single plan item from the AI response.
 * Returns the cleaned item, or null if the item should be dropped.
 *
 * Rules (from spec):
 *  - task: non-empty string — DROP item entirely if missing/empty
 *  - task provenance: must match an allowed task name from active task list
 *  - priority: must be in ALLOWED_PRIORITIES — coerce to 'medium' if invalid
 *  - duration: positive number — default to 30 if missing or invalid
 *  - time: keep if non-empty string, else null
 *  - source: keep if non-empty string, else 'manual'
 */
function validatePlanItem(item, allowedTaskNames = null) {
  if (!item || typeof item !== 'object') return null;

  // task is mandatory — drop if missing or empty
  if (!item.task || typeof item.task !== 'string' || !item.task.trim()) {
    return null;
  }

  const task = item.task.trim();

  // Task provenance check: drop AI-hallucinated tasks not present in allowedTaskNames (STRICT MATCH)
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

  // priority: normalize case, coerce unknown values to 'medium'
  const rawPriority = typeof item.priority === 'string' ? item.priority.toLowerCase().trim() : '';
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';

  // duration: must be a positive number, default 30
  let duration = parseInt(item.duration, 10);
  if (isNaN(duration) || duration <= 0) {
    duration = 30;
  }

  // time: keep as-is if non-empty string, else null
  const time = (item.time && typeof item.time === 'string' && item.time.trim())
    ? item.time.trim()
    : null;

  // source: keep if non-empty string, else 'manual'
  const source = (item.source && typeof item.source === 'string' && item.source.trim())
    ? item.source.trim()
    : 'manual';

  return { time, task, priority, duration, source };
}

/**
 * Parse and validate an AI array response.
 * Returns { items: [...], usedFallback: false } on success,
 * or { items: null, usedFallback: true } if parsing/extraction fails.
 */
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

  // Validate every item — drop nulls (items with missing or hallucinated task name)
  const validItems = parsed.map(item => validatePlanItem(item, allowedTaskNames)).filter(item => item !== null);

  if (validItems.length === 0) {
    console.warn('⚠️ All items dropped after validation — empty/hallucinated plan from AI.');
    return { items: null, usedFallback: true };
  }

  // ── Deduplication: each real task name may appear ONLY ONCE in the final plan ──
  // Applied AFTER whitelist check — both checks are required.
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
  const generatedAt = new Date().toISOString();

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

// ─────────────────────────────────────────────────────────────
// FALLBACK PLAN (when AI fails entirely)
// ─────────────────────────────────────────────────────────────

/**
 * Build a basic non-AI plan from raw task rows.
 * Orders by time_slot (nulls last), wraps each in the standard plan shape.
 */
function buildFallbackPlan(tasks) {
  const sorted = [...tasks].sort((a, b) => {
    if (a.time_slot && !b.time_slot) return -1;
    if (!a.time_slot && b.time_slot) return 1;
    if (a.time_slot && b.time_slot) return a.time_slot.localeCompare(b.time_slot);
    return 0;
  });

  // Deduplicate by name — keep only the first occurrence of each task name
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
    source: t.source || 'manual'
  }));
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — generateDayPlan()
// ─────────────────────────────────────────────────────────────

/**
 * Generates an hour-by-hour AI day plan for today.
 *
 * Data sources:
 *  - tasks table WHERE date = today  (manual tasks + accepted email-derived tasks)
 *  - timetable table (all rows, filtered to today's day_of_week at prompt level)
 *
 * The planner only reads from tasks — it does NOT re-query emails.
 * Accepted emails already live in tasks (source = 'email') from Step 0.
 *
 * @returns {Array} Plan array of { time, task, priority, duration, source }
 */
async function generateDayPlan() {
  const today = getTodayDate();
  const todayDayOfWeek = getTodayDayOfWeek();

  console.log(`\n🗓️  generateDayPlan() called for date: ${today} (${todayDayOfWeek})`);

  // ── 1. Fetch active incomplete tasks (today or past uncompleted) ──
  console.log(`📋 Fetching incomplete tasks for date <= ${today}...`);
  const tasks = db.prepare(`
    SELECT id, name, priority, time_slot, source, completed
    FROM tasks
    WHERE date <= ? AND completed = 0
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all(today);
  console.log(`   └─ ${tasks.length} incomplete task(s) found for today.`);

  // ── 2. Fetch timetable for today's day of week ──────────────
  console.log(`📅 Fetching timetable for day_of_week = ${todayDayOfWeek}...`);
  const timetable = db.prepare(`
    SELECT day_of_week, subject, start_time, end_time
    FROM timetable
    WHERE day_of_week = ?
    ORDER BY start_time ASC
  `).all(todayDayOfWeek);
  console.log(`   └─ ${timetable.length} timetable slot(s) found for ${todayDayOfWeek}.`);

  // ── 3. If no tasks at all, return empty plan (nothing to schedule) ──
  if (tasks.length === 0) {
    console.log('ℹ️  No tasks to schedule today. Returning empty plan.');
    const emptyPlan = [];
    savePlanToDb(today, emptyPlan);
    return emptyPlan;
  }

  // ── 4. Format context strings for the AI prompt ─────────────
  const timetableText = timetable.length > 0
    ? timetable.map(t => `  - ${t.subject}: ${t.start_time} to ${t.end_time}`).join('\n')
    : '  (No classes scheduled today)';

  const tasksText = tasks.map(t =>
    `  - "${t.name}" | priority: ${t.priority} | preferred time: ${t.time_slot || 'flexible'} | source: ${t.source}`
  ).join('\n');

  // ── 5. Call Ollama phi3.5 ───────────────────────────────────
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

  console.log(`🤖 Calling Ollama model "${PREFERRED_MODEL}" for day plan generation...`);

  let rawResponse = '';
  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      // NOTE: format:'json' is intentionally NOT set here.
      // phi3.5 wraps its output in {} when forced to JSON-object mode,
      // which breaks the array extractor. Without the flag, the model
      // returns a plain [...] array in its text output as instructed.
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    rawResponse = response.message ? response.message.content : '';
    console.log(`   └─ Raw AI response length: ${rawResponse.length} chars.`);
  } catch (ollamaErr) {
    console.error(`❌ Ollama call failed: ${ollamaErr.message}`);
    console.warn('⚠️  Using fallback plan (task ordering by time_slot).');
    const fallbackPlan = buildFallbackPlan(tasks);
    savePlanToDb(today, fallbackPlan);
    return fallbackPlan;
  }

  // ── 6. Parse + validate AI response ────────────────────────
  const allowedTaskNames = tasks.map(t => t.name);
  const { items, usedFallback } = parseAndValidatePlanArray(rawResponse, allowedTaskNames);

  let finalPlan;
  if (usedFallback || !items) {
    console.warn('⚠️  AI plan parsing/validation failed. Using fallback plan (task ordering by time_slot).');
    finalPlan = buildFallbackPlan(tasks);
  } else {
    finalPlan = items;
    console.log(`✅ AI plan generated with ${finalPlan.length} valid slot(s).`);
  }

  // ── 7. Persist to day_plans table ──────────────────────────
  savePlanToDb(today, finalPlan);

  return finalPlan;
}

/**
 * Helper to construct a guaranteed slot object for a surprise event.
 * Extracts time if present in string (e.g. "2 PM"), defaults priority to 'high' and source to 'surprise_event'.
 */
function createSurpriseEventSlot(surpriseEvent) {
  let extractedTime = null;
  const timeMatch = surpriseEvent.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/i);
  if (timeMatch) {
    extractedTime = timeMatch[1].toUpperCase();
  }

  return {
    time: extractedTime,
    task: surpriseEvent.trim(),
    priority: 'high',
    duration: 60,
    source: 'surprise_event'
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — replan()
// ─────────────────────────────────────────────────────────────

/**
 * Replans the remaining hours of today around a surprise event.
 *
 * @param {string} surpriseEvent - Description of the unexpected event (e.g. "Unexpected meeting at 3PM")
 * @returns {Array} Updated plan array covering remaining hours only
 */
async function replan(surpriseEvent) {
  const today = getTodayDate();

  // Calculate remaining hours server-side (current time → 11:59 PM)
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 0, 0);
  const remainingMs = endOfDay.getTime() - now.getTime();
  const remainingHours = Math.max(0, (remainingMs / (1000 * 60 * 60)).toFixed(1));

  console.log(`\n🔄 replan() called for date: ${today}`);
  console.log(`   └─ Surprise event: "${surpriseEvent}"`);
  console.log(`   └─ Remaining hours in day (server-computed): ${remainingHours}h`);

  // ── 1. Fetch all incomplete tasks for today or past days ─────────────────
  console.log(`📋 Fetching incomplete tasks for date <= ${today}...`);
  const incompleteTasks = db.prepare(`
    SELECT id, name, priority, time_slot, source, completed
    FROM tasks
    WHERE date <= ? AND completed = 0
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all(today);
  console.log(`   └─ ${incompleteTasks.length} incomplete task(s) to replan.`);

  if (incompleteTasks.length === 0) {
    console.log('ℹ️  No incomplete tasks — returning plan with surprise event only.');
    const emptyPlan = [createSurpriseEventSlot(surpriseEvent)];
    savePlanToDb(today, emptyPlan);
    return emptyPlan;
  }

  // ── 2. Format context for prompt ───────────────────────────
  const tasksText = incompleteTasks.map(t =>
    `  - "${t.name}" | priority: ${t.priority} | source: ${t.source}`
  ).join('\n');

  // ── 3. Call Ollama phi3.5 ───────────────────────────────────
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
- Return a JSON array only
- Format: [{"time": "3:30 PM", "task": "task name", "priority": "high", "duration": 45}]`;

  console.log(`🤖 Calling Ollama model "${PREFERRED_MODEL}" for replan...`);

  let rawResponse = '';
  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      // NOTE: format:'json' intentionally omitted — see generateDayPlan() comment above.
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    rawResponse = response.message ? response.message.content : '';
    console.log(`   └─ Raw AI response length: ${rawResponse.length} chars.`);
  } catch (ollamaErr) {
    console.error(`❌ Ollama call failed: ${ollamaErr.message}`);
    console.warn('⚠️  Using fallback replan (task ordering by priority).');
    const fallbackPlan = buildFallbackPlan(incompleteTasks);
    const mergedFallback = [createSurpriseEventSlot(surpriseEvent), ...fallbackPlan];
    savePlanToDb(today, mergedFallback);
    return mergedFallback;
  }

  // ── 4. Parse + validate (strict match against real incomplete tasks ONLY) ────────────
  const allowedTaskNames = incompleteTasks.map(t => t.name);
  const { items, usedFallback } = parseAndValidatePlanArray(rawResponse, allowedTaskNames);

  let taskSlots;
  if (usedFallback || !items) {
    console.warn('⚠️  Replan parsing/validation failed. Using fallback plan (priority ordering).');
    taskSlots = buildFallbackPlan(incompleteTasks);
  } else {
    taskSlots = items;
    console.log(`✅ Replan generated with ${taskSlots.length} valid task slot(s).`);
  }

  // ── 5. Guaranteed server-side injection of the surprise event slot ──
  const surpriseSlot = createSurpriseEventSlot(surpriseEvent);
  const finalPlan = [surpriseSlot, ...taskSlots];

  // ── 6. UPDATE today's existing plan row (never INSERT for replans) ──
  savePlanToDb(today, finalPlan);
  console.log(`🔄 day_plans updated for ${today} with replanned schedule (${finalPlan.length} total slot(s)).`);

  return finalPlan;
}

module.exports = {
  generateDayPlan,
  replan
};
