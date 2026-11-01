const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');
const { routeCommand } = require('../services/chatCommands');
const { processAgentChatMessage } = require('../services/chatAgent');

// ─────────────────────────────────────────────────────────────
// POST /api/chat/message
// Accepts user chat message, persists to chat_history.
// BEFORE calling the AI:
//   - passes the message through the deterministic command router
//   - if the router returns a reply, stores it and returns immediately
//   - otherwise invokes the Gemini Agent with multi-round deterministic tools
// ─────────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const { message, client_request_id } = req.body;

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
    const clientRequestId = client_request_id || `req-${userMsgId}`;

    // Establish and validate session identity securely
    const incomingSessionId = req.headers['x-session-id'] || req.body.session_id;
    let sessionId = null;
    if (incomingSessionId) {
      if (typeof incomingSessionId !== 'string' || !/^[a-zA-Z0-9_\-\.]{8,128}$/.test(incomingSessionId.trim())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SESSION_ID',
          message: 'The provided session identifier is invalid. Expected 8-128 alphanumeric characters, dashes, or dots.'
        });
      }
      sessionId = incomingSessionId.trim();
    } else {
      // Securely establish session from user preferences or generate a cryptographic session token
      const pref = db.prepare("SELECT user_prn FROM preferences WHERE id = 1").get();
      if (pref && pref.user_prn) {
        sessionId = `sess_${pref.user_prn.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      } else {
        sessionId = `sess_${require('crypto').randomBytes(16).toString('hex')}`;
      }
    }

    // 2. Try deterministic command router BEFORE any AI call
    const commandReply = routeCommand(trimmedUserMsg, nowDate, nowDate);

    let reply;
    let badge = 'Local';
    let provider = 'Local (Command Router)';
    let updated = [];

    if (commandReply !== null) {
      // Command handled — reply instantly, no AI call
      reply = commandReply;
      console.log(`   └─ Command handled: "${reply.substring(0, 60)}${reply.length > 60 ? '...' : ''}"`);
    } else {
      // 3. Fall through to Gemini Tool-Calling Agent
      const history = db.prepare(`
        SELECT role, message FROM chat_history
        WHERE date = ? AND id < ?
        ORDER BY id DESC LIMIT 10
      `).all(today, userMsgId).reverse();

      const agentRes = await processAgentChatMessage(trimmedUserMsg, {
        todayDate: nowDate,
        nowDate,
        sessionId,
        messageId: clientRequestId,
        history
      });

      reply = agentRes.reply;
      badge = agentRes.badge || 'Cloud';
      provider = agentRes.provider;
      updated = agentRes.updated || [];
      console.log(`   └─ Agent reply [${badge}]: "${reply.substring(0, 60)}${reply.length > 60 ? '...' : ''}"`);
    }

    // 4. Store reply in chat_history
    db.prepare(
      `INSERT INTO chat_history (date, role, message) VALUES (?, 'assistant', ?)`
    ).run(today, reply);

    return res.json({
      success: true,
      reply,
      badge,
      provider,
      session_id: sessionId,
      updated,
      handled_by: commandReply !== null ? 'command_router' : 'agent'
    });
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
