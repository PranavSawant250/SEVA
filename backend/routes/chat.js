const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { chatWithSeva } = require('../services/aiService');
const { getTodayDate } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// POST /api/chat/message
// Accepts user chat message, persists to chat_history, calls SEVA AI,
// persists AI reply, and returns response.
// ─────────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const { message } = req.body;

    // Validate input — message must be a non-empty string
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Missing required field: message',
        message: 'Please provide a non-empty message string in the request body.',
        example: { message: 'What is my plan for today?' }
      });
    }

    const trimmedUserMsg = message.trim();
    const today = getTodayDate();

    console.log(`💬 POST /api/chat/message — user message: "${trimmedUserMsg.substring(0, 50)}..."`);

    // 1. Insert user message into chat_history FIRST
    const userInsertResult = db.prepare(`
      INSERT INTO chat_history (date, role, message)
      VALUES (?, 'user', ?)
    `).run(today, trimmedUserMsg);

    const userMsgId = userInsertResult.lastInsertRowid;

    // 2. Invoke chatWithSeva AI (passing userMsgId to exclude current turn from history query)
    const reply = await chatWithSeva(trimmedUserMsg, userMsgId);

    // 3. Insert SEVA AI response into chat_history SECOND
    db.prepare(`
      INSERT INTO chat_history (date, role, message)
      VALUES (?, 'assistant', ?)
    `).run(today, reply);

    console.log(`   └─ SEVA reply: "${reply.substring(0, 50)}..."`);

    res.json({
      success: true,
      reply
    });
  } catch (err) {
    console.error('❌ Error in POST /api/chat/message:', err.message);
    res.status(500).json({
      error: 'Failed to process chat message',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/chat/history
// Returns chat history for a specific date (defaults to today).
// ─────────────────────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const targetDate = req.query.date || getTodayDate();
    console.log(`💬 GET /api/chat/history — fetching messages for date: ${targetDate}`);

    const messages = db.prepare(`
      SELECT id, date, role, message, timestamp
      FROM chat_history
      WHERE date = ?
      ORDER BY id ASC
    `).all(targetDate);

    res.json({
      success: true,
      date: targetDate,
      count: messages.length,
      messages
    });
  } catch (err) {
    console.error('❌ Error in GET /api/chat/history:', err.message);
    res.status(500).json({
      error: 'Failed to fetch chat history',
      details: err.message
    });
  }
});

module.exports = router;
