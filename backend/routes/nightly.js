/**
 * backend/routes/nightly.js
 *
 * REST endpoints for the Step 10 Nightly Check-In ("plan tomorrow").
 * All logic is 100% deterministic in services/nightlyService.js (zero AI calls).
 *
 * Endpoints:
 *  POST /api/nightly/start   — start a nightly check-in session (phase = 'await_budget')
 *  POST /api/nightly/reply   — send a reply { text } to the active check-in session
 *  GET  /api/nightly/state   — inspect current check-in session state
 *  POST /api/nightly/cancel  — cancel active check-in session without saving
 *
 * Error shape: { success: false, error: "..." }
 */

const express = require('express');
const router = express.Router();
const {
  startNightlyCheckIn,
  handleNightlyReply,
  getNightlySessionState,
  cancelNightlyCheckIn
} = require('../services/nightlyService');

// ─────────────────────────────────────────────────────────────
// POST /api/nightly/start
// ─────────────────────────────────────────────────────────────
router.post('/start', (req, res) => {
  try {
    const todayDateObj = req.body && req.body.today ? new Date(req.body.today) : new Date();
    const { reply, state } = startNightlyCheckIn(todayDateObj);
    return res.json({
      success: true,
      reply,
      state
    });
  } catch (err) {
    console.error('❌ POST /api/nightly/start error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to start nightly check-in' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/nightly/reply
// Body: { text: string }
// ─────────────────────────────────────────────────────────────
router.post('/reply', (req, res) => {
  try {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ success: false, error: 'Missing required field: text' });
    }
    if (text.length > 1000) {
      return res.status(400).json({ success: false, error: 'Reply text too long (max 1000 chars)' });
    }

    const currentState = getNightlySessionState();
    if (!currentState.active) {
      return res.status(400).json({
        success: false,
        error: 'No active nightly check-in session. Start one with POST /api/nightly/start or say "plan tomorrow" in chat.'
      });
    }

    const todayDateObj = req.body && req.body.today ? new Date(req.body.today) : new Date();
    const reply = handleNightlyReply(text, todayDateObj);
    const updatedState = getNightlySessionState();

    return res.json({
      success: true,
      reply,
      state: updatedState
    });
  } catch (err) {
    console.error('❌ POST /api/nightly/reply error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to process nightly check-in reply' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/nightly/state
// ─────────────────────────────────────────────────────────────
router.get('/state', (req, res) => {
  try {
    const state = getNightlySessionState();
    return res.json({
      success: true,
      state
    });
  } catch (err) {
    console.error('❌ GET /api/nightly/state error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to get nightly check-in state' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/nightly/cancel
// ─────────────────────────────────────────────────────────────
router.post('/cancel', (req, res) => {
  try {
    const result = cancelNightlyCheckIn();
    return res.json({
      success: true,
      ...result,
      state: getNightlySessionState()
    });
  } catch (err) {
    console.error('❌ POST /api/nightly/cancel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to cancel nightly check-in' });
  }
});

module.exports = router;
