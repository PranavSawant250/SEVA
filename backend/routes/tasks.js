const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getTodayDate, parseTimeToMinutes } = require('../utils/dateUtils');
const { getAllGoals } = require('../services/goalsService');

// ─────────────────────────────────────────────────────────────
// GET /api/tasks
// Returns all tasks where date <= today (manual + email + goal)
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const today = getTodayDate();
    console.log(`📋 GET /api/tasks — fetching tasks for date: ${today}`);

    const tasks = db.prepare(`
      SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
             goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
      FROM tasks
      WHERE date <= ?
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        id ASC
    `).all(today);

    console.log(`   └─ Found ${tasks.length} task(s) for today.`);

    res.json({
      success: true,
      date: today,
      count: tasks.length,
      tasks
    });
  } catch (err) {
    console.error('❌ Error fetching tasks:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch tasks', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/tasks
// Body: { name, priority, time_slot, date, duration_min, due_date, fixed_start, fixed_end, is_urgent }
// Adds a manual task. If date = "today", normalizes to real date.
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { name, priority, time_slot, duration_min, due_date, fixed_start, fixed_end, is_urgent } = req.body || {};
    let { date } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Task name is required and must be a non-empty string.' });
    }

    if (name.trim().length > 300) {
      return res.status(400).json({
        success: false,
        error: `Task name is too long (${name.trim().length} chars). Maximum allowed is 300 characters.`
      });
    }

    const today = getTodayDate();
    if (!date || date.toString().trim().toLowerCase() === 'today') {
      date = today;
    }

    const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];
    const normalizedPriority = (priority && ALLOWED_PRIORITIES.includes(priority.toLowerCase()))
      ? priority.toLowerCase()
      : 'medium';

    const normalizedTimeSlot = (time_slot && time_slot.toString().trim())
      ? time_slot.toString().trim()
      : null;

    const normDuration = duration_min != null && !isNaN(parseInt(duration_min, 10))
      ? Math.max(5, Math.min(480, parseInt(duration_min, 10)))
      : null;
    const normFixedStart = fixed_start && String(fixed_start).trim() && parseTimeToMinutes(String(fixed_start)) !== null
      ? String(fixed_start).trim()
      : null;
    const normFixedEnd = fixed_end && String(fixed_end).trim() && parseTimeToMinutes(String(fixed_end)) !== null
      ? String(fixed_end).trim()
      : null;
    const normUrgent = is_urgent ? 1 : 0;
    const normDueDate = due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(due_date).trim())
      ? String(due_date).trim()
      : null;

    const result = db.prepare(`
      INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward, duration_min, due_date, fixed_start, fixed_end, is_urgent)
      VALUES (?, ?, ?, 'manual', 0, ?, 0, ?, ?, ?, ?, ?)
    `).run(name.trim(), normalizedPriority, normalizedTimeSlot, date, normDuration, normDueDate, normFixedStart, normFixedEnd, normUrgent);

    res.status(201).json({
      success: true,
      message: 'Task added successfully.',
      task: {
        id: result.lastInsertRowid,
        name: name.trim(),
        priority: normalizedPriority,
        time_slot: normalizedTimeSlot,
        source: 'manual',
        completed: 0,
        date,
        carry_forward: 0,
        duration_min: normDuration,
        due_date: normDueDate,
        fixed_start: normFixedStart,
        fixed_end: normFixedEnd,
        is_urgent: normUrgent
      }
    });
  } catch (err) {
    console.error('❌ Error adding task:', err.message);
    res.status(500).json({ success: false, error: 'Failed to add task', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id/complete
// Body: { completed: 0 | 1 } — supports toggling both directions.
// For goal-linked tasks (goal_id IS NOT NULL):
//  - Checking (0 → 1) auto-logs progress:
//      count: +1 (capped at target_count)
//      frequency: logs 1 for the day (one-per-day rule)
//      milestone with steps: ticks the next unticked step
//      step-less milestone: logs 'worked' (does not change progress)
//  - Unchecking (1 → 0) reverses the exact log / step created by this task.
//  - Repeated calls with the same completed status are a no-op (cannot double count).
// ─────────────────────────────────────────────────────────────
router.patch('/:id/complete', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, error: 'Invalid task id — must be an integer.' });
    }

    const task = db.prepare(`
      SELECT id, name, date, completed, goal_id, source
      FROM tasks
      WHERE id = ?
    `).get(taskId);

    if (!task) {
      return res.status(404).json({ success: false, error: `No task found with id ${taskId}` });
    }

    const requestedStatus = (req.body && (req.body.completed === 0 || req.body.completed === 1))
      ? req.body.completed
      : 1;

    const nowDate = (req.body && req.body.now && !isNaN(new Date(req.body.now).getTime()))
      ? new Date(req.body.now)
      : new Date();
    const today = getTodayDate(nowDate);
    const wasCompleted = Number(task.completed) === 1;
    const willBeCompleted = Number(requestedStatus) === 1;

    // Idempotency guard: if already in requestedStatus, do NOT double-count or double-reverse
    if (wasCompleted === willBeCompleted) {
      let goalProgress = null;
      if (task.goal_id != null) {
        goalProgress = getAllGoals(nowDate).find(g => g.id === task.goal_id) || null;
      }
      return res.json({
        success: true,
        unchanged: true,
        message: `Task ${taskId} is already ${willBeCompleted ? 'completed' : 'incomplete'} (no duplicate progress change).`,
        task: { id: taskId, name: task.name, completed: requestedStatus, date: task.date, goal_id: task.goal_id },
        goal: goalProgress
      });
    }

    const effectiveDate = (willBeCompleted && task.date < today) ? today : task.date;
    let progressAction = null;

    const toggleTx = db.transaction(() => {
      db.prepare(`UPDATE tasks SET completed = ?, date = ? WHERE id = ?`).run(requestedStatus, effectiveDate, taskId);

      if (task.goal_id == null) return;
      const goal = db.prepare(`SELECT * FROM goals WHERE id = ?`).get(task.goal_id);
      if (!goal || goal.status === 'removed') return;

      const logDate = effectiveDate || today;

      if (willBeCompleted) {
        // Transition 0 → 1: auto-log progress once for this taskId
        const existingTaskLog = db.prepare(`
          SELECT id FROM goal_progress_log
          WHERE goal_id = ? AND (note = ? OR note LIKE ? OR note = ?)
          LIMIT 1
        `).get(goal.id, `task:${taskId}`, `task:${taskId}:step:%`, `worked:task:${taskId}`);

        if (existingTaskLog) {
          progressAction = 'already_logged_for_task';
          return;
        }

        if (goal.goal_type === 'count') {
          const target = goal.target_count || 1;
          const current = goal.current_count || 0;
          const added = Math.max(0, Math.min(1, target - current));
          const newCount = current + added;
          const reachedTarget = newCount >= target;
          db.prepare(`
            UPDATE goals
            SET current_count = ?, status = ?, completed_date = ?
            WHERE id = ?
          `).run(
            newCount,
            reachedTarget ? 'completed' : goal.status,
            reachedTarget ? logDate : goal.completed_date,
            goal.id
          );
          db.prepare(`
            INSERT INTO goal_progress_log (goal_id, date, amount, note)
            VALUES (?, ?, ?, ?)
          `).run(goal.id, logDate, added, `task:${taskId}`);
          progressAction = { type: 'count_increment', added, current_count: newCount, target_count: target };
        } else if (goal.goal_type === 'frequency') {
          const sameDayLog = db.prepare(`
            SELECT id FROM goal_progress_log WHERE goal_id = ? AND date = ? LIMIT 1
          `).get(goal.id, logDate);
          if (!sameDayLog) {
            db.prepare(`
              INSERT INTO goal_progress_log (goal_id, date, amount, note)
              VALUES (?, ?, 1, ?)
            `).run(goal.id, logDate, `task:${taskId}`);
            progressAction = { type: 'frequency_logged', date: logDate };
          } else {
            progressAction = { type: 'frequency_already_logged_today', date: logDate };
          }
        } else {
          // milestone goal
          const steps = db.prepare(`
            SELECT id, step_text, done FROM goal_steps WHERE goal_id = ? ORDER BY id ASC
          `).all(goal.id);

          if (steps.length === 0) {
            // Step-less milestone: log 'worked', does not change progress
            db.prepare(`
              INSERT INTO goal_progress_log (goal_id, date, amount, note)
              VALUES (?, ?, 1, ?)
            `).run(goal.id, logDate, `worked:task:${taskId}`);
            progressAction = { type: 'stepless_worked', note: 'worked' };
          } else {
            const nextStep = steps.find(s => Number(s.done) === 0);
            if (nextStep) {
              db.prepare(`UPDATE goal_steps SET done = 1 WHERE id = ?`).run(nextStep.id);
              db.prepare(`
                INSERT INTO goal_progress_log (goal_id, date, amount, note)
                VALUES (?, ?, 1, ?)
              `).run(goal.id, logDate, `task:${taskId}:step:${nextStep.id}`);
              const allDone = steps.every(s => s.id === nextStep.id || Number(s.done) === 1);
              if (allDone) {
                db.prepare(`UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?`).run(logDate, goal.id);
              }
              progressAction = { type: 'milestone_step_ticked', step_id: nextStep.id, step_text: nextStep.step_text };
            }
          }
        }
      } else {
        // Transition 1 → 0: reverse the exact progress logged by this taskId
        if (goal.goal_type === 'count') {
          const logRow = db.prepare(`
            SELECT id, amount FROM goal_progress_log
            WHERE goal_id = ? AND note = ?
            ORDER BY id DESC LIMIT 1
          `).get(goal.id, `task:${taskId}`);
          if (logRow) {
            const revAmount = logRow.amount || 0;
            const newCount = Math.max(0, (goal.current_count || 0) - revAmount);
            const revertActive = goal.status === 'completed' && newCount < (goal.target_count || 1);
            db.prepare(`
              UPDATE goals
              SET current_count = ?, status = ?, completed_date = ?
              WHERE id = ?
            `).run(
              newCount,
              revertActive ? 'active' : goal.status,
              revertActive ? null : goal.completed_date,
              goal.id
            );
            db.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(logRow.id);
            progressAction = { type: 'count_reversed', subtracted: revAmount, current_count: newCount };
          }
        } else if (goal.goal_type === 'frequency') {
          const info = db.prepare(`
            DELETE FROM goal_progress_log WHERE goal_id = ? AND note = ?
          `).run(goal.id, `task:${taskId}`);
          progressAction = { type: 'frequency_reversed', deleted: info.changes };
        } else {
          // milestone goal
          const stepLog = db.prepare(`
            SELECT id, note FROM goal_progress_log
            WHERE goal_id = ? AND note LIKE ?
            ORDER BY id DESC LIMIT 1
          `).get(goal.id, `task:${taskId}:step:%`);
          if (stepLog) {
            const stepId = parseInt(stepLog.note.split(':step:')[1], 10);
            if (!isNaN(stepId)) {
              db.prepare(`UPDATE goal_steps SET done = 0 WHERE id = ? AND goal_id = ?`).run(stepId, goal.id);
            }
            db.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(stepLog.id);
            if (goal.status === 'completed') {
              db.prepare(`UPDATE goals SET status = 'active', completed_date = NULL WHERE id = ?`).run(goal.id);
            }
            progressAction = { type: 'milestone_step_unticked', step_id: stepId };
          } else {
            const info = db.prepare(`
              DELETE FROM goal_progress_log WHERE goal_id = ? AND note = ?
            `).run(goal.id, `worked:task:${taskId}`);
            progressAction = { type: 'stepless_worked_reversed', deleted: info.changes };
          }
        }
      }
    });

    toggleTx();

    let updatedGoal = null;
    if (task.goal_id != null) {
      updatedGoal = getAllGoals(nowDate).find(g => g.id === task.goal_id) || null;
    }

    const statusLabel = willBeCompleted ? 'completed' : 'incomplete';
    console.log(`✅ Task id=${taskId} ("${task.name}") marked as ${statusLabel}.`);

    return res.json({
      success: true,
      message: `Task ${taskId} marked as ${statusLabel}.`,
      task: { id: taskId, name: task.name, completed: requestedStatus, date: effectiveDate, goal_id: task.goal_id },
      progress_action: progressAction,
      goal: updatedGoal
    });
  } catch (err) {
    console.error('❌ Error completing task:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark task as completed', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/tasks/:id
// Permanently deletes a task row
// ─────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, error: 'Invalid task id — must be an integer.' });
    }

    const task = db.prepare(`SELECT id, name FROM tasks WHERE id = ?`).get(taskId);

    if (!task) {
      return res.status(404).json({ success: false, error: `No task found with id ${taskId}` });
    }

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    console.log(`🗑️ Task id=${taskId} ("${task.name}") deleted.`);

    res.json({
      success: true,
      message: `Task ${taskId} deleted.`,
      deleted: { id: taskId, name: task.name }
    });
  } catch (err) {
    console.error('❌ Error deleting task:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete task', details: err.message });
  }
});

module.exports = router;
