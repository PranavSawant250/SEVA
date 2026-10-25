/**
 * backend/routes/goals.js
 *
 * REST endpoints for the Goals feature.
 * All logic is in goalsService.js — this file is routing + error handling only.
 *
 * Endpoints:
 *  POST  /api/goals/import            — bulk import from JSON
 *  GET   /api/goals                   — all goals with computed progress
 *  POST  /api/goals/:id/log           — log progress (count / frequency)
 *  PATCH /api/goals/:id/steps/:stepId — tick/untick a milestone step
 *  PATCH /api/goals/:id               — update title/priority/deadline/status/manual_progress
 *  DELETE /api/goals/:id              — soft remove (sets status='removed')
 *
 * Error shape: { success: false, error: "...", details?: [...] }
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');
const { importGoals, getAllGoals, computeGoalProgress } = require('../services/goalsService');

// ─────────────────────────────────────────────────────────────
// POST /api/goals/import
// ─────────────────────────────────────────────────────────────
router.post('/import', (req, res) => {
  try {
    const today = getTodayDate();
    const result = importGoals(req.body, today);
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
// GET /api/goals
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const goals = getAllGoals(new Date());
    return res.json({ success: true, count: goals.length, goals });
  } catch (err) {
    console.error('❌ GET /api/goals error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch goals' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/goals/:id/log
// Body: { amount?: number, note?: string }
// count goals: adds amount to current_count (capped at target_count)
// frequency goals: records one entry for today (max one counted per day)
// milestone / step-less: records a 'worked' log entry
// ─────────────────────────────────────────────────────────────
router.post('/:id/log', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.status === 'removed') return res.status(400).json({ success: false, error: 'Cannot log progress on a removed goal' });
    if (goal.status === 'completed') return res.status(400).json({ success: false, error: 'Cannot log progress on a completed goal' });

    const today = getTodayDate();
    const amount = (typeof req.body.amount === 'number' && req.body.amount > 0) ? req.body.amount : 1;
    const note = (req.body.note && typeof req.body.note === 'string') ? req.body.note.substring(0, 200) : null;

    if (goal.goal_type === 'count') {
      // Cap at target_count
      const target = goal.target_count || Infinity;
      const newCount = Math.min(goal.current_count + amount, target);
      const delta = newCount - goal.current_count;
      db.prepare('UPDATE goals SET current_count = ? WHERE id = ?').run(newCount, goalId);
      db.prepare('INSERT INTO goal_progress_log (goal_id, date, amount, note) VALUES (?, ?, ?, ?)')
        .run(goalId, today, delta, note);

      // Auto-complete when count reaches target
      if (target !== Infinity && newCount >= target) {
        db.prepare("UPDATE goals SET status='completed', completed_date=? WHERE id=?").run(today, goalId);
      }

      return res.json({ success: true, current_count: newCount, logged: delta, capped: newCount < goal.current_count + amount });
    }

    if (goal.goal_type === 'frequency') {
      // One count per day rule: check if already logged today
      const existing = db.prepare(
        'SELECT id FROM goal_progress_log WHERE goal_id = ? AND date = ?'
      ).get(goalId, today);
      if (existing) {
        return res.json({ success: true, message: 'Already logged for today — one session per day counts.', logged: 0 });
      }
      db.prepare('INSERT INTO goal_progress_log (goal_id, date, amount, note) VALUES (?, ?, 1, ?)').run(goalId, today, note);
      return res.json({ success: true, logged: 1, date: today });
    }

    // Milestone (with or without steps): log 'worked' for step-less goals
    db.prepare('INSERT INTO goal_progress_log (goal_id, date, amount, note) VALUES (?, ?, ?, ?)')
      .run(goalId, today, 1, note || 'worked');
    return res.json({ success: true, logged: 1, note: 'Session logged. Update steps or set manual progress to track completion.' });
  } catch (err) {
    console.error('❌ POST /api/goals/:id/log error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to log progress' });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/goals/:id/steps/:stepId
// Body: { done: 0 | 1 }
// ─────────────────────────────────────────────────────────────
router.patch('/:id/steps/:stepId', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const done = req.body.done === 1 || req.body.done === true ? 1 : 0;

    const step = db.prepare('SELECT * FROM goal_steps WHERE id = ? AND goal_id = ?').get(stepId, goalId);
    if (!step) return res.status(404).json({ success: false, error: 'Step not found' });

    db.prepare('UPDATE goal_steps SET done = ? WHERE id = ?').run(done, stepId);

    // Auto-complete milestone goal if all steps done
    const today = getTodayDate();
    const steps = db.prepare('SELECT done FROM goal_steps WHERE goal_id = ?').all(goalId);
    const allDone = steps.every(s => s.done === 1);
    if (allDone && steps.length > 0) {
      db.prepare("UPDATE goals SET status='completed', completed_date=? WHERE id=?").run(today, goalId);
    }

    return res.json({ success: true, step_id: stepId, done });
  } catch (err) {
    console.error('❌ PATCH /api/goals/:id/steps/:stepId error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update step' });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/goals/:id
// Body: any subset of { title, priority, deadline, status, manual_progress }
// Explicit null for manual_progress clears the override (checks key presence).
// ─────────────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });

    const updates = {};
    const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];
    const ALLOWED_STATUSES = ['active', 'completed', 'removed'];

    if ('title' in req.body) {
      const t = (req.body.title || '').toString().trim();
      if (!t || t.length > 200) return res.status(400).json({ success: false, error: 'title must be 1-200 chars' });
      updates.title = t;
    }
    if ('priority' in req.body) {
      const p = (req.body.priority || '').toLowerCase().trim();
      if (!ALLOWED_PRIORITIES.includes(p)) return res.status(400).json({ success: false, error: 'priority must be high/medium/low' });
      updates.priority = p;
    }
    if ('deadline' in req.body) {
      const d = req.body.deadline;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ success: false, error: 'deadline must be YYYY-MM-DD' });
      updates.deadline = d;
    }
    if ('status' in req.body) {
      const s = (req.body.status || '').toLowerCase().trim();
      if (!ALLOWED_STATUSES.includes(s)) return res.status(400).json({ success: false, error: 'status must be active/completed/removed' });
      updates.status = s;
      if (s === 'completed') updates.completed_date = getTodayDate();
      if (s === 'active') updates.completed_date = null;
    }
    // Explicit null check: clear manual override; presence check not truthiness
    if ('manual_progress' in req.body) {
      if (req.body.manual_progress === null) {
        updates.manual_progress = null;
      } else {
        const mp = parseInt(req.body.manual_progress, 10);
        if (isNaN(mp) || mp < 0 || mp > 100) return res.status(400).json({ success: false, error: 'manual_progress must be 0-100 or null' });
        updates.manual_progress = mp;
        if (mp === 100) {
          updates.status = 'completed';
          updates.completed_date = getTodayDate();
        }
      }
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE goals SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), goalId);

    return res.json({ success: true, updated: updates });
  } catch (err) {
    console.error('❌ PATCH /api/goals/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update goal' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/goals/:id — soft remove (status = 'removed')
// Deletes INCOMPLETE tasks dated today or later; keeps history.
// ─────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const goalId = parseInt(req.params.id, 10);
    const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(goalId);
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });

    const today = getTodayDate();
    db.transaction(() => {
      db.prepare("UPDATE goals SET status='removed' WHERE id=?").run(goalId);
      db.prepare("DELETE FROM tasks WHERE goal_id=? AND completed=0 AND date>=?").run(goalId, today);
    })();

    return res.json({ success: true, message: `Goal "${goal.title}" removed. Completed tasks and history preserved.` });
  } catch (err) {
    console.error('❌ DELETE /api/goals/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove goal' });
  }
});

module.exports = router;
