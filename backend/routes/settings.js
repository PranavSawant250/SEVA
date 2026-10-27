/**
 * backend/routes/settings.js
 *
 * Endpoints for daily window and user preferences.
 *
 * GET  /api/settings/today        — get today's window state
 * PUT  /api/settings/today        — set window_end or done_for_day
 * GET  /api/settings/preferences  — get all preferences
 * PUT  /api/settings/preferences  — update any preference field
 *
 * Window logic:
 *  - Window START = now (caller computes; server returns current minutes)
 *  - Window END   = window_end_minutes stored for today, else yesterday's, else null
 *  - "I have N hours/minutes" → convert now+N to absolute end immediately
 *  - done_for_day = 1 → scheduler places nothing more
 *  - When window not set, hint from daily_settings.available_minutes for tomorrow
 *
 * Error shape: { success: false, error: "..." }
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getTodayDate, getYesterdayDate, parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function getNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function getTodayWindow(todayStr) {
  const todayRow = db.prepare('SELECT * FROM daily_settings WHERE date = ?').get(todayStr);
  if (todayRow && (todayRow.window_end_minutes !== null || todayRow.done_for_day === 1)) {
    return { source: 'today', ...todayRow };
  }
  // Fall back to yesterday's window (computed relative to todayStr, not system clock)
  const [y, m, d] = todayStr.split('-').map(Number);
  const yd = getYesterdayDate(new Date(y, m - 1, d));
  const ydRow = db.prepare('SELECT * FROM daily_settings WHERE date = ?').get(yd);
  if (ydRow && ydRow.window_end_minutes !== null) {
    return { source: 'yesterday', date: yd, window_end_minutes: ydRow.window_end_minutes, done_for_day: 0 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/settings/today
// Returns the current window state for today.
// ─────────────────────────────────────────────────────────────
router.get('/today', (req, res) => {
  try {
    const today = getTodayDate();
    const nowMins = getNowMinutes();
    const windowData = getTodayWindow(today);

    if (!windowData) {
      // No window set — check if there's a tomorrow-budget hint from last night's check-in
      const hint = db.prepare('SELECT available_minutes FROM daily_settings WHERE date = ?').get(today);
      return res.json({
        success: true,
        window_set: false,
        now_minutes: nowMins,
        now_time: minutesToTimeString(nowMins),
        message: 'No window set for today. Say "free till 9 PM" or "I have 4 hours" to set your window.',
        tonight_budget_hint: (hint && hint.available_minutes) ? hint.available_minutes : null
      });
    }

    const endMins = windowData.window_end_minutes;
    const remainingMins = Math.max(0, endMins - nowMins);

    return res.json({
      success: true,
      window_set: true,
      source: windowData.source,
      date: windowData.date || today,
      now_minutes: nowMins,
      now_time: minutesToTimeString(nowMins),
      window_end_minutes: endMins,
      window_end_time: minutesToTimeString(endMins),
      remaining_minutes: remainingMins,
      done_for_day: windowData.done_for_day === 1
    });
  } catch (err) {
    console.error('❌ GET /api/settings/today error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to get window state' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/today
// Body options:
//  { window_end_time: "9:00 PM" }        → store absolute minutes
//  { available_minutes: 240 }             → store now + N as absolute end
//  { done_for_day: true }
// ─────────────────────────────────────────────────────────────
router.put('/today', (req, res) => {
  try {
    const today = getTodayDate();
    const nowMins = getNowMinutes();
    const updates = {};

    if ('window_end_time' in req.body) {
      const mins = parseTimeToMinutes(req.body.window_end_time);
      if (mins === null) {
        return res.status(400).json({ success: false, error: 'window_end_time must be "H:MM AM/PM"' });
      }
      updates.window_end_minutes = mins;
    }

    if ('available_minutes' in req.body) {
      const n = parseInt(req.body.available_minutes, 10);
      if (isNaN(n) || n < 15 || n > 960) {
        return res.status(400).json({ success: false, error: 'available_minutes must be 15–960' });
      }
      updates.available_minutes = n;
      updates.window_end_minutes = nowMins + n; // absolute end, never slides
    }

    if ('done_for_day' in req.body) {
      updates.done_for_day = req.body.done_for_day ? 1 : 0;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const cols = Object.keys(updates);
    const vals = Object.values(updates);
    const setClauses = cols.map(c => `${c} = excluded.${c}`).join(', ');

    db.prepare(`
      INSERT INTO daily_settings (date, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
      ON CONFLICT(date) DO UPDATE SET ${setClauses}
    `).run(today, ...vals);

    // Re-read and return
    const row = db.prepare('SELECT * FROM daily_settings WHERE date = ?').get(today);
    return res.json({
      success: true,
      updated: updates,
      window_end_time: row.window_end_minutes !== null ? minutesToTimeString(row.window_end_minutes) : null,
      done_for_day: row.done_for_day === 1
    });
  } catch (err) {
    console.error('❌ PUT /api/settings/today error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update window' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/preferences
// ─────────────────────────────────────────────────────────────
router.get('/preferences', (req, res) => {
  try {
    const prefs = db.prepare('SELECT * FROM preferences WHERE id = 1').get();
    return res.json({ success: true, preferences: prefs });
  } catch (err) {
    console.error('❌ GET /api/settings/preferences error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to get preferences' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/preferences
// Allowed fields: user_name, run_slot_start, default_urgent_minutes,
//                 buffer_minutes, neglect_days
// ─────────────────────────────────────────────────────────────
router.put('/preferences', (req, res) => {
  try {
    const updates = {};

    if ('user_name' in req.body) {
      const name = req.body.user_name;
      if (name === null || name === '') {
        updates.user_name = null;
      } else if (typeof name !== 'string' || !/^[A-Za-z\s.]{1,40}$/.test(name.trim())) {
        return res.status(400).json({ success: false, error: 'user_name: 1-40 chars, letters/spaces/dots only' });
      } else {
        updates.user_name = name.trim();
      }
    }

    if ('run_slot_start' in req.body) {
      const mins = parseTimeToMinutes(req.body.run_slot_start);
      if (mins === null) return res.status(400).json({ success: false, error: 'run_slot_start must be "H:MM AM/PM"' });
      updates.run_slot_start = req.body.run_slot_start;
    }

    if ('default_urgent_minutes' in req.body) {
      const n = parseInt(req.body.default_urgent_minutes, 10);
      if (isNaN(n) || n < 15 || n > 480) return res.status(400).json({ success: false, error: 'default_urgent_minutes: 15-480' });
      updates.default_urgent_minutes = n;
    }

    if ('buffer_minutes' in req.body) {
      const n = parseInt(req.body.buffer_minutes, 10);
      if (isNaN(n) || n < 0 || n > 60) return res.status(400).json({ success: false, error: 'buffer_minutes: 0-60' });
      updates.buffer_minutes = n;
    }

    if ('neglect_days' in req.body) {
      const n = parseInt(req.body.neglect_days, 10);
      if (isNaN(n) || n < 1 || n > 30) return res.status(400).json({ success: false, error: 'neglect_days: 1-30' });
      updates.neglect_days = n;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE preferences SET ${setClauses} WHERE id = 1`).run(...Object.values(updates));

    const prefs = db.prepare('SELECT * FROM preferences WHERE id = 1').get();
    return res.json({ success: true, updated: updates, preferences: prefs });
  } catch (err) {
    console.error('❌ PUT /api/settings/preferences error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

module.exports = router;
module.exports.getTodayWindow = getTodayWindow; // exported for plannerService
