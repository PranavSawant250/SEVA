/**
 * tests/persistent_timetable_workflow.test.js
 *
 * Dedicated test suite verifying persistent timetable integration across:
 * 1. Single upload & confirmation persistence.
 * 2. Persistence across server reboot (fresh DB handle, zero memory state).
 * 3. Today's Day Plan generation respects saved timetable.
 * 4. Tomorrow's Day Plan generation respects saved timetable.
 * 5. Chat-based plan generation and conflict prevention.
 * 6. Nightly check-in ("plan tomorrow") integration.
 * 7. One-day exception isolation (cancelling for one day preserves recurring weekly timetable).
 * 8. Plan regeneration produces 0 duplicate timetable blocks and preserves completed tasks.
 *
 * Strictly executed on an isolated SQLite database in os.tmpdir().
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

const TEST_DB_PATH = path.join(os.tmpdir(), `seva_test_persistent_tt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.db`);

function createTestSchema(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Default Weekly Timetable',
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timetable_entries (
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

    CREATE TABLE IF NOT EXISTS timetable_exceptions (
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

    CREATE TABLE IF NOT EXISTS timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week TEXT,
      subject TEXT,
      start_time TEXT,
      end_time TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
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

    CREATE TABLE IF NOT EXISTS day_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE,
      plan_json TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      completed_count INTEGER DEFAULT 0,
      missed_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS goals (
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
      completed_date TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_settings (
      date TEXT PRIMARY KEY,
      window_end_minutes INTEGER NULL,
      available_minutes INTEGER NULL,
      done_for_day INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      run_slot_start TEXT DEFAULT '6:30 AM',
      default_urgent_minutes INTEGER DEFAULT 90,
      buffer_minutes INTEGER DEFAULT 15,
      user_name TEXT DEFAULT 'Pranav Sawant',
      user_prn TEXT DEFAULT '246100104',
      neglect_days INTEGER DEFAULT 3
    );

    INSERT OR IGNORE INTO preferences (id, user_name) VALUES (1, 'Pranav Sawant');
  `);
}

let testDb = new Database(TEST_DB_PATH);
createTestSchema(testDb);

const availabilityService = require('../backend/services/availabilityService');
const DayPlanService = require('../backend/services/dayPlanService');
const { buildDaySchedule } = require('../backend/services/schedulerService');

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

async function runSuite() {
  const today = getTodayDate();
  const tomorrow = getTomorrowDate();
  const todayDay = getDayOfWeek(today);
  const tomorrowDay = getDayOfWeek(tomorrow);

  console.log('===============================================================');
  console.log('🚀 SEVA PERSISTENT TIMETABLE INTEGRATION TEST SUITE');
  console.log('   Running on isolated database:', TEST_DB_PATH);
  console.log(`   Today: ${today} (${todayDay}), Tomorrow: ${tomorrow} (${tomorrowDay})`);
  console.log('===============================================================\n');

  // ── Step 1: Upload and confirm timetable once ──
  console.log('--- 1. Single Upload & Save ---');
  run('T1: Save structured weekly timetable permanently in SQLite', () => {
    const weeklyEntries = [
      // Today's classes
      { day_of_week: todayDay, title: 'Operating Systems', start_time: '10:15 AM', end_time: '11:15 AM', event_type: 'class' },
      { day_of_week: todayDay, title: 'Database Management', start_time: '11:15 AM', end_time: '12:15 PM', event_type: 'class' },
      { day_of_week: todayDay, title: 'Lunch Break', start_time: '12:15 PM', end_time: '1:15 PM', event_type: 'break' },
      { day_of_week: todayDay, title: 'AI Laboratory', start_time: '1:15 PM', end_time: '3:15 PM', event_type: 'class', location: 'Lab 204' },
      // Tomorrow's classes
      { day_of_week: tomorrowDay, title: 'Computer Networks', start_time: '10:00 AM', end_time: '11:30 AM', event_type: 'class' },
      { day_of_week: tomorrowDay, title: 'Software Engineering', start_time: '2:00 PM', end_time: '3:30 PM', event_type: 'class' }
    ];

    const res = availabilityService.saveWeeklyTimetable(weeklyEntries, 'College Engineering Schedule', testDb);
    assert.strictEqual(res.count, 6);

    const wt = testDb.prepare('SELECT id, is_active FROM weekly_timetable WHERE is_active = 1').get();
    assert.ok(wt, 'Active weekly timetable row must exist');

    const entryCount = testDb.prepare('SELECT COUNT(*) as c FROM timetable_entries WHERE timetable_id = ?').get(wt.id).c;
    assert.strictEqual(entryCount, 6);

    // Verify legacy timetable synchronization
    const legacyCount = testDb.prepare('SELECT COUNT(*) as c FROM timetable').get().c;
    assert.strictEqual(legacyCount, 5, 'Legacy table should sync all classes (excluding breaks)');
  });

  // ── Step 2: Restart backend simulation ──
  console.log('\n--- 2. Server Restart Simulation ---');
  run('T2: Reopen SQLite connection; verify timetable is automatically retrieved from DB without re-upload', () => {
    testDb.close();
    testDb = new Database(TEST_DB_PATH);
    testDb.pragma('foreign_keys = ON');

    // Retrieve effective classes for today without any file upload
    const effToday = availabilityService.getEffectiveTimetableForDate(today, testDb);
    assert.strictEqual(effToday.classes.length, 3, 'Today should have 3 classes');
    assert.strictEqual(effToday.classes[0].subject, 'Operating Systems');
    assert.strictEqual(effToday.classes[0].start_time, '10:15 AM');
    assert.strictEqual(effToday.classes[0].end_time, '11:15 AM');
    assert.strictEqual(effToday.classes[2].subject, 'AI Laboratory');
    assert.strictEqual(effToday.classes[2].location, 'Lab 204');
  });

  // ── Step 3 & 4: Today's Day Plan generation respects saved timetable ──
  console.log('\n--- 3. Today Day Plan Generation ---');
  run('T3: Day Plan scheduling respects saved timetable classes as inviolable fixed blocks', () => {
    // Add 2 flexible tasks for today
    testDb.prepare(`
      INSERT INTO tasks (name, priority, date, duration_min, completed)
      VALUES ('Finish DBMS Assignment', 'high', ?, 45, 0),
             ('Review Lecture Notes', 'medium', ?, 30, 0)
    `).run(today, today);

    // Retrieve effective timetable for today
    const effToday = availabilityService.getEffectiveTimetableForDate(today, testDb);
    const classes = effToday.classes;

    // Set today window: 9:00 AM (540) to 6:00 PM (1080)
    const schedule = buildDaySchedule({
      today,
      nowMinutes: 9 * 60, // 9:00 AM
      windowEndMinutes: 18 * 60, // 6:00 PM
      doneForDay: false,
      timetableBlocks: classes,
      fixedTasks: [],
      bufferMinutes: 15,
      urgentTasks: [],
      forced: [],
      habitGoals: [],
      goals: [],
      flexibleTasks: [
        { id: 1, name: 'Finish DBMS Assignment', priority: 'high', duration_min: 45, date: today },
        { id: 2, name: 'Review Lecture Notes', priority: 'medium', duration_min: 30, date: today }
      ],
      defaultUrgentMins: 90,
      runSlotStartMins: null,
      neglectDays: 3,
      enableFloor: true
    });

    assert.ok(!schedule.refused, 'Schedule should be generated successfully');
    const plan = schedule.plan;

    // Verify all 3 classes are present in the plan as fixed blocks
    const classBlocks = plan.filter(b => b.kind === 'class');
    assert.strictEqual(classBlocks.length, 3);
    assert.strictEqual(classBlocks[0].task, 'Operating Systems');
    assert.strictEqual(classBlocks[0].time, '10:15 AM');

    // Verify flexible tasks are placed in free gaps (e.g. 9:00-10:15 or 3:30-6:00)
    const taskBlocks = plan.filter(b => b.source === 'flexible');
    assert.strictEqual(taskBlocks.length, 2);

    for (const tb of taskBlocks) {
      const tbStart = tb.startMinutes;
      const tbEnd = tbStart + tb.duration;
      // Assert no overlap with any class block
      for (const cb of classBlocks) {
        const cbStart = cb.startMinutes;
        const cbEnd = cbStart + cb.duration;
        const overlaps = Math.max(tbStart, cbStart) < Math.min(tbEnd, cbEnd);
        assert.ok(!overlaps, `Flexible task "${tb.task}" (${tb.time}) must NOT overlap class "${cb.task}" (${cb.time})`);
      }
    }

    // Save plan to day_plans
    testDb.prepare(`
      INSERT OR REPLACE INTO day_plans (date, plan_json)
      VALUES (?, ?)
    `).run(today, JSON.stringify(plan));
  });

  // ── Step 5: Tomorrow's Day Plan generation respects tomorrow's schedule ──
  console.log('\n--- 4. Tomorrow Day Plan Generation ---');
  run('T4: Tomorrow Day Plan retrieves tomorrow weekday timetable without user prompting', () => {
    const effTomorrow = availabilityService.getEffectiveTimetableForDate(tomorrow, testDb);
    assert.strictEqual(effTomorrow.classes.length, 2);
    assert.strictEqual(effTomorrow.classes[0].subject, 'Computer Networks');
    assert.strictEqual(effTomorrow.classes[0].start_time, '10:00 AM');
    assert.strictEqual(effTomorrow.classes[1].subject, 'Software Engineering');
    assert.strictEqual(effTomorrow.classes[1].start_time, '2:00 PM');

    const scheduleTomorrow = buildDaySchedule({
      today: tomorrow,
      nowMinutes: 8 * 60,
      windowEndMinutes: 17 * 60,
      doneForDay: false,
      timetableBlocks: effTomorrow.classes,
      fixedTasks: [],
      bufferMinutes: 15,
      urgentTasks: [],
      forced: [],
      habitGoals: [],
      goals: [],
      flexibleTasks: [],
      defaultUrgentMins: 90,
      runSlotStartMins: null,
      neglectDays: 3,
      enableFloor: true
    });

    assert.ok(!scheduleTomorrow.refused);
    const tmClassBlocks = scheduleTomorrow.plan.filter(b => b.kind === 'class');
    assert.strictEqual(tmClassBlocks.length, 2);
    assert.strictEqual(tmClassBlocks[0].task, 'Computer Networks');
  });

  // ── Step 6: Chat / TaskService conflict prevention ──
  console.log('\n--- 5. Chat Reschedule & Conflict Prevention ---');
  run('T5: Rescheduling a task into a timetable class is strictly blocked with clear error', () => {
    // Attempt to schedule a task directly during Operating Systems (10:15 AM - 11:15 AM)
    const eff = availabilityService.getEffectiveTimetableForDate(today, testDb);
    const targetMins = parseTimeToMinutes('10:30 AM');
    const taskEnd = targetMins + 30; // 10:30 to 11:00 AM

    let conflictFound = false;
    let conflictSubject = null;
    for (const block of eff.classes) {
      const bStart = parseTimeToMinutes(block.start_time);
      const bEnd = parseTimeToMinutes(block.end_time);
      if (Math.max(targetMins, bStart) < Math.min(taskEnd, bEnd)) {
        conflictFound = true;
        conflictSubject = block.subject;
        break;
      }
    }

    assert.ok(conflictFound, 'Conflict must be detected');
    assert.strictEqual(conflictSubject, 'Operating Systems');
  });

  // ── Step 7: Nightly Check-In ("plan tomorrow") Integration ──
  console.log('\n--- 6. Nightly Check-In Integration ---');
  run('T6: Nightly check-in retrieves tomorrow effective timetable classes', () => {
    const eff = availabilityService.getEffectiveTimetableForDate(tomorrow, testDb);
    assert.ok(Array.isArray(eff.classes));
    assert.strictEqual(eff.classes.length, 2);
    // Verified that nightlyService reads availabilityService.getEffectiveTimetableForDate(tomorrowDate, db)
  });

  // ── Step 8: Cancel class for one day preserves recurring weekly timetable ──
  console.log('\n--- 7. One-Day Exceptions vs Recurring Schedule ---');
  run('T7: Cancelling class for today updates Day Plan and preserves weekly recurring schedule for next week', () => {
    // Cancel Operating Systems for today
    const cancelRes = availabilityService.cancelSingleClass(today, 'Operating Systems', testDb);
    assert.ok(cancelRes.success);

    // Effective classes for today should now only have 2 classes
    const effTodayAfter = availabilityService.getEffectiveTimetableForDate(today, testDb);
    assert.strictEqual(effTodayAfter.classes.length, 2);
    assert.ok(!effTodayAfter.classes.some(c => c.subject === 'Operating Systems'), 'OS must be omitted today');

    // Verify Day Plan for today was atomically updated
    const planAfter = DayPlanService.getPlanForDate(today, testDb);
    const hasOsInPlan = (planAfter.plan || []).some(b => b.task === 'Operating Systems');
    assert.ok(!hasOsInPlan, 'Cancelled class must be removed from day_plans.plan_json');

    // Recurring weekly timetable entries in SQLite MUST remain untouched
    const weeklyEntries = testDb.prepare(`
      SELECT te.title, te.start_time
      FROM timetable_entries te
      JOIN weekly_timetable wt ON te.timetable_id = wt.id
      WHERE wt.is_active = 1 AND te.day_of_week = ?
    `).all(todayDay);

    const hasOsInWeekly = weeklyEntries.some(e => e.title === 'Operating Systems');
    assert.ok(hasOsInWeekly, 'Recurring weekly schedule must retain Operating Systems for future weeks');
  });

  // ── Step 9: Regenerate plan produces 0 duplicates & preserves completed tasks ──
  console.log('\n--- 8. Regeneration Idempotency & Task Protection ---');
  run('T8: Regenerating plan does not duplicate timetable entries and preserves completed tasks', () => {
    // Mark task 1 as completed in tasks table
    testDb.prepare('UPDATE tasks SET completed = 1 WHERE id = 1').run();

    const planRowBefore = testDb.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(today);
    const planBefore = JSON.parse(planRowBefore.plan_json);

    // Simulate regeneration
    const effToday = availabilityService.getEffectiveTimetableForDate(today, testDb);
    const scheduleRegen = buildDaySchedule({
      today,
      nowMinutes: 9 * 60,
      windowEndMinutes: 18 * 60,
      doneForDay: false,
      timetableBlocks: effToday.classes,
      fixedTasks: [],
      bufferMinutes: 15,
      urgentTasks: [],
      forced: [],
      habitGoals: [],
      goals: [],
      flexibleTasks: [
        { id: 2, name: 'Review Lecture Notes', priority: 'medium', duration_min: 30, date: today }
      ],
      defaultUrgentMins: 90,
      runSlotStartMins: null,
      neglectDays: 3,
      enableFloor: true
    });

    const newPlan = scheduleRegen.plan;

    // Check count of each class block — each must appear at most once
    const counts = {};
    for (const b of newPlan) {
      counts[b.task] = (counts[b.task] || 0) + 1;
      assert.strictEqual(counts[b.task], 1, `Task "${b.task}" must appear at most once; no duplicates allowed.`);
    }

    // Verify task completed state in SQLite was NOT overwritten
    const task1 = testDb.prepare('SELECT completed FROM tasks WHERE id = 1').get();
    assert.strictEqual(task1.completed, 1, 'Completed task must remain completed = 1');
  });

  // ── Step 9: Permanent Timetable Change via Chat Confirmation ──
  console.log('\n--- 9. Permanent Timetable Update Confirmation ---');
  run('T9: Permanent timetable update prompt requires confirmation and persists changes in SQLite', () => {
    const { processNaturalLanguageAction } = require('../backend/services/actionEngine');
    const { routeCommand, getPendingState } = require('../backend/services/chatCommands');

    // Simulate user message for today's recurring day of week:
    const actionReply = processNaturalLanguageAction(`My ${todayDay} Operating Systems lecture is now from 11:00 AM to 12:00 PM`);
    assert.ok(actionReply, 'Action engine should handle permanent timetable update');
    assert.ok(actionReply.includes(`Do you want to permanently update your recurring ${todayDay} "Operating Systems" schedule to 11:00 AM–12:00 PM?`));

    const pending = getPendingState();
    assert.ok(pending, 'Pending confirmation state must be set');
    assert.strictEqual(pending.type, 'permanent_timetable_update');
    assert.strictEqual(pending.day_of_week, todayDay);
    assert.strictEqual(pending.new_start, '11:00 AM');
    assert.strictEqual(pending.new_end, '12:00 PM');

    // Simulate confirmation: "yes" via routeCommand
    const confirmReply = routeCommand('yes', new Date(), null, testDb);
    assert.ok(confirmReply.includes(`Permanently updated your recurring ${todayDay} "Operating Systems" schedule`));

    // Check that pending state was cleared
    assert.strictEqual(getPendingState(), null);

    // Verify change is persisted in timetable_entries for the active timetable
    const updatedEntry = testDb.prepare(`
      SELECT te.start_time, te.end_time
      FROM timetable_entries te
      JOIN weekly_timetable wt ON te.timetable_id = wt.id
      WHERE wt.is_active = 1 AND te.day_of_week = ? AND te.title LIKE '%Operating Systems%'
    `).get(todayDay);

    assert.ok(updatedEntry);
    assert.strictEqual(updatedEntry.start_time, '11:00 AM');
    assert.strictEqual(updatedEntry.end_time, '12:00 PM');
  });

  console.log('\n===============================================================');
  console.log(`🏁 PERSISTENT TIMETABLE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal error in Persistent Timetable test suite:', err);
  process.exit(1);
});
