const express = require('express');
const router = express.Router();
const db = require('../database/db');

// Valid days of the week, mapped to exact Title Case as expected by plannerService.js
const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Helper to normalize day string to standard format (e.g. "mOnDaY" -> "Monday")
function normalizeDay(day) {
  if (!day || typeof day !== 'string') return null;
  const lower = day.trim().toLowerCase();
  const normalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return VALID_DAYS.includes(normalized) ? normalized : null;
}
// Helper to convert "H:MM AM/PM" to minutes since midnight for sorting
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const period = match[3].toUpperCase();

  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;

  return hour * 60 + minute;
}


// ─────────────────────────────────────────────────────────────
// POST /api/timetable
// Replaces the entire weekly timetable (First Time Setup)
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const entries = req.body;

    // 1. Validation: Must be a non-empty array
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Request body must be a non-empty array of timetable entries."
      });
    }

    // 2. Validation: Check each entry strictly
    const invalidIndices = [];
    const normalizedEntries = [];

    entries.forEach((entry, index) => {
      // Ensure all required fields exist and are non-empty strings
      if (
        !entry.day_of_week || typeof entry.day_of_week !== 'string' ||
        !entry.subject || typeof entry.subject !== 'string' || !entry.subject.trim() ||
        !entry.start_time || typeof entry.start_time !== 'string' || !entry.start_time.trim() ||
        !entry.end_time || typeof entry.end_time !== 'string' || !entry.end_time.trim()
      ) {
        invalidIndices.push(index);
        return;
      }

      // Max-length validation: subject must not exceed 200 characters
      if (entry.subject.trim().length > 200) {
        invalidIndices.push(index);
        return;
      }

      // Normalize and validate the day of the week
      const normDay = normalizeDay(entry.day_of_week);
      if (!normDay) {
        invalidIndices.push(index);
        return;
      }

      normalizedEntries.push({
        day_of_week: normDay,
        subject: entry.subject.trim(),
        start_time: entry.start_time.trim(),
        end_time: entry.end_time.trim()
      });
    });

    // Fail the whole request if ANY entry was invalid
    if (invalidIndices.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid entries found at indices: [${invalidIndices.join(', ')}]. Each entry must have a valid day_of_week, subject, start_time, and end_time.`
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Database Transaction: Replace Entire Timetable Atomically
    // ─────────────────────────────────────────────────────────────
    let insertedCount = 0;

    const replaceTimetableTx = db.transaction((newEntries) => {
      // Clear out the old schedule completely
      db.prepare('DELETE FROM timetable').run();

      // Prepare the insert statement for the new rows
      const insertStmt = db.prepare(`
        INSERT INTO timetable (day_of_week, subject, start_time, end_time)
        VALUES (?, ?, ?, ?)
      `);

      for (const entry of newEntries) {
        insertStmt.run(entry.day_of_week, entry.subject, entry.start_time, entry.end_time);
        insertedCount++;
      }
    });

    // Execute the transaction
    replaceTimetableTx(normalizedEntries);

    res.json({
      success: true,
      count: insertedCount
    });

  } catch (err) {
    console.error('❌ Error in POST /api/timetable:', err.message);
    res.status(500).json({
      success: false,
      error: "Failed to save timetable.",
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/timetable
// Fetch ALL saved timetable entries.
// Sorts by standard day order (Monday -> Sunday), then by start_time.
// ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const timetable = db.prepare(`
      SELECT day_of_week, subject, start_time, end_time
      FROM timetable
      ORDER BY 
        CASE day_of_week
          WHEN 'Monday' THEN 1
          WHEN 'Tuesday' THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4
          WHEN 'Friday' THEN 5
          WHEN 'Saturday' THEN 6
          WHEN 'Sunday' THEN 7
        END ASC
    `).all();

    // Sort in JS to handle AM/PM chronologically
    timetable.sort((a, b) => {
      // Days are already correctly sorted by the SQL query.
      // We only want to sort entries that fall on the same day.
      if (a.day_of_week !== b.day_of_week) return 0;

      const timeA = parseTimeToMinutes(a.start_time);
      const timeB = parseTimeToMinutes(b.start_time);

      if (timeA === null || timeB === null) {
        if (timeA === null && a.start_time) console.warn(`⚠️ Unrecognized time format: "${a.start_time}"`);
        if (timeB === null && b.start_time) console.warn(`⚠️ Unrecognized time format: "${b.start_time}"`);
        return 0; // Keep relative position if malformed
      }

      return timeA - timeB;
    });

    res.json({
      success: true,
      count: timetable.length,
      timetable: timetable
    });

  } catch (err) {
    console.error('❌ Error in GET /api/timetable:', err.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch timetable.",
      details: err.message
    });
  }
});

module.exports = router;
