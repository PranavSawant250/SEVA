const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { generateDayPlan, replan } = require('../services/plannerService');
const { getTodayDate } = require('../utils/dateUtils');


// ─────────────────────────────────────────────────────────────
// GET /api/plan/generate
// Triggers AI day plan generation for today, saves to day_plans,
// returns the resulting plan array.
// ─────────────────────────────────────────────────────────────
router.get('/generate', async (req, res) => {
  try {
    console.log('📡 GET /api/plan/generate — triggering day plan generation...');
    const plan = await generateDayPlan();

    res.json({
      success: true,
      date: getTodayDate(),
      count: plan.length,
      plan
    });
  } catch (err) {
    console.error('❌ Error in GET /api/plan/generate:', err.message);
    res.status(500).json({
      error: 'Failed to generate day plan',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/plan/today
// Returns today's saved plan from day_plans table (NO new AI call).
// Returns clear message if no plan has been generated yet today.
// ─────────────────────────────────────────────────────────────
router.get('/today', (req, res) => {
  try {
    const today = getTodayDate();
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
        message: 'No plan generated yet for today. Hit GET /api/plan/generate first.'
      });
    }

    let plan;
    try {
      plan = JSON.parse(row.plan_json);
    } catch (parseErr) {
      console.error('❌ Failed to parse plan_json from day_plans:', parseErr.message);
      return res.status(500).json({
        error: 'Stored plan is malformed',
        details: parseErr.message
      });
    }

    console.log(`   └─ Returning saved plan with ${plan.length} slot(s), generated at ${row.generated_at}`);

    res.json({
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
    res.status(500).json({
      error: 'Failed to fetch today\'s plan',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/plan/replan
// Body: { surpriseEvent: "description of unexpected event" }
// Replans the remaining hours around the surprise event.
// surpriseEvent is required — returns 400 if missing.
// ─────────────────────────────────────────────────────────────
router.post('/replan', async (req, res) => {
  try {
    const { surpriseEvent } = req.body;

    // Validate input — surpriseEvent must be a non-empty string
    if (!surpriseEvent || typeof surpriseEvent !== 'string' || !surpriseEvent.trim()) {
      return res.status(400).json({
        error: 'Missing required field: surpriseEvent',
        message: 'Please provide a non-empty surpriseEvent string in the request body.',
        example: { surpriseEvent: 'Unexpected meeting at 3PM' }
      });
    }

    console.log(`📡 POST /api/plan/replan — surprise event: "${surpriseEvent.trim()}"`);

    const plan = await replan(surpriseEvent.trim());

    res.json({
      success: true,
      date: getTodayDate(),
      surpriseEvent: surpriseEvent.trim(),
      count: plan.length,
      plan
    });
  } catch (err) {
    console.error('❌ Error in POST /api/plan/replan:', err.message);
    res.status(500).json({
      error: 'Failed to replan day',
      details: err.message
    });
  }
});

module.exports = router;
