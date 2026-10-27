const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { generateDayPlan, replan } = require('../services/plannerService');
const { getTodayDate } = require('../utils/dateUtils');

function resolveNowDate(req) {
  const raw = (req.query && req.query.now) || (req.body && req.body.now) || process.env.SEVA_TEST_NOW;
  if (raw) {
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

// ─────────────────────────────────────────────────────────────
// GET /api/plan/generate
// Uses buildDaySchedule (or legacy AI if PLANNER_ENGINE=ai),
// saves to day_plans, persists goal task rows once per (goal_id, date),
// and returns plan + deferred + shrunk + floorSessions + warnings + window + plan_note.
// If window isn't set: { success: false, needs_window: true, message, hint }.
// ─────────────────────────────────────────────────────────────
router.get('/generate', async (req, res) => {
  try {
    const nowDate = resolveNowDate(req);
    const engineOverride = req.query && req.query.engine ? String(req.query.engine) : undefined;
    console.log('📡 GET /api/plan/generate — triggering day plan generation...');
    const result = await generateDayPlan(nowDate, { engine: engineOverride });

    if (!result.success) {
      return res.json({
        success: false,
        refused: Boolean(result.refused),
        reason: result.reason || null,
        needs_window: Boolean(result.needs_window),
        message: result.message,
        hint: result.hint || null,
        window: result.window || null
      });
    }

    return res.json(result);
  } catch (err) {
    console.error('❌ Error in GET /api/plan/generate:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate day plan',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/plan/today
// Returns today's saved plan from day_plans table (NO new AI call).
// Syncs task completion flags from `tasks` table when task_id is present.
// ─────────────────────────────────────────────────────────────
router.get('/today', (req, res) => {
  try {
    const nowDate = resolveNowDate(req);
    const today = getTodayDate(nowDate);
    console.log(`📡 GET /api/plan/today — fetching saved plan for date: ${today}`);

    const row = db.prepare(`
      SELECT id, date, plan_json, generated_at, completed_count, missed_count
      FROM day_plans
      WHERE date = ?
    `).get(today);

    if (!row) {
      console.log('   └─ No plan found for today.');
      return res.json({
        success: false,
        error: 'No plan generated yet for today. Hit GET /api/plan/generate first.',
        message: 'No plan generated yet for today. Hit GET /api/plan/generate first.'
      });
    }

    let plan;
    try {
      plan = JSON.parse(row.plan_json);
    } catch (parseErr) {
      console.error('❌ Failed to parse plan_json from day_plans:', parseErr.message);
      return res.status(500).json({
        success: false,
        error: 'Stored plan is malformed',
        details: parseErr.message
      });
    }

    const findTaskStmt = db.prepare('SELECT id, completed FROM tasks WHERE id = ?');
    for (const item of plan) {
      if (item && item.task_id != null) {
        const tRow = findTaskStmt.get(item.task_id);
        if (tRow) item.completed = tRow.completed;
      }
    }

    return res.json({
      success: true,
      date: row.date,
      generated_at: row.generated_at,
      completed_count: row.completed_count,
      missed_count: row.missed_count,
      count: plan.length,
      plan
    });
  } catch (err) {
    console.error('❌ Error in GET /api/plan/today:', err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch today's plan",
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/plan/replan
// Body: { surpriseEvent: "description of unexpected event" }
// Inserts surpriseEvent as a fixed block (source 'surprise_event') at parsed time
// (or next free time) and re-runs the scheduler for the rest of the window.
// ─────────────────────────────────────────────────────────────
router.post('/replan', async (req, res) => {
  try {
    const { surpriseEvent } = req.body || {};

    if (!surpriseEvent || typeof surpriseEvent !== 'string' || !surpriseEvent.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: surpriseEvent (must be a non-empty string).'
      });
    }
    if (surpriseEvent.trim().length > 300) {
      return res.status(400).json({
        success: false,
        error: 'surpriseEvent is too long (maximum 300 characters).'
      });
    }

    const nowDate = resolveNowDate(req);
    const engineOverride = (req.body && req.body.engine) || (req.query && req.query.engine) || undefined;
    console.log(`📡 POST /api/plan/replan — surprise event: "${surpriseEvent.trim()}"`);

    const result = await replan(surpriseEvent.trim(), nowDate, { engine: engineOverride });
    return res.json(result);
  } catch (err) {
    console.error('❌ Error in POST /api/plan/replan:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to replan day',
      details: err.message
    });
  }
});

module.exports = router;
