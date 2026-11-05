/**
 * backend/services/availabilityService.js
 *
 * Shared availability and intelligent free-slot detection service for SEVA.
 * Computes availability by unifying:
 * 1. Weekly recurring timetable commitments.
 * 2. Date-specific timetable exceptions (one-day cancellations, extra classes, reschedules).
 * 3. Fixed manual tasks and scheduled commitments from the tasks table.
 * 4. User window and personal routine preferences.
 */

const defaultDb = require('../database/db');
const { 
  getTodayDate, 
  parseTimeToMinutes, 
  minutesToTimeString, 
  getDayOfWeek,
  addDaysToDate 
} = require('../utils/dateUtils');

const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Returns effective timetable classes for a specific date,
 * strictly factoring in active weekly schedule and date-specific exceptions.
 */
function getEffectiveTimetableForDate(dateStr, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();
  const dayOfWeek = getDayOfWeek(targetDate);

  // 1. Check if all classes are cancelled for this date
  let cancelAll = null;
  try {
    cancelAll = activeDb.prepare(`
      SELECT id, note FROM timetable_exceptions
      WHERE date = ? AND action = 'cancel_all'
    `).get(targetDate);
  } catch (_) {}

  if (cancelAll) {
    return {
      date: targetDate,
      day_of_week: dayOfWeek,
      all_cancelled: true,
      cancel_reason: cancelAll.note || 'All classes cancelled for this date.',
      classes: []
    };
  }

  // 2. Fetch active weekly timetable entries for this day of week
  let entries = [];
  try {
    const activeWt = activeDb.prepare(`
      SELECT id FROM weekly_timetable WHERE is_active = 1 ORDER BY id DESC LIMIT 1
    `).get();

    if (activeWt) {
      entries = activeDb.prepare(`
        SELECT id, timetable_id, day_of_week, title as subject, start_time, end_time, event_type, location
        FROM timetable_entries
        WHERE timetable_id = ? AND day_of_week = ? AND is_active = 1 AND event_type != 'break'
        ORDER BY start_time ASC
      `).all(activeWt.id, dayOfWeek);
    }
  } catch (_) {}

  // Fall back to legacy timetable table if weekly_timetable was empty
  if (entries.length === 0) {
    try {
      const legacy = activeDb.prepare(`
        SELECT id, day_of_week, subject, start_time, end_time, 'class' as event_type, NULL as location
        FROM timetable
        WHERE day_of_week = ?
        ORDER BY start_time ASC
      `).all(dayOfWeek);
      entries = legacy;
    } catch (_) {}
  }

  // 3. Apply date-specific single-class exceptions
  let exceptions = [];
  try {
    exceptions = activeDb.prepare(`
      SELECT id, entry_id, action, subject, start_time, end_time, note
      FROM timetable_exceptions
      WHERE date = ?
    `).all(targetDate);
  } catch (_) {}

  const cancelledEntryIds = new Set();
  const cancelledSubjects = new Set();
  const overrides = [];

  for (const ex of exceptions) {
    if (ex.action === 'cancel_entry') {
      if (ex.entry_id) cancelledEntryIds.add(ex.entry_id);
      if (ex.subject) cancelledSubjects.add(ex.subject.trim().toLowerCase());
    } else if (ex.action === 'add_override') {
      overrides.push({
        id: `override-${ex.id}`,
        day_of_week: dayOfWeek,
        subject: ex.subject,
        start_time: ex.start_time,
        end_time: ex.end_time,
        event_type: 'class',
        location: null,
        is_override: true,
        note: ex.note
      });
    }
  }

  const effectiveClasses = entries.filter(e => {
    if (e.id && cancelledEntryIds.has(e.id)) return false;
    if (e.subject && cancelledSubjects.has(e.subject.trim().toLowerCase())) return false;
    return true;
  });

  // Merge extra override classes
  effectiveClasses.push(...overrides);

  // Sort chronologically
  effectiveClasses.sort((a, b) => {
    const aMins = parseTimeToMinutes(a.start_time) ?? 0;
    const bMins = parseTimeToMinutes(b.start_time) ?? 0;
    return aMins - bMins;
  });

  return {
    date: targetDate,
    day_of_week: dayOfWeek,
    all_cancelled: false,
    classes: effectiveClasses
  };
}

/**
 * Returns all committed fixed blocks for a date (timetable + fixed tasks).
 */
