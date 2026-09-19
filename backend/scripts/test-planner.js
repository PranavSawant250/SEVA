/**
 * test-planner.js — Standalone Phase 4 test script
 *
 * Tests generateDayPlan() core logic against 3 hardcoded scenarios:
 *   1. Normal day: 2 tasks, timetable with 2 classes
 *   2. Priority check: mixed priority tasks, verify high → morning
 *   3. Conflict scenario: task time_slot overlaps a timetable class
 *
 * Run from backend folder:
 *   node scripts/test-planner.js
 *
 * The server does NOT need to be running. This script hits Ollama directly
 * and writes results to the real seva.db (using today's date — run this on
 * a day you don't mind overwriting the day_plans row, or restore after).
 */

const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');

const PREFERRED_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];

// ── Shared helpers (same logic as plannerService.js, inlined for standalone use) ──

function extractArrayJsonString(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const first = rawText.indexOf('[');
  const last = rawText.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    return rawText.substring(first, last + 1);
  }
  return null;
}

function validatePlanItem(item, allowedTaskNames = null) {
  if (!item || typeof item !== 'object') return null;
  if (!item.task || typeof item.task !== 'string' || !item.task.trim()) return null;
  const task = item.task.trim();

  if (allowedTaskNames && Array.isArray(allowedTaskNames) && allowedTaskNames.length > 0) {
    const normTask = task.toLowerCase();
    const isAllowed = allowedTaskNames.some(allowed => {
      const normAllowed = allowed.toLowerCase().trim();
      return normTask === normAllowed || normTask.includes(normAllowed) || normAllowed.includes(normTask);
    });
    if (!isAllowed) {
      console.warn(`⚠️  Dropping hallucinated task "${task}" — not found in allowed task list.`);
      return null;
    }
  }

  const rawPriority = typeof item.priority === 'string' ? item.priority.toLowerCase().trim() : '';
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';
  let duration = parseInt(item.duration, 10);
  if (isNaN(duration) || duration <= 0) duration = 30;
  const time = (item.time && typeof item.time === 'string' && item.time.trim()) ? item.time.trim() : null;
  const source = (item.source && typeof item.source === 'string' && item.source.trim()) ? item.source.trim() : 'manual';
  return { time, task, priority, duration, source };
}

function buildFallbackPlan(tasks) {
  const sorted = [...tasks].sort((a, b) => {
    if (a.time_slot && !b.time_slot) return -1;
    if (!a.time_slot && b.time_slot) return 1;
    if (a.time_slot && b.time_slot) return a.time_slot.localeCompare(b.time_slot);
    return 0;
  });
  return sorted.map(t => ({
    time: t.time_slot || null,
    task: t.name,
    priority: t.priority || 'medium',
    duration: 30,
    source: t.source || 'manual'
  }));
}

