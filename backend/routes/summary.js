const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { generateNightSummary } = require('../services/summaryService');
const { getTodayDate } = require('../utils/dateUtils');

// Helper to safely parse JSON strings back into arrays/objects
function safeJsonParse(jsonStr, fallback = []) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/summary/generate
// Triggers night summary generation for today, saves to DB, returns summary.
// ─────────────────────────────────────────────────────────────
router.get('/generate', async (req, res) => {
  try {
    console.log('📡 GET /api/summary/generate — generating night summary...');
    const summary = await generateNightSummary();

    res.json({
      success: true,
      summary
    });
  } catch (err) {
    console.error('❌ Error in GET /api/summary/generate:', err.message);
    res.status(500).json({
      error: 'Failed to generate night summary',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/summary/history
// Query param: ?date=YYYY-MM-DD (optional).
// Without date param → returns ALL night summaries ordered by date DESC.
// Parses completed_tasks/missed_tasks/carry_forward JSON strings into real arrays.
// ─────────────────────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const targetDate = req.query.date;
    let rows;

    if (targetDate) {
      console.log(`📡 GET /api/summary/history — fetching summary for date: ${targetDate}`);
      rows = db.prepare(`
        SELECT id, date, completed_tasks, missed_tasks, carry_forward, seva_message, streak
        FROM night_summary
        WHERE date = ?
      `).all(targetDate);
    } else {
      console.log('📡 GET /api/summary/history — fetching all night summaries...');
      rows = db.prepare(`
        SELECT id, date, completed_tasks, missed_tasks, carry_forward, seva_message, streak
        FROM night_summary
        ORDER BY date DESC
      `).all();
    }

    // Parse JSON strings back into real JS arrays for response
    const summaries = rows.map(r => ({
      id: r.id,
      date: r.date,
      completed_tasks: safeJsonParse(r.completed_tasks, []),
      missed_tasks: safeJsonParse(r.missed_tasks, []),
      carry_forward: safeJsonParse(r.carry_forward, []),
      seva_message: r.seva_message,
      streak: r.streak
    }));

    res.json({
      success: true,
      count: summaries.length,
      summaries
    });
  } catch (err) {
    console.error('❌ Error in GET /api/summary/history:', err.message);
    res.status(500).json({
      error: 'Failed to fetch summary history',
      details: err.message
    });
  }
});

module.exports = router;
