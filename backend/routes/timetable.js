const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database/db');
const { parseTimeToMinutes, getTodayDate } = require('../utils/dateUtils');
const { extractTimetableFromFile } = require('../services/timetableExtractor');
const availabilityService = require('../services/availabilityService');
const { setPendingState, getPendingState, clearPending } = require('../services/chatCommands');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function normalizeDay(day) {
  if (!day || typeof day !== 'string') return null;
  const lower = day.trim().toLowerCase();
  const normalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return VALID_DAYS.includes(normalized) ? normalized : null;
}

/**
 * Helper to generate human-readable preview message for chat
 */
function buildPreviewText(extraction) {
  let msg = `📅 I extracted your weekly timetable (${extraction.entries.length} classes detected):\n\n`;

  const byDay = {};
  for (const d of VALID_DAYS) byDay[d] = [];
  for (const e of extraction.entries) {
    if (byDay[e.day_of_week]) byDay[e.day_of_week].push(e);
  }

  for (const d of VALID_DAYS) {
    const list = byDay[d];
    if (list.length > 0) {
      msg += `**${d}**:\n`;
      list.forEach(c => {
        msg += `• ${c.start_time}–${c.end_time}: ${c.title}${c.location ? ` (${c.location})` : ''}\n`;
      });
      msg += `\n`;
    }
  }

  if (extraction.breaks && extraction.breaks.length > 0) {
    msg += `**Breaks**:\n`;
    extraction.breaks.forEach(b => {
      msg += `• ${b.day_of_week}: ${b.start_time}–${b.end_time} (${b.title})\n`;
    });
    msg += `\n`;
  }

  if (extraction.conflicts && extraction.conflicts.length > 0) {
    msg += `⚠️ **Detected Conflicts**:\n`;
    extraction.conflicts.forEach(c => {
      msg += `• ${c}\n`;
    });
    msg += `\n`;
  }

  if (extraction.uncertain_entries && extraction.uncertain_entries.length > 0) {
    msg += `❓ **Uncertain Entries**:\n`;
    extraction.uncertain_entries.slice(0, 3).forEach(u => {
      msg += `• ${u.raw_text || u.title || 'Uncertain item'}: ${u.reason}\n`;
    });
    msg += `\n`;
  }

  msg += `Reply **"yes"** or **"confirm"** to save this timetable, or specify corrections.`;
  return msg;
}

