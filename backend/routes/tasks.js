const express = require('express');
const router = express.Router();
const TaskService = require('../services/taskService');
const { getTodayDate } = require('../utils/dateUtils');
const { getAllGoals } = require('../services/goalsService');

// ─────────────────────────────────────────────────────────────
// GET /api/tasks/backlog
// Returns all unscheduled tasks (date IS NULL)
// ─────────────────────────────────────────────────────────────
router.get('/backlog', (req, res) => {
  try {
    const result = TaskService.getTasks({ view: 'backlog' });
    return res.json(result);
  } catch (err) {
    console.error('❌ Error fetching backlog tasks:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch backlog tasks', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/tasks
// Supports ?date=YYYY-MM-DD, ?view=backlog, or defaults to today's scheduled tasks
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { date, view } = req.query;

    if (view === 'backlog') {
      const result = TaskService.getTasks({ view: 'backlog' });
      return res.json(result);
    }

    if (date && date !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Expected YYYY-MM-DD or "today".'
      });
    }

    const targetDate = date ? (date === 'today' ? getTodayDate() : date) : getTodayDate();
    console.log(`📋 GET /api/tasks — fetching tasks for date: ${targetDate}`);

    const result = TaskService.getTasks({ date: targetDate });
    return res.json(result);
  } catch (err) {
    console.error('❌ Error fetching tasks:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch tasks', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/tasks
// Body: { name, priority, time_slot, date, duration_min, due_date, fixed_start, fixed_end, is_urgent }
// Adds a task via TaskService.
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const task = TaskService.createTask(req.body);
    return res.status(201).json({
      success: true,
      message: 'Task added successfully.',
      task
    });
  } catch (err) {
    console.error('❌ Error adding task:', err.message);
    const status = err.message.includes('required') || err.message.includes('too long') ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id/complete
// Body: { completed: 0 | 1, now?: string }
// Atomic completion and goal progress update via TaskService.
// ─────────────────────────────────────────────────────────────
router.patch('/:id/complete', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, error: 'Invalid task id — must be an integer.' });
    }

    const requestedStatus = (req.body && (req.body.completed === 0 || req.body.completed === 1))
      ? req.body.completed
      : 1;

    const nowDate = (req.body && req.body.now && !isNaN(new Date(req.body.now).getTime()))
      ? new Date(req.body.now)
      : new Date();

    const result = TaskService.completeTask(taskId, requestedStatus, nowDate);

    if (result.notFound) {
      return res.status(404).json({ success: false, error: result.error });
    }

    let updatedGoal = null;
    if (result.task && result.task.goal_id != null) {
      try {
        updatedGoal = getAllGoals(nowDate).find(g => g.id === result.task.goal_id) || null;
      } catch (_) {}
    }

    return res.json({
      success: true,
      unchanged: Boolean(result.unchanged),
      message: result.message,
      task: result.task,
      progress_action: result.progress_action || null,
      goal: updatedGoal
    });
  } catch (err) {
    console.error('❌ Error completing task:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update task completion', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id
// Updates task attributes (name, date, priority, time_slot, etc.)
// ─────────────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, error: 'Invalid task id — must be an integer.' });
    }

    const result = TaskService.updateTask(taskId, req.body || {});
    if (result.notFound) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      message: `Task ${taskId} updated.`,
      task: result.task
    });
  } catch (err) {
    console.error('❌ Error updating task:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update task', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/tasks/:id
// Permanently deletes task row & syncs Day Plan. Historical goal logs preserved.
// ─────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, error: 'Invalid task id — must be an integer.' });
    }

    const result = TaskService.deleteTask(taskId);
    if (result.notFound) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      message: result.message,
      deleted: result.deleted
    });
  } catch (err) {
    console.error('❌ Error deleting task:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete task', details: err.message });
  }
});

module.exports = router;
