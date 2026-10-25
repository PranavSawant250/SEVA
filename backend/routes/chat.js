const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { chatWithSeva } = require('../services/aiService');
const { getTodayDate } = require('../utils/dateUtils');
const { routeCommand } = require('../services/chatCommands');

// ─────────────────────────────────────────────────────────────
// POST /api/chat/message
// Accepts user chat message, persists to chat_history.
// BEFORE calling the AI:
//   - passes the message through the deterministic command router
//   - if the router returns a reply, stores it and returns immediately
//   - only if router returns null does the AI handle it
// ─────────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const { message } = req.body;

    // Validate input
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: message',
        message: 'Please provide a non-empty message string in the request body.',
        example: { message: 'What is my plan for today?' }
      });
    }
    if (message.trim().length > 4000) {
      return res.status(400).json({ success: false, error: 'Message too long (max 4000 chars)' });
    }

    const trimmedUserMsg = message.trim();
    const today = getTodayDate();
    const nowDate = new Date();

    console.log(`💬 POST /api/chat/message — user: "${trimmedUserMsg.substring(0, 60)}${trimmedUserMsg.length > 60 ? '...' : ''}"`);

    // 1. Insert user message into chat_history FIRST
    const userInsertResult = db.prepare(
      `INSERT INTO chat_history (date, role, message) VALUES (?, 'user', ?)`
    ).run(today, trimmedUserMsg);

    const userMsgId = userInsertResult.lastInsertRowid;

    // 2. Try deterministic command router BEFORE any AI call
    const commandReply = routeCommand(trimmedUserMsg, nowDate, nowDate);

    let reply;
    if (commandReply !== null) {
      // Command handled — reply instantly, no AI call
      reply = commandReply;
      console.log(`   └─ Command handled: "${reply.substring(0, 60)}${reply.length > 60 ? '...' : ''}"`);
    } else {
      // 3. Fall through to AI
      reply = await chatWithSeva(trimmedUserMsg, userMsgId);
      console.log(`   └─ AI reply: "${reply.substring(0, 60)}${reply.length > 60 ? '...' : ''}"`);
    }

    // 4. Store reply in chat_history
    db.prepare(
      `INSERT INTO chat_history (date, role, message) VALUES (?, 'assistant', ?)`
    ).run(today, reply);

    return res.json({ success: true, reply, handled_by: commandReply !== null ? 'command_router' : 'ai' });
  } catch (err) {
    console.error('❌ Error in POST /api/chat/message:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to process chat message', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/chat/history
// Returns chat history for a specific date (defaults to today).
// ─────────────────────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const targetDate = req.query.date || getTodayDate();
    console.log(`💬 GET /api/chat/history — date: ${targetDate}`);

    const messages = db.prepare(`
      SELECT id, date, role, message, timestamp
      FROM chat_history
      WHERE date = ?
      ORDER BY id ASC
    `).all(targetDate);

    return res.json({ success: true, date: targetDate, count: messages.length, messages });
  } catch (err) {
    console.error('❌ Error in GET /api/chat/history:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch chat history', details: err.message });
  }
});

module.exports = router;