function getCommittedBlocksForDate(dateStr, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();

  const ttResult = getEffectiveTimetableForDate(targetDate, activeDb);
  const committed = [];

  // 1. Timetable classes
  for (const c of ttResult.classes) {
    const s = parseTimeToMinutes(c.start_time);
    const e = parseTimeToMinutes(c.end_time);
    if (s !== null && e !== null && e > s) {
      committed.push({
        name: c.subject,
        start_time: c.start_time,
        end_time: c.end_time,
        startMinutes: s,
        endMinutes: e,
        duration: e - s,
        source: 'timetable',
        kind: 'class',
        location: c.location || null
      });
    }
  }

  // 2. Fixed tasks from tasks table
  const fixedTasks = activeDb.prepare(`
    SELECT id, name, priority, time_slot, fixed_start, fixed_end, duration_min, source, goal_id
    FROM tasks
    WHERE date = ? AND fixed_start IS NOT NULL
  `).all(targetDate);

  for (const ft of fixedTasks) {
    const s = parseTimeToMinutes(ft.fixed_start);
    if (s === null) continue;
    const e = ft.fixed_end ? parseTimeToMinutes(ft.fixed_end) : null;
    const dur = e !== null ? (e - s) : (ft.duration_min || 60);
    const endMins = s + dur;
    committed.push({
      id: ft.id,
      name: ft.name,
      start_time: minutesToTimeString(s),
      end_time: minutesToTimeString(endMins),
      startMinutes: s,
      endMinutes: endMins,
      duration: dur,
      source: ft.source || 'task',
      kind: 'task',
      priority: ft.priority || 'high',
      goal_id: ft.goal_id || null
    });
  }

  // Sort chronologically
  committed.sort((a, b) => a.startMinutes - b.startMinutes);
  return committed;
}

/**
 * Calculates free slots for a date within user's active window.
 */
function calculateFreeSlots(dateStr, options = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();
  const dayOfWeek = getDayOfWeek(targetDate);

  // Read preferences for window
  let defaultWinStart = 360;  // 6:00 AM
  let defaultWinEnd = 1380;   // 11:00 PM
  try {
    const prefs = activeDb.prepare('SELECT bedtime_hour, tonight_end_time FROM preferences WHERE id = 1').get();
    if (prefs && prefs.tonight_end_time) {
      const pMins = parseTimeToMinutes(prefs.tonight_end_time);
      if (pMins) defaultWinEnd = pMins;
    } else if (prefs && prefs.bedtime_hour) {
      defaultWinEnd = Number(prefs.bedtime_hour) * 60;
    }
  } catch (_) {}

  const winStart = options.windowStartMinutes ?? defaultWinStart;
  const winEnd = options.windowEndMinutes ?? defaultWinEnd;

  const committed = getCommittedBlocksForDate(targetDate, activeDb);

  // Compute gaps
  const inWindow = committed
    .filter(b => b.startMinutes < winEnd && b.endMinutes > winStart)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const freeSlots = [];
  let cursor = winStart;

  for (const b of inWindow) {
    const gapEnd = Math.min(b.startMinutes, winEnd);
    if (gapEnd > cursor) {
      freeSlots.push({
        start_time: minutesToTimeString(cursor),
        end_time: minutesToTimeString(gapEnd),
        startMinutes: cursor,
        endMinutes: gapEnd,
        duration_min: gapEnd - cursor
      });
    }
    cursor = Math.max(cursor, b.endMinutes);
  }

  if (cursor < winEnd) {
    freeSlots.push({
      start_time: minutesToTimeString(cursor),
      end_time: minutesToTimeString(winEnd),
      startMinutes: cursor,
      endMinutes: winEnd,
      duration_min: winEnd - cursor
    });
  }

  const totalFree = freeSlots.reduce((s, g) => s + g.duration_min, 0);
  const totalCommitted = committed.reduce((s, b) => s + b.duration, 0);

  return {
    date: targetDate,
    day_of_week: dayOfWeek,
    window_start: minutesToTimeString(winStart),
    window_end: minutesToTimeString(winEnd),
    total_free_minutes: totalFree,
    total_free_hours: +(totalFree / 60).toFixed(1),
    total_committed_minutes: totalCommitted,
    committed_blocks: committed.map(c => ({
      name: c.name,
      start_time: c.start_time,
      end_time: c.end_time,
      duration_min: c.duration,
      kind: c.kind,
      source: c.source
    })),
    free_slots: freeSlots.map(f => ({
      start_time: f.start_time,
      end_time: f.end_time,
      duration_min: f.duration_min,
      description: `${f.start_time}–${f.end_time} (${f.duration_min} min free)`
    }))
  };
}

/**
 * Calculates 7-day weekly availability summary starting from startDateStr.
 */
function getWeeklyAvailabilitySummary(startDateStr, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const start = startDateStr && /^\d{4}-\d{2}-\d{2}$/.test(startDateStr) ? startDateStr : getTodayDate();

  const days = [];
  let totalWeekFreeMins = 0;
  let totalWeekCommittedMins = 0;

  for (let i = 0; i < 7; i++) {
    const dStr = addDaysToDate(start, i);
    const dayAvail = calculateFreeSlots(dStr, {}, activeDb);
    totalWeekFreeMins += dayAvail.total_free_minutes;
    totalWeekCommittedMins += dayAvail.total_committed_minutes;
    days.push({
      date: dStr,
      day_of_week: dayAvail.day_of_week,
      free_hours: dayAvail.total_free_hours,
      free_minutes: dayAvail.total_free_minutes,
      committed_minutes: dayAvail.total_committed_minutes,
      free_slots_count: dayAvail.free_slots.length,
      classes_count: dayAvail.committed_blocks.filter(b => b.kind === 'class').length
    });
  }

  return {
    start_date: start,
    total_free_hours: +(totalWeekFreeMins / 60).toFixed(1),
    total_committed_hours: +(totalWeekCommittedMins / 60).toFixed(1),
    days
  };
}