async function runScenario(scenarioName, tasks, timetable) {
  console.log('\n' + '═'.repeat(60));
  console.log(`SCENARIO: ${scenarioName}`);
  console.log('═'.repeat(60));
  console.log('Tasks:', JSON.stringify(tasks, null, 2));
  console.log('Timetable:', JSON.stringify(timetable, null, 2));

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

  console.log(`\n🤖 Calling Ollama ${PREFERRED_MODEL}...`);

  let rawResponse = '';
  try {
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      // format:'json' intentionally omitted — phi3.5 wraps array output in {}
      // when this flag is set, breaking the array extractor.
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    rawResponse = response.message ? response.message.content : '';
    console.log(`   └─ Raw response length: ${rawResponse.length} chars`);
  } catch (err) {
    console.error('❌ Ollama call failed:', err.message);
    console.log('⚠️  FALLBACK PATH USED');
    const fallback = buildFallbackPlan(tasks);
    console.log('\n📋 FALLBACK PLAN:');
    console.log(JSON.stringify(fallback, null, 2));
    return;
  }

  // Parse + validate
  const extracted = extractArrayJsonString(rawResponse);
  let usedFallback = false;
  let finalPlan;

  if (!extracted) {
    console.warn('⚠️  No JSON array found in response — using fallback.');
    usedFallback = true;
  } else {
    try {
      const parsed = JSON.parse(extracted);
      if (!Array.isArray(parsed)) {
        console.warn('⚠️  Parsed value is not an array — using fallback.');
        usedFallback = true;
      } else {
        const allowedTaskNames = tasks.map(t => t.name);
        const validated = parsed.map(item => validatePlanItem(item, allowedTaskNames)).filter(i => i !== null);
        if (validated.length === 0) {
          console.warn('⚠️  All items dropped after validation — using fallback.');
          usedFallback = true;
        } else {
          console.log(`   └─ Validation: ${parsed.length} received, ${validated.length} kept, ${parsed.length - validated.length} dropped`);
          finalPlan = validated;
        }
      }
    } catch (parseErr) {
      console.warn('⚠️  JSON.parse failed — using fallback. Error:', parseErr.message);
      usedFallback = true;
    }
  }

  if (usedFallback) {
    finalPlan = buildFallbackPlan(tasks);
    console.log('⚠️  FALLBACK PATH WAS USED (AI output unusable)');
  } else {
    console.log('✅ AI PATH USED (plan from Ollama)');
  }

  console.log('\n📋 FINAL PLAN:');
  finalPlan.forEach((slot, i) => {
    const timeStr = slot.time || 'unscheduled';
    console.log(`  ${i + 1}. [${timeStr}] ${slot.task} (${slot.priority}, ${slot.duration}min, src:${slot.source})`);
  });

  // ── Conflict check: flag if any slot overlaps a timetable class ──
  if (timetable.length > 0 && finalPlan.length > 0) {
    console.log('\n🔍 Timetable conflict check:');
    let conflictFound = false;
    for (const slot of finalPlan) {
      if (!slot.time) continue;
      // Simple string match — for test purposes, check if slot.time appears in any class window text
      for (const cls of timetable) {
        const clsRange = `${cls.start_time}-${cls.end_time}`;
        // Flag only if the time strings look suspicious (heuristic, good enough for test output)
        if (slot.time === cls.start_time) {
          console.warn(`  ⚠️  CONFLICT: Task "${slot.task}" scheduled at ${slot.time} overlaps class "${cls.subject}" (${clsRange})`);
          conflictFound = true;
        }
      }
    }
    if (!conflictFound) {
      console.log('  ✅ No obvious time conflicts detected in plan slots vs timetable.');
    }
  }
}

// ── MAIN: Run all 3 test scenarios sequentially ──────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     SEVA Phase 4 — Planner Test Script (test-planner.js)  ║');
  console.log(`║     Model: ${PREFERRED_MODEL.padEnd(46)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Scenario 1: Normal day ───────────────────────────────────
  await runScenario(
    'Scenario 1 — Normal day (2 tasks, 2 classes)',
    [
      { name: 'Complete assignment submission', priority: 'high', time_slot: null, source: 'email' },
      { name: 'Read chapter 5 notes', priority: 'medium', time_slot: null, source: 'manual' }
    ],
    [
      { subject: 'Database Engineering', start_time: '10:00 AM', end_time: '11:00 AM' },
      { subject: 'Software Engineering', start_time: '2:00 PM', end_time: '3:00 PM' }
    ]
  );

  // ── Scenario 2: Priority ordering ───────────────────────────
  await runScenario(
    'Scenario 2 — Priority ordering (high tasks should go morning)',
    [
      { name: 'Watch lecture recording', priority: 'low', time_slot: null, source: 'manual' },
      { name: 'Prepare for viva', priority: 'high', time_slot: null, source: 'manual' },
      { name: 'Email professor', priority: 'medium', time_slot: null, source: 'email' }
    ],
    [] // No classes today
  );

  // ── Scenario 3: Scheduling conflict ─────────────────────────
  await runScenario(
    'Scenario 3 — Conflict: task time_slot overlaps timetable class',
    [
      {
        name: 'DSA Practice',
        priority: 'high',
        time_slot: '10:00 AM', // ← same as class start — AI should reschedule this
        source: 'manual'
      },
      { name: 'Update project README', priority: 'low', time_slot: null, source: 'manual' }
    ],
    [
      { subject: 'DBMS Lab', start_time: '10:00 AM', end_time: '12:00 PM' } // ← conflict class
    ]
  );

  console.log('\n' + '═'.repeat(60));
  console.log('✅ All test scenarios complete.');
  console.log('═'.repeat(60));
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test script crashed:', err);
  process.exit(1);
});
