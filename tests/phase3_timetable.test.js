/**
 * tests/phase3_timetable.test.js
 *
 * Comprehensive Test Suite for SEVA Phase 3:
 * Timetable Upload, Extraction, Free-Slot Detection & Day Plan Integration.
 *
 * Executes on an ISOLATED SQLite database in os.tmpdir().
 * NEVER touches production seva.db.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const Database = require('../backend/node_modules/better-sqlite3');

const {
  getTodayDate,
  getTomorrowDate,
  getDayOfWeek,
  parseTimeToMinutes,
  minutesToTimeString
} = require('../backend/utils/dateUtils');

const TEST_DB_PATH = path.join(os.tmpdir(), `seva_test_phase3_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.db`);

function setupIsolatedDb() {
  const db = new Database(TEST_DB_PATH);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE weekly_timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Default Weekly Timetable',
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE timetable_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timetable_id INTEGER NOT NULL,
      day_of_week TEXT NOT NULL CHECK(day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      event_type TEXT DEFAULT 'class',
      location TEXT NULL,
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      FOREIGN KEY(timetable_id) REFERENCES weekly_timetable(id) ON DELETE CASCADE
    );

    CREATE TABLE timetable_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      entry_id INTEGER NULL,
      action TEXT NOT NULL CHECK(action IN ('cancel_all', 'cancel_entry', 'add_override', 'reschedule')),
      subject TEXT NULL,
      start_time TEXT NULL,
      end_time TEXT NULL,
      note TEXT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(entry_id) REFERENCES timetable_entries(id) ON DELETE CASCADE
    );

    CREATE TABLE timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week TEXT,
      subject TEXT,
      start_time TEXT,
      end_time TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT,
      time_slot TEXT DEFAULT 'Anytime',
      duration_min INTEGER DEFAULT 30,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      category TEXT DEFAULT 'general',
      completed INTEGER DEFAULT 0 CHECK(completed IN (0,1)),
      completed_at TEXT NULL,
      goal_id INTEGER NULL,
      due_date TEXT NULL,
      fixed_start TEXT NULL,
      fixed_end TEXT NULL,
      is_urgent INTEGER DEFAULT 0 CHECK(is_urgent IN (0,1)),
      carry_forward INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT,
      category TEXT,
      title TEXT NOT NULL,
      target_text TEXT,
      deadline TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      goal_type TEXT DEFAULT 'milestone' CHECK(goal_type IN ('milestone','count','frequency')),
      target_count INTEGER NULL,
      current_count INTEGER DEFAULT 0,
      per_week INTEGER NULL,
      manual_progress INTEGER NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','removed')),
      created_date TEXT,
      completed_date TEXT NULL,
      is_paused INTEGER DEFAULT 0 CHECK(is_paused IN (0, 1) AND (is_paused = 0 OR status = 'active')),
      paused_at TEXT NULL,
      total_paused_days INTEGER DEFAULT 0
    );

    CREATE TABLE preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT DEFAULT 'Pranav Sawant',
      bedtime_hour INTEGER DEFAULT 23,
      tonight_end_time TEXT DEFAULT '11:00 PM',
      buffer_minutes INTEGER DEFAULT 15
    );

    INSERT INTO preferences (id, user_name, bedtime_hour, tonight_end_time, buffer_minutes)
    VALUES (1, 'Pranav Sawant', 23, '11:00 PM', 15);
  `);

  return db;
}

const testDb = setupIsolatedDb();
const { 
  parseScheduleText, 
  validateAndStructureTimetable 
} = require('../backend/services/timetableExtractor');
const availabilityService = require('../backend/services/availabilityService');
const { buildFixedTimeline, computeGapObjects } = require('../backend/services/schedulerService');

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error('     Error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

async function runSuite() {
  const today = getTodayDate();
  const tomorrow = getTomorrowDate();
  const todayDay = getDayOfWeek(today);

  console.log('===============================================================');
  console.log('🚀 SEVA PHASE 3: TIMETABLE & AVAILABILITY TEST SUITE');
  console.log('   Running on isolated database:', TEST_DB_PATH);
  console.log('===============================================================\n');

  // ── 1. Document Extraction & Text Parsing ──
  console.log('--- 1. Document Extraction & Table Parsing ---');
  run('T1.01: Parse timetable text with day headers and multi-format times', () => {
    const rawText = `
      College Engineering Timetable:
      Monday:
      - 10:00 AM - 11:00 AM: Data Structures (Room 302)
      - 11:00 AM to 12:00 PM: Operating Systems (Hall B)
      - 12:00 PM - 1:00 PM: Lunch Break
      - 2:00 PM - 4:00 PM: Database Practical Lab

      Tuesday:
      - 9:00 AM - 10:30 AM: Mathematics III (CR-1)
    `;

    const { rawEntries, uncertainEntries } = parseScheduleText(rawText);
    assert.strictEqual(rawEntries.length, 5);
    assert.strictEqual(uncertainEntries.length, 0);

    const structured = validateAndStructureTimetable(rawEntries, uncertainEntries);
    assert.strictEqual(structured.entries.length, 4);
    assert.strictEqual(structured.breaks.length, 1);
    assert.strictEqual(structured.entries[0].title, 'Data Structures');
    assert.strictEqual(structured.entries[0].location, 'Room 302');
    assert.strictEqual(structured.breaks[0].title, 'Lunch Break');
  });

  run('T1.01b: Parse dot-notation and no-AM/PM college schedules (10.15 to 1.15 PM)', () => {
    const collegeText = `
      Monday:
      - 10.15 - 11.15: Operating Systems
      - 11.15 - 12.15: Database Management
      - 12.15 - 1.15: Lunch
      - 1.15 - 2.15: Computer Networks
      - 2.15 - 4.15: Web Tech Lab (Room 201)
    `;
    const { rawEntries, uncertainEntries } = parseScheduleText(collegeText);
    assert.strictEqual(rawEntries.length, 5);
    assert.strictEqual(uncertainEntries.length, 0);

    const structured = validateAndStructureTimetable(rawEntries, uncertainEntries);
    assert.strictEqual(structured.entries.length, 4);
    assert.strictEqual(structured.breaks.length, 1);
    assert.strictEqual(structured.entries[0].start_time, '10:15 AM');
    assert.strictEqual(structured.entries[0].end_time, '11:15 AM');
    assert.strictEqual(structured.entries[2].start_time, '1:15 PM');
    assert.strictEqual(structured.entries[2].end_time, '2:15 PM');
  });

  run('T1.01c: Parse grid matrix layout with time ranges in header row', () => {
    const gridText = `
      SEVA Engineering Timetable
      Day / Time | 10.15 - 11.15 | 11.15 - 12.15 | 1.15 - 2.15 | 2.15 - 4.15
      Monday     | Data Science  | Cloud Computing| AI           | Python Lab
      Tuesday    | Software Eng  | Data Science   | OS           | Linux Lab
    `;
    const { rawEntries } = parseScheduleText(gridText);
    assert.strictEqual(rawEntries.length, 8);

    const structured = validateAndStructureTimetable(rawEntries, []);
    assert.strictEqual(structured.entries.length, 8);
    const monDs = structured.entries.find(e => e.day_of_week === 'Monday' && e.title === 'Data Science');
    assert.ok(monDs, 'Monday Data Science should be extracted');
    assert.strictEqual(monDs.start_time, '10:15 AM');
    assert.strictEqual(monDs.end_time, '11:15 AM');
  });

  run('T1.02: Detect and flag invalid time ranges (end <= start) without guessing', () => {
    const badText = `
      Wednesday:
      - 4:00 PM - 3:00 PM: Ghost Lecture
    `;
    const { rawEntries, uncertainEntries } = parseScheduleText(badText);
    const structured = validateAndStructureTimetable(rawEntries, uncertainEntries);
    assert.strictEqual(structured.entries.length, 0);
    assert.strictEqual(structured.conflicts.length, 1);
    assert.ok(structured.conflicts[0].includes('ends (3:00 PM) at or before start (4:00 PM)'));
  });

  run('T1.03: Detect intra-day class collisions / overlapping commitments', () => {
    const overlapText = `
      Thursday:
      - 10:00 AM - 12:00 PM: Artificial Intelligence Lecture
      - 11:00 AM - 1:00 PM: Machine Learning Lab
    `;
    const { rawEntries, uncertainEntries } = parseScheduleText(overlapText);
    const structured = validateAndStructureTimetable(rawEntries, uncertainEntries);
    assert.strictEqual(structured.entries.length, 2);
    assert.strictEqual(structured.conflicts.length, 1);
    assert.ok(structured.conflicts[0].includes('Collision on Thursday'));
  });

  // ── 2. Persistence & Backward-Compatible Relational Sync ──
  console.log('\n--- 2. Database Persistence & Legacy Sync ---');
  run('T2.01: Save weekly timetable into weekly_timetable and timetable_entries', () => {
    const entries = [
      { day_of_week: 'Monday', title: 'Data Structures', start_time: '10:00 AM', end_time: '11:00 AM', event_type: 'class' },
      { day_of_week: 'Monday', title: 'Operating Systems', start_time: '11:00 AM', end_time: '12:00 PM', event_type: 'class' },
      { day_of_week: 'Tuesday', title: 'Mathematics', start_time: '9:00 AM', end_time: '10:30 AM', event_type: 'class' },
      { day_of_week: todayDay, title: 'Shell Scripting Lab', start_time: '11:00 AM', end_time: '1:00 PM', event_type: 'class' }
    ];

    const res = availabilityService.saveWeeklyTimetable(entries, 'Spring Semester 2026', testDb);
    assert.ok(res.timetableId > 0);
    assert.strictEqual(res.count, 4);

    // Verify weekly_timetable
    const wt = testDb.prepare('SELECT * FROM weekly_timetable WHERE id = ?').get(res.timetableId);
    assert.strictEqual(wt.name, 'Spring Semester 2026');
    assert.strictEqual(wt.is_active, 1);

    // Verify timetable_entries
    const teRows = testDb.prepare('SELECT * FROM timetable_entries WHERE timetable_id = ?').all(res.timetableId);
    assert.strictEqual(teRows.length, 4);

    // Verify legacy timetable table backward compatibility
    const legacy = testDb.prepare('SELECT * FROM timetable').all();
    assert.strictEqual(legacy.length, 4);
  });

  // ── 3. Free-Slot Detection & Availability Engine ──
  console.log('\n--- 3. Free-Slot Detection Engine ---');
  run('T3.01: Calculate free slots around committed timetable classes and fixed tasks', () => {
    // Add a fixed task at 3:00 PM - 4:00 PM on today
    testDb.prepare(`
      INSERT INTO tasks (name, date, time_slot, fixed_start, fixed_end, duration_min, priority)
      VALUES ('Project Meeting', ?, '3:00 PM', '3:00 PM', '4:00 PM', 60, 'high')
    `).run(today);

    // Window: 6:00 AM (360) to 11:00 PM (1380)
    // Class: Shell Scripting Lab at 11:00 AM (660) to 1:00 PM (780)
    // Task: Project Meeting at 3:00 PM (900) to 4:00 PM (960)
    const avail = availabilityService.calculateFreeSlots(today, { windowStartMinutes: 360, windowEndMinutes: 1380 }, testDb);

    assert.strictEqual(avail.date, today);
    assert.strictEqual(avail.committed_blocks.length, 2);

    // Expected free gaps:
    // 1. 6:00 AM to 11:00 AM (300 min)
    // 2. 1:00 PM to 3:00 PM (120 min)
    // 3. 4:00 PM to 11:00 PM (420 min)
    assert.strictEqual(avail.free_slots.length, 3);
    assert.strictEqual(avail.free_slots[0].start_time, '6:00 AM');
    assert.strictEqual(avail.free_slots[0].end_time, '11:00 AM');
    assert.strictEqual(avail.free_slots[0].duration_min, 300);

    assert.strictEqual(avail.free_slots[1].start_time, '1:00 PM');
    assert.strictEqual(avail.free_slots[1].end_time, '3:00 PM');
    assert.strictEqual(avail.free_slots[1].duration_min, 120);

    assert.strictEqual(avail.free_slots[2].start_time, '4:00 PM');
    assert.strictEqual(avail.free_slots[2].end_time, '11:00 PM');
    assert.strictEqual(avail.free_slots[2].duration_min, 420);

    assert.strictEqual(avail.total_free_minutes, 300 + 120 + 420); // 840 min (14 hrs)
    assert.strictEqual(avail.total_free_hours, 14.0);
  });

  run('T3.02: Weekly availability summary aggregates across 7 consecutive days', () => {
    const weekly = availabilityService.getWeeklyAvailabilitySummary(today, testDb);
    assert.strictEqual(weekly.days.length, 7);
    assert.ok(weekly.total_free_hours > 50, 'Must calculate substantial weekly free hours');
    assert.strictEqual(weekly.days[0].date, today);
  });

  // ── 4. One-Day Timetable Exceptions (Non-Destructive) ──
  console.log('\n--- 4. One-Day Exceptions vs Recurring Timetable ---');
  run('T4.01: One-day whole cancellation ("no college tomorrow") does NOT delete weekly schedule', () => {
    const cancelRes = availabilityService.cancelClassesForDate(tomorrow, 'College Holiday', testDb);
    assert.strictEqual(cancelRes.success, true);

    // Verify exception recorded
    const exc = testDb.prepare('SELECT * FROM timetable_exceptions WHERE date = ?').get(tomorrow);
    assert.ok(exc);
    assert.strictEqual(exc.action, 'cancel_all');

    // Effective timetable for tomorrow reports all_cancelled = true and 0 classes
    const effTomorrow = availabilityService.getEffectiveTimetableForDate(tomorrow, testDb);
    assert.strictEqual(effTomorrow.all_cancelled, true);
    assert.strictEqual(effTomorrow.classes.length, 0);

    // BUT recurring weekly timetable entries remain 100% intact!
    const activeEntriesCount = testDb.prepare('SELECT COUNT(*) as c FROM timetable_entries WHERE is_active = 1').get().c;
    assert.strictEqual(activeEntriesCount, 4, 'Recurring timetable entries must NOT be deleted');
  });

  run('T4.02: One-day single lecture cancellation suppresses only that class on that date', () => {
    const cancelSingle = availabilityService.cancelSingleClass(today, 'Shell Scripting Lab', testDb);
    assert.strictEqual(cancelSingle.success, true);

    const effToday = availabilityService.getEffectiveTimetableForDate(today, testDb);
    const hasLab = effToday.classes.some(c => c.subject === 'Shell Scripting Lab');
    assert.strictEqual(hasLab, false, 'Shell Scripting Lab must be suppressed for today');

    // Next week same day, class is still present
    const dFuture = new Date(today + 'T12:00:00Z');
    dFuture.setUTCDate(dFuture.getUTCDate() + 7);
    const futureDate = dFuture.toISOString().split('T')[0];
    const effFuture = availabilityService.getEffectiveTimetableForDate(futureDate, testDb);
    const futureHasLab = effFuture.classes.some(c => c.subject === 'Shell Scripting Lab');
    assert.strictEqual(futureHasLab, true, 'Next week recurring lecture must still exist');
  });

  run('T4.03: One-day extra lecture override adds commitment for specific date', () => {
    const extra = availabilityService.addExtraClass(today, {
      subject: 'Special Workshop on Docker',
      start_time: '4:30 PM',
      end_time: '6:00 PM',
      location: 'Auditorium'
    }, testDb);

    assert.strictEqual(extra.success, true);
    assert.strictEqual(extra.subject, 'Special Workshop on Docker');

    const effToday = availabilityService.getEffectiveTimetableForDate(today, testDb);
    const workshop = effToday.classes.find(c => c.subject === 'Special Workshop on Docker');
    assert.ok(workshop, 'Workshop must be present in effective today classes');
    assert.strictEqual(workshop.start_time, '4:30 PM');
    assert.strictEqual(workshop.end_time, '6:00 PM');
  });

  // ── 5. Day Plan Scheduler Integration ──
  console.log('\n--- 5. Day Plan Scheduler Integration ---');
  run('T5.01: Scheduler respects timetable classes as inviolable fixed blocks', () => {
    const classes = [
      { subject: 'Compiler Design', start_time: '10:00 AM', end_time: '12:00 PM' }
    ];
    const fixedTasks = [];
    const timeline = buildFixedTimeline(classes, fixedTasks);

    assert.strictEqual(timeline.length, 1);
    assert.strictEqual(timeline[0].task, 'Compiler Design');
    assert.strictEqual(timeline[0].source, 'fixed');
    assert.strictEqual(timeline[0].startMinutes, 600);
    assert.strictEqual(timeline[0].duration, 120);

    // Compute gaps around compiler design from 9:00 AM to 5:00 PM
    const gaps = computeGapObjects(timeline, 540, 1020);
    assert.strictEqual(gaps.length, 2);
    // Gap 1: 9:00 AM (540) to 10:00 AM (600)
    assert.strictEqual(gaps[0].start, 540);
    assert.strictEqual(gaps[0].end, 600);
    // Gap 2: 12:00 PM (720) to 5:00 PM (1020)
    assert.strictEqual(gaps[1].start, 720);
    assert.strictEqual(gaps[1].end, 1020);
  });

  // ── 6. Transactional Rollback & Integrity ──
  console.log('\n--- 6. Transactional Rollback & Integrity ---');
  run('T6.01: Failed timetable save rolls back completely without mutating previous schedule', () => {
    const beforeCount = testDb.prepare('SELECT COUNT(*) as c FROM weekly_timetable').get().c;
    try {
      testDb.transaction(() => {
        testDb.prepare("INSERT INTO weekly_timetable (name) VALUES ('Corrupt Batch')").run();
        throw new Error('Forced transactional failure in timetable import');
      })();
    } catch (_) {
      // Expected
    }
    const afterCount = testDb.prepare('SELECT COUNT(*) as c FROM weekly_timetable').get().c;
    assert.strictEqual(afterCount, beforeCount, 'Rollback must preserve original weekly_timetable count');
  });

  console.log('\n===============================================================');
  console.log(`🏁 PHASE 3 TIMETABLE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal error in Phase 3 test suite:', err);
  process.exit(1);
});

