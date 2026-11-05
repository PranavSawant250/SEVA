/**
 * backend/routes/goals.js
 *
 * REST endpoints for the Goals feature.
 * Delegates all business logic, validation, and mutations to goalsService.js.
 */

const express = require('express');
const router = express.Router();
const { getTodayDate } = require('../utils/dateUtils');
const goalsService = require('../services/goalsService');
const db = require('../database/db');

// ─────────────────────────────────────────────────────────────
// POST /api/goals/import — Bulk import from JSON
// ─────────────────────────────────────────────────────────────
router.post('/import', (req, res) => {
  try {
    const today = getTodayDate();
    const result = goalsService.importGoals(req.body, today);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, error: err.error, details: err.details });
    }
    console.error('❌ /api/goals/import error:', err.message);
    return res.status(500).json({ success: false, error: 'Import failed', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/goals/reminders — In-app reminders (skips paused goals)
// ─────────────────────────────────────────────────────────────
router.get('/reminders', (req, res) => {
  try {
    const reminders = goalsService.getGoalReminders(new Date());
    return res.json({
      success: true,
      count: reminders.length,
      in_app_only: true,
      note: 'Reminders appear in-app when SEVA is open; there are no push notifications.',
      reminders
    });
  } catch (err) {
    console.error('❌ GET /api/goals/reminders error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch goal reminders' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/goals — All goals with computed progress
// Supports ?status=active|paused|completed|overdue|all, ?category=..., ?priority=...
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const goals = goalsService.getAllGoals(new Date(), req.query);
    return res.json({ success: true, count: goals.length, goals });
  } catch (err) {
    console.error('❌ GET /api/goals error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch goals' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/goals/:id — Goal details with steps & recent logs
// ─────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const goal = goalsService.getGoalById(goalId, new Date());
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    return res.json({ success: true, goal });
  } catch (err) {
    console.error('❌ GET /api/goals/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch goal details' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/goals — Create a single goal
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const today = getTodayDate();
    const created = goalsService.createGoal(req.body, today);
    return res.status(201).json({ success: true, goal: created });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/goals/:id/log — Log progress (count / frequency / practice)
// ─────────────────────────────────────────────────────────────
router.post('/:id/log', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const today = getTodayDate();
    const result = goalsService.logGoalProgress(goalId, req.body, today);
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/goals/:id/steps — Add step(s) to a milestone goal
// ─────────────────────────────────────────────────────────────
router.post('/:id/steps', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const result = goalsService.manageGoalSteps(goalId, 'add', req.body);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/goals/:id/steps/:stepId — Toggle step done/undone
// ─────────────────────────────────────────────────────────────
router.patch('/:id/steps/:stepId', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const done = req.body.done === 1 || req.body.done === true ? 1 : 0;
    const result = goalsService.manageGoalSteps(goalId, 'toggle', { step_id: stepId, done });
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/goals/:id/steps/:stepId — Soft delete step
// ─────────────────────────────────────────────────────────────
router.delete('/:id/steps/:stepId', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const result = goalsService.manageGoalSteps(goalId, 'delete', { step_id: stepId });
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/goals/:id — Update metadata, status, manual progress
// ─────────────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const today = getTodayDate();

    // Check status transition
    if (req.body.status) {
      const s = String(req.body.status).toLowerCase().trim();
      if (s === 'removed') {
        const delRes = goalsService.deleteGoal(goalId, today);
        return res.json({ success: true, ...delRes });
      } else if (s === 'paused') {
        const pauseRes = goalsService.updateGoalStatus(goalId, 'pause', {}, today);
        return res.json({ success: true, ...pauseRes });
      } else if (s === 'active') {
        const currentGoal = db.prepare('SELECT status, is_paused FROM goals WHERE id = ?').get(goalId);
        if (currentGoal && currentGoal.is_paused) {
          const resRes = goalsService.updateGoalStatus(goalId, 'resume', req.body, today);
          return res.json({ success: true, ...resRes });
        } else if (currentGoal && currentGoal.status === 'completed') {
          const reopenRes = goalsService.updateGoalStatus(goalId, 'reopen', {}, today);
          return res.json({ success: true, ...reopenRes });
        } else if (currentGoal && currentGoal.status === 'removed') {
          const restoreRes = goalsService.updateGoalStatus(goalId, 'restore', {}, today);
          return res.json({ success: true, ...restoreRes });
        }
      } else if (s === 'completed') {
        const compRes = goalsService.updateGoalStatus(goalId, 'complete', {}, today);
        return res.json({ success: true, ...compRes });
      }
    }

    // Manual progress override
    if ('manual_progress' in req.body) {
      if (req.body.manual_progress === null) {
        db.prepare('UPDATE goals SET manual_progress = NULL WHERE id = ?').run(goalId);
      } else {
        const mp = parseInt(req.body.manual_progress, 10);
        if (isNaN(mp) || mp < 0 || mp > 100) {
          return res.status(400).json({ success: false, error: 'manual_progress must be 0-100 or null' });
        }
        db.prepare('UPDATE goals SET manual_progress = ? WHERE id = ?').run(mp, goalId);
        if (mp === 100) {
          goalsService.updateGoalStatus(goalId, 'complete', {}, today);
        }
      }
    }

    // General metadata updates
    const metaUpdates = {};
    if ('title' in req.body) metaUpdates.title = req.body.title;
    if ('category' in req.body) metaUpdates.category = req.body.category;
    if ('priority' in req.body) metaUpdates.priority = req.body.priority;
    if ('deadline' in req.body) metaUpdates.deadline = req.body.deadline;
    if ('target' in req.body) metaUpdates.target = req.body.target;
    if ('target_count' in req.body) metaUpdates.target_count = req.body.target_count;
    if ('per_week' in req.body) metaUpdates.per_week = req.body.per_week;

    if (Object.keys(metaUpdates).length > 0) {
      const updateRes = goalsService.updateGoal(goalId, metaUpdates);
      return res.json({ success: true, ...updateRes });
    }

    const current = goalsService.getGoalById(goalId, new Date());
    return res.json({ success: true, goal: current });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/goals/:id — Soft remove (status='removed')
// Atomically deletes incomplete future/today/backlog tasks & cleans day_plans.plan_json
// ─────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const today = getTodayDate();
    const result = goalsService.deleteGoal(goalId, today);
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.error || err.message });
  }
});

module.exports = router;
