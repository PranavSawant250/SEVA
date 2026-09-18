const express = require('express');
const router = express.Router();

// POST /api/chat/message - Send chat message to SEVA AI
router.get('/message', (req, res) => {
  res.json({ message: 'Chat message endpoint ready' });
});

// GET /api/chat/history - Get all past chat messages
router.get('/history', (req, res) => {
  res.json({ message: 'Get chat history endpoint ready', history: [] });
});

module.exports = router;
