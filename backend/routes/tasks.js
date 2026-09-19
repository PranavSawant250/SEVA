const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');


// ─────────────────────────────────────────────────────────────
// GET /api/tasks
// Returns all tasks where date = today (manual + email-derived)
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const today = getTodayDate();
    console.log(`📋 GET /api/tasks — fetching tasks for date: ${today}`);

    const tasks = db.prepare(`
      SELECT id, name, priority, time_slot, source, completed, date, carry_forward
      FROM tasks
      WHERE date = ?
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
    res.status(500).json({ error: 'Failed to fetch tasks', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/tasks
// Body: { name, priority, time_slot, date }
// Adds a manual task. If date = "today", normalizes to real date.
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { name, priority, time_slot } = req.body;
    let { date } = req.body;

    // Validate required field
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Task name is required and must be a non-empty string.' });
    }

    // Normalize date: if "today" (or missing), use today's real date
    const today = getTodayDate();
    if (!date || date.toString().trim().toLowerCase() === 'today') {
      date = today;
      console.log(`📋 POST /api/tasks — date was "today", normalized to: ${date}`);
    }

    // Normalize priority
    const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];
    const normalizedPriority = (priority && ALLOWED_PRIORITIES.includes(priority.toLowerCase()))
      ? priority.toLowerCase()
      : 'medium';

    const normalizedTimeSlot = (time_slot && time_slot.toString().trim())
      ? time_slot.toString().trim()
      : null;

    console.log(`📋 POST /api/tasks — Adding manual task: "${name.trim()}" | priority: ${normalizedPriority} | date: ${date}`);

    const result = db.prepare(`
      INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward)
      VALUES (?, ?, ?, 'manual', 0, ?, 0)
    `).run(name.trim(), normalizedPriority, normalizedTimeSlot, date);

    console.log(`   └─ Task inserted with id=${result.lastInsertRowid}`);

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
        carry_forward: 0
      }
    });
  } catch (err) {
    console.error('❌ Error adding task:', err.message);
    res.status(500).json({ error: 'Failed to add task', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id/complete
// Marks a single task as completed (completed = 1)
// ─────────────────────────────────────────────────────────────
router.patch('/:id/complete', (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task id — must be an integer.' });
    }

    // Confirm the task exists first
    const task = db.prepare(`SELECT id, name, completed FROM tasks WHERE id = ?`).get(taskId);

    if (!task) {
      return res.status(404).json({ error: `No task found with id ${taskId}` });
    }

    if (task.completed === 1) {
      return res.status(409).json({
        error: 'Already completed',
        message: `Task ${taskId} ("${task.name}") is already marked as completed.`
      });
    }

    db.prepare(`UPDATE tasks SET completed = 1 WHERE id = ?`).run(taskId);
    console.log(`✅ Task id=${taskId} ("${task.name}") marked as completed.`);

    res.json({
      success: true,
      message: `Task ${taskId} marked as completed.`,
      task: { id: taskId, name: task.name, completed: 1 }
    });
  } catch (err) {
    console.error('❌ Error completing task:', err.message);
    res.status(500).json({ error: 'Failed to mark task as completed', details: err.message });
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
      return res.status(400).json({ error: 'Invalid task id — must be an integer.' });
    }

    const task = db.prepare(`SELECT id, name FROM tasks WHERE id = ?`).get(taskId);

    if (!task) {
      return res.status(404).json({ error: `No task found with id ${taskId}` });
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
    res.status(500).json({ error: 'Failed to delete task', details: err.message });
  }
});

module.exports = router;
