const express = require('express');
const router = express.Router();

// GET /api/tasks - Get all tasks for today
router.get('/', (req, res) => {
  res.json({ message: 'Get tasks endpoint ready', tasks: [] });
});

// POST /api/tasks - Add manual task
router.post('/', (req, res) => {
  res.json({ message: 'Add task endpoint ready' });
});

// PATCH /api/tasks/:id/complete - Mark task as completed
router.patch('/:id/complete', (req, res) => {
  res.json({ message: `Task ${req.params.id} marked as completed` });
});

// DELETE /api/tasks/:id - Delete a task
router.delete('/:id', (req, res) => {
  res.json({ message: `Task ${req.params.id} deleted` });
});

module.exports = router;