// ─────────────────────────────────────────────────────────────
// POST /api/timetable/upload
// Accepts multipart file upload (PDF or Image) or JSON text,
// extracts classes locally, returns preview and registers confirmation pending state.
// ─────────────────────────────────────────────────────────────
router.post('/upload', upload.single('timetable'), async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    let buffer = null;
    let originalname = 'timetable_text';
    let mimetype = 'text/plain';

    if (req.file) {
      buffer = req.file.buffer;
      originalname = req.file.originalname || 'uploaded_document';
      mimetype = req.file.mimetype || 'application/octet-stream';

      // Persist uploaded file to disk for debugging and traceability
      const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const savedPath = path.join(uploadsDir, `timetable_${Date.now()}_${safeName}`);
      fs.writeFileSync(savedPath, buffer);
      console.log(`📎 Received timetable file: ${originalname} (${mimetype}, ${buffer.length} bytes) -> saved to ${savedPath}`);
    } else if (req.body && req.body.text && typeof req.body.text === 'string' && req.body.text.trim()) {
      buffer = Buffer.from(req.body.text, 'utf8');
      originalname = 'pasted_timetable.txt';
      mimetype = 'text/plain';
      console.log(`📝 Received pasted timetable text (${req.body.text.length} chars)`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'No file or timetable text provided. Please attach a PDF/image or paste your timetable.'
      });
    }

    const result = await extractTimetableFromFile(buffer, originalname || mimetype);

    // Save extracted text for traceability
    if (result.raw_text) {
      fs.writeFileSync(path.join(uploadsDir, 'latest_ocr.txt'), result.raw_text);
      console.log(`📄 Saved extracted text to backend/uploads/latest_ocr.txt (${result.raw_text.length} chars)`);
    }

    if (!result.success || result.entries.length === 0) {
      const guidance = result.error ||
        `Could not automatically detect timetable entries from "${originalname}". You can:\n1) Upload a clearer screenshot or PDF, or\n2) Paste your timetable directly in Chat (e.g. "Monday: 10:15-11:15 OS, 11:15-12:15 DBMS, 1:15-3:15 AI Lab").`;
      return res.status(422).json({
        success: false,
        error: guidance,
        uncertain_entries: result.uncertain_entries || []
      });
    }

    const previewMessage = buildPreviewText(result);

    // Set pending confirmation in chatCommands for 10 minutes
    setPendingState({
      type: 'timetable_preview',
      extractionResult: result,
      previewMessage,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    return res.json({
      success: true,
      filename: originalname,
      entries_count: result.entries.length,
      breaks_count: (result.breaks || []).length,
      conflicts_count: (result.conflicts || []).length,
      preview_message: previewMessage,
      extraction: result
    });
  } catch (err) {
    console.error('❌ Error in POST /api/timetable/upload:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to process uploaded timetable.',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/timetable/confirm
// Explicitly confirms saving the pending extracted timetable or passed entries.
// ─────────────────────────────────────────────────────────────
router.post('/confirm', (req, res) => {
  try {
    let entriesToSave = [];
    let name = 'Uploaded Weekly Timetable';

    const pending = getPendingState();
    if (pending && pending.type === 'timetable_preview' && pending.extractionResult) {
      entriesToSave = pending.extractionResult.entries;
      name = pending.extractionResult.timetable_name || name;
      clearPending();
    } else if (Array.isArray(req.body.entries) && req.body.entries.length > 0) {
      entriesToSave = req.body.entries;
      if (req.body.name) name = req.body.name;
    } else {
      return res.status(400).json({
        success: false,
        error: 'No pending timetable to confirm and no entries provided in request body.'
      });
    }

    const saved = availabilityService.saveWeeklyTimetable(entriesToSave, name, db);

    return res.json({
      success: true,
      message: `Successfully saved ${saved.count} weekly timetable entries.`,
      timetable_id: saved.timetableId,
      count: saved.count,
      updated: ['timetable', 'plan', 'Dashboard']
    });
  } catch (err) {
    console.error('❌ Error in POST /api/timetable/confirm:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to confirm and save timetable.',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/timetable/availability
// Calculates free slots and committed blocks for a date (defaults to today).
// ─────────────────────────────────────────────────────────────
router.get('/availability', (req, res) => {
  try {
    const targetDate = req.query.date || getTodayDate();
    const result = availabilityService.calculateFreeSlots(targetDate, {}, db);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error in GET /api/timetable/availability:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to calculate availability.',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/timetable/weekly-availability
// Calculates 7-day free slot and committed hours summary.
// ─────────────────────────────────────────────────────────────
router.get('/weekly-availability', (req, res) => {
  try {
    const startDate = req.query.start || getTodayDate();
    const result = availabilityService.getWeeklyAvailabilitySummary(startDate, db);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error in GET /api/timetable/weekly-availability:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to calculate weekly availability.',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/timetable/exception
// Adds a one-day timetable exception (cancel_all, cancel_entry, add_override).
// ─────────────────────────────────────────────────────────────
router.post('/exception', (req, res) => {
  try {
    const { date, action, subject, start_time, end_time, location, note } = req.body;
    const targetDate = date || getTodayDate();

    if (!action) {
      return res.status(400).json({ success: false, error: 'Missing action: cancel_all, cancel_entry, or add_override' });
    }

    let result;
    if (action === 'cancel_all') {
      result = availabilityService.cancelClassesForDate(targetDate, note || 'Cancelled by user', db);
    } else if (action === 'cancel_entry') {
      if (!subject) return res.status(400).json({ success: false, error: 'Missing subject to cancel' });
      result = availabilityService.cancelSingleClass(targetDate, subject, db);
    } else if (action === 'add_override') {
      if (!subject || !start_time || !end_time) {
        return res.status(400).json({ success: false, error: 'Extra lecture requires subject, start_time, and end_time' });
      }
      result = availabilityService.addExtraClass(targetDate, { subject, start_time, end_time, location }, db);
    } else {
      return res.status(400).json({ success: false, error: `Unsupported exception action: ${action}` });
    }

    return res.json({
      success: true,
      ...result,
      updated: ['timetable', 'plan', 'Dashboard']
    });
  } catch (err) {
    console.error('❌ Error in POST /api/timetable/exception:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to record timetable exception.',
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/timetable (Legacy API: saves direct raw array)
// ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Request body must be a non-empty array of timetable entries."
      });
    }

    const normalizedEntries = [];
    for (const entry of entries) {
      const normDay = normalizeDay(entry.day_of_week);
      if (!normDay || !entry.subject || !entry.start_time || !entry.end_time) {
        return res.status(400).json({
          success: false,
          error: "Each entry must have a valid day_of_week, subject, start_time, and end_time."
        });
      }
      normalizedEntries.push({
        day_of_week: normDay,
        title: entry.subject.trim(),
        start_time: entry.start_time.trim(),
        end_time: entry.end_time.trim(),
        event_type: 'class'
      });
    }

    const saved = availabilityService.saveWeeklyTimetable(normalizedEntries, 'Weekly Schedule', db);

    res.json({
      success: true,
      count: saved.count,
      timetable_id: saved.timetableId
    });
  } catch (err) {
    console.error('❌ Error in POST /api/timetable:', err.message);
    res.status(500).json({ success: false, error: "Failed to save timetable.", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/timetable
// Fetch ALL saved timetable entries.
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

    timetable.sort((a, b) => {
      if (a.day_of_week !== b.day_of_week) return 0;
      const timeA = parseTimeToMinutes(a.start_time) ?? 0;
      const timeB = parseTimeToMinutes(b.start_time) ?? 0;
      return timeA - timeB;
    });

    res.json({
      success: true,
      count: timetable.length,
      timetable
    });
  } catch (err) {
    console.error('❌ Error in GET /api/timetable:', err.message);
    res.status(500).json({ success: false, error: "Failed to fetch timetable.", details: err.message });
  }
});

module.exports = router;