/**
 * Cancels all classes for a specific date (e.g. "I have no college tomorrow").
 */
function cancelClassesForDate(dateStr, note = 'Cancelled via Chat', dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();

  activeDb.prepare(`
    INSERT INTO timetable_exceptions (date, action, note)
    VALUES (?, 'cancel_all', ?)
  `).run(targetDate, note);

  // Synchronize with existing Day Plan if already saved
  try {
    const DayPlanService = require('./dayPlanService');
    DayPlanService.removeTimetableBlockFromPlan(targetDate, null, activeDb);
  } catch (_) {}

  return {
    success: true,
    date: targetDate,
    message: `All classes for ${targetDate} have been marked as cancelled.`
  };
}

/**
 * Cancels a specific lecture on a specific date (e.g. "My Monday OS lecture is cancelled").
 */
function cancelSingleClass(dateStr, subject, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();

  activeDb.prepare(`
    INSERT INTO timetable_exceptions (date, action, subject, note)
    VALUES (?, 'cancel_entry', ?, ?)
  `).run(targetDate, subject, `Cancelled lecture "${subject}" for ${targetDate}`);

  // Synchronize with existing Day Plan if already saved
  try {
    const DayPlanService = require('./dayPlanService');
    DayPlanService.removeTimetableBlockFromPlan(targetDate, subject, activeDb);
  } catch (_) {}

  return {
    success: true,
    date: targetDate,
    subject,
    message: `Class "${subject}" for ${targetDate} cancelled.`
  };
}

/**
 * Adds an extra one-day lecture or commitment for a date.
 */
function addExtraClass(dateStr, { subject, start_time, end_time, location = null }, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayDate();

  const sNorm = minutesToTimeString(parseTimeToMinutes(start_time));
  const eNorm = minutesToTimeString(parseTimeToMinutes(end_time));

  activeDb.prepare(`
    INSERT INTO timetable_exceptions (date, action, subject, start_time, end_time, note)
    VALUES (?, 'add_override', ?, ?, ?, ?)
  `).run(targetDate, subject, sNorm, eNorm, location ? `Location: ${location}` : 'Extra lecture added via Chat');

  // Synchronize with existing Day Plan if already saved
  try {
    const DayPlanService = require('./dayPlanService');
    const sMins = parseTimeToMinutes(sNorm);
    const eMins = parseTimeToMinutes(eNorm);
    DayPlanService.addTimetableBlockToPlan(targetDate, {
      task: subject,
      startMinutes: sMins,
      duration: eMins - sMins,
      source: 'fixed',
      kind: 'class',
      priority: 'medium',
      time: sNorm,
      completed: 0
    }, activeDb);
  } catch (_) {}

  return {
    success: true,
    date: targetDate,
    subject,
    start_time: sNorm,
    end_time: eNorm,
    message: `Extra class "${subject}" (${sNorm}–${eNorm}) scheduled for ${targetDate}.`
  };
}

/**
 * Persists a new structured weekly timetable in SQLite.
 * Atomically inserts into weekly_timetable and timetable_entries,
 * and synchronizes with legacy timetable table for 100% backward compatibility.
 */
function saveWeeklyTimetable(entries, name = 'Weekly Timetable', dbOverride = null) {
  const activeDb = dbOverride || defaultDb;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Cannot save empty timetable. At least one entry is required.');
  }

  const tx = activeDb.transaction(() => {
    // 1. Deactivate current active timetables
    activeDb.prepare('UPDATE weekly_timetable SET is_active = 0 WHERE is_active = 1').run();

    // 2. Insert new weekly_timetable record
    const insWt = activeDb.prepare(`
      INSERT INTO weekly_timetable (name, is_active, updated_at)
      VALUES (?, 1, datetime('now'))
    `).run(name);
    const timetableId = insWt.lastInsertRowid;

    // 3. Insert timetable entries
    const insEntry = activeDb.prepare(`
      INSERT INTO timetable_entries (timetable_id, day_of_week, title, start_time, end_time, event_type, location, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const item of entries) {
      insEntry.run(
        timetableId,
        item.day_of_week,
        item.title || item.subject,
        item.start_time,
        item.end_time,
        item.event_type || 'class',
        item.location || null
      );
    }

    // 4. Synchronize with legacy timetable table
    activeDb.prepare('DELETE FROM timetable').run();
    const legacyIns = activeDb.prepare(`
      INSERT INTO timetable (day_of_week, subject, start_time, end_time)
      VALUES (?, ?, ?, ?)
    `);
    for (const item of entries) {
      if ((item.event_type || 'class') === 'class') {
        legacyIns.run(item.day_of_week, item.title || item.subject, item.start_time, item.end_time);
      }
    }

    return { timetableId, count: entries.length };
  });

  return tx();
}

module.exports = {
  getEffectiveTimetableForDate,
  getCommittedBlocksForDate,
  calculateFreeSlots,
  getWeeklyAvailabilitySummary,
  cancelClassesForDate,
  cancelSingleClass,
  addExtraClass,
  saveWeeklyTimetable
};

