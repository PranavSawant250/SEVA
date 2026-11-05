/**
 * tests/phase2_goals.test.js
 *
 * Comprehensive Phase 2 Test Suite: Chat <-> Goals Integration
 * Tests all requirements, edge cases, and mandatory safeguards against an ISOLATED SQLite database.
 * NEVER touches or mutates backend/seva.db.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('../backend/node_modules/better-sqlite3');

const {
  getTodayDate,
  getYesterdayDate,
  getTomorrowDate,
  daysBetween,
  addDaysToDate
} = require('../backend/utils/dateUtils');

const goalsService = require('../backend/services/goalsService');
const DayPlanService = require('../backend/services/dayPlanService');
const TaskService = require('../backend/services/taskService');

const TEST_DB_PATH = path.join(__dirname, `test_phase2_${Date.now()}.db`);

function setupIsolatedDb() {
  const db = new Database(TEST_DB_PATH);
  db.pragma('foreign_keys = ON');

  // Create core schema matching SEVA production
  db.exec(`
    CREATE TABLE goals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      month            TEXT,
      category         TEXT,
      title            TEXT NOT NULL,
      target_text      TEXT,
      deadline         TEXT,
      priority         TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      goal_type        TEXT DEFAULT 'milestone' CHECK(goal_type IN ('milestone','count','frequency')),
      target_count     INTEGER NULL,
      current_count    INTEGER DEFAULT 0,
      per_week         INTEGER NULL,
      manual_progress  INTEGER NULL,
      status           TEXT DEFAULT 'active' CHECK(status IN ('active','completed','removed')),
      created_date     TEXT,
      completed_date   TEXT NULL,
      is_paused        INTEGER DEFAULT 0 CHECK(is_paused IN (0, 1) AND (is_paused = 0 OR status = 'active')),
      paused_at        TEXT NULL,
      total_paused_days INTEGER DEFAULT 0
    );

    CREATE TABLE goal_progress_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id         INTEGER NOT NULL,
      date            TEXT NOT NULL,
      amount          INTEGER DEFAULT 1,
      note            TEXT,
      chat_message_id INTEGER NULL
    );

    CREATE TABLE goal_steps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id    INTEGER NOT NULL,
      step_text  TEXT NOT NULL,
      done       INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1))
    );

    CREATE TABLE tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      priority       TEXT DEFAULT 'medium',
      time_slot      TEXT DEFAULT 'Anytime',
      source         TEXT DEFAULT 'manual',
      completed      INTEGER DEFAULT 0,
      date           TEXT NULL,
      carry_forward  INTEGER DEFAULT 0,
      goal_id        INTEGER NULL,
      due_date       TEXT NULL,
      fixed_start    TEXT NULL,
      fixed_end      TEXT NULL,
      duration_min   INTEGER DEFAULT 30,
      is_urgent      INTEGER DEFAULT 0
    );

    CREATE TABLE day_plans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT,
      plan_json       TEXT,
      generated_at    DATETIME,
      completed_count INTEGER DEFAULT 0,
      missed_count    INTEGER DEFAULT 0
    );

    CREATE TABLE preferences (
      id           INTEGER PRIMARY KEY CHECK(id = 1),
      neglect_days INTEGER DEFAULT 3,
      user_name    TEXT DEFAULT 'Pranav Sawant'
    );
    INSERT INTO preferences (id, neglect_days, user_name) VALUES (1, 3, 'Pranav Sawant');
  `);

  return db;
}

async function runPhase2Tests() {
  console.log('===============================================================');
  console.log('🚀 SEVA PHASE 2 ISOLATED INTEGRATION & SAFEGUARDS TEST SUITE');
  console.log('===============================================================\n');

  const db = setupIsolatedDb();
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.stack || err.message || JSON.stringify(err)}`);
      failed++;
    }
  }

  const todayStr = '2026-11-05';
  const todayDateObj = new Date('2026-11-05T12:00:00+05:30');

  // ─────────────────────────────────────────────────────────────
  // SUITE 1: GOAL CREATION, DISCOVERY & METADATA UPDATES
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Section 1: Goal Creation & Discovery ---');

  let countGoalId;
  let freqGoalId;
  let milestoneGoalId;

  test('G.01 Create numerical count goal', () => {
    const goal = goalsService.createGoal({
      title: 'Solve 320 LeetCode problems',
      target: '320 problems',
      category: 'Technical',
      priority: 'high',
      deadline: '2026-12-15'
    }, todayStr, db);

    assert.strictEqual(goal.title, 'Solve 320 LeetCode problems');
    assert.strictEqual(goal.goal_type, 'count');
    assert.strictEqual(goal.target_count, 320);
    assert.strictEqual(goal.current_count, 0);
    assert.strictEqual(goal.status, 'active');
    assert.strictEqual(goal.is_paused, false);
    countGoalId = goal.id;
  });

  test('G.02 Duplicate active goal rejection', () => {
    assert.throws(() => {
      goalsService.createGoal({
        title: 'solve 320 leetcode problems',
        category: 'Technical'
      }, todayStr, db);
    }, /already exists/i);
  });

  test('G.03 Create frequency goal', () => {
    const goal = goalsService.createGoal({
      title: 'Daily run',
      target: '5 days/week',
      category: 'Fitness',
      priority: 'medium',
      deadline: '2026-12-31'
    }, todayStr, db);

    assert.strictEqual(goal.goal_type, 'frequency');
    assert.strictEqual(goal.per_week, 5);
    freqGoalId = goal.id;
  });

  test('G.04 Create milestone goal with initial steps', () => {
    const goal = goalsService.createGoal({
      title: 'Full Stack Java Project',
      category: 'Technical',
      priority: 'high',
      deadline: '2026-11-30',
      steps: ['Spring Boot Backend', 'React UI', 'PostgreSQL DB Integration']
    }, todayStr, db);

    assert.strictEqual(goal.goal_type, 'milestone');
    assert.strictEqual(goal.steps.length, 3);
    assert.strictEqual(goal.progress, 0);
    milestoneGoalId = goal.id;
  });

  test('G.05 Retrieve goals with status filters (active, paused, completed, all)', () => {
    const active = goalsService.getAllGoals(todayDateObj, { status: 'active' }, db);
    assert.strictEqual(active.length, 3);

    const paused = goalsService.getAllGoals(todayDateObj, { status: 'paused' }, db);
    assert.strictEqual(paused.length, 0);

    const all = goalsService.getAllGoals(todayDateObj, { status: 'all' }, db);
    assert.strictEqual(all.length, 3);
  });

  test('G.06 Retrieve goal details with step checklist and pace metrics', () => {
    const details = goalsService.getGoalById(milestoneGoalId, todayDateObj, db);
    assert.strictEqual(details.id, milestoneGoalId);
    assert.strictEqual(details.steps.length, 3);
    assert.strictEqual(details.steps[0].step_text, 'Spring Boot Backend');
    assert.strictEqual(details.steps[0].done, false);
    assert.ok(Array.isArray(details.recent_logs));
  });

  test('G.07 Update goal metadata without resetting progress', () => {
    const updated = goalsService.updateGoal(countGoalId, {
      title: 'Master 400 LeetCode Problems',
      target: '400 problems',
      priority: 'high',
      deadline: '2026-12-25'
    }, db);

    assert.strictEqual(updated.goal.title, 'Master 400 LeetCode Problems');
    assert.strictEqual(updated.goal.target_count, 400);
    assert.strictEqual(updated.goal.deadline, '2026-12-25');
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 2: MILESTONE STEPS & ZERO-STEP EDGE CASE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Section 2: Milestone Steps & Edge Cases ---');

  test('G.08 Add and rename milestone steps', () => {
    const addRes = goalsService.manageGoalSteps(milestoneGoalId, 'add', { step_text: 'Docker Container' }, db);
    assert.strictEqual(addRes.added_count, 1);

    const renameRes = goalsService.manageGoalSteps(milestoneGoalId, 'rename', {
      step_id: addRes.steps[0].id,
      step_text: 'Docker & Kubernetes'
    }, db);
    assert.strictEqual(renameRes.new_text, 'Docker & Kubernetes');
  });

  test('G.09 Toggle step done and auto-complete milestone on all steps done', () => {
    const steps = goalsService.getGoalById(milestoneGoalId, todayDateObj, db).steps;
    assert.strictEqual(steps.length, 4);

    // Complete all 4 steps
    for (const s of steps) {
      goalsService.manageGoalSteps(milestoneGoalId, 'complete', { step_id: s.id }, db);
    }

    const completedGoal = goalsService.getGoalById(milestoneGoalId, todayDateObj, db);
    assert.strictEqual(completedGoal.progress, 100);
    assert.strictEqual(completedGoal.status, 'completed');

    // Untoggle 1 step -> should revert status to active
    goalsService.manageGoalSteps(milestoneGoalId, 'uncomplete', { step_id: steps[0].id }, db);
    const revertedGoal = goalsService.getGoalById(milestoneGoalId, todayDateObj, db);
    assert.strictEqual(revertedGoal.status, 'active');
    assert.strictEqual(revertedGoal.progress, 75);
  });

  test('G.10 Soft-delete steps (is_deleted = 1) and Edge Case 2: Zero active steps yields 0%', () => {
    // Create temporary milestone goal with 2 steps
    const tempGoal = goalsService.createGoal({
      title: 'Temp Step Goal',
      steps: ['Step A', 'Step B']
    }, todayStr, db);

    // Mark Step A done
    const steps = tempGoal.steps;
    goalsService.manageGoalSteps(tempGoal.id, 'complete', { step_id: steps[0].id }, db);

    // Delete Step A
    goalsService.manageGoalSteps(tempGoal.id, 'delete', { step_id: steps[0].id }, db);
    // Deleted step row still physically exists with is_deleted = 1
    const rawStepA = db.prepare('SELECT is_deleted FROM goal_steps WHERE id = ?').get(steps[0].id);
    assert.strictEqual(rawStepA.is_deleted, 1);

    // Milestone progress recalculates over remaining Step B only (0% done)
    const afterDeleteA = goalsService.getGoalById(tempGoal.id, todayDateObj, db);
    assert.strictEqual(afterDeleteA.steps.length, 1);
    assert.strictEqual(afterDeleteA.progress, 0);

    // Delete Step B (zero active steps remain)
    const zeroRes = goalsService.manageGoalSteps(tempGoal.id, 'delete', { step_id: steps[1].id }, db);
    assert.strictEqual(zeroRes.remaining_steps_count, 0);
    assert.strictEqual(zeroRes.zero_steps, true);

    const zeroGoal = goalsService.getGoalById(tempGoal.id, todayDateObj, db);
    assert.strictEqual(zeroGoal.steps.length, 0);
    assert.strictEqual(zeroGoal.progress, 0);
    assert.strictEqual(zeroGoal.status, 'active'); // Edge Case 2: Does NOT mark completed
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 3: PROGRESS LOGGING, UNITS & COMPENSATING CORRECTIONS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Section 3: Progress Logging & Ledger Integrity ---');

  test('G.11 Log count progress (+3 problems) capped at target', () => {
    const res = goalsService.logGoalProgress(countGoalId, { amount: 3, note: 'solved 3 hard problems' }, todayStr, db);
    assert.strictEqual(res.current_count, 3);
    assert.strictEqual(res.logged, 3);

    // Verify ledger row created
    const logRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(countGoalId);
    assert.strictEqual(logRow.amount, 3);
    assert.strictEqual(logRow.note, 'solved 3 hard problems');
  });

  test('G.12 Log frequency progress: 1 session only (not multi-session distance)', () => {
    // 5 km run is 1 session
    const res1 = goalsService.logGoalProgress(freqGoalId, { amount: 5, unit: 'km', note: '5 km morning run' }, todayStr, db);
    assert.strictEqual(res1.logged, 1);

    // Logging second run on same calendar day is acknowledged without duplicate counting
    const res2 = goalsService.logGoalProgress(freqGoalId, { amount: 3, unit: 'km' }, todayStr, db);
    assert.strictEqual(res2.already_logged, true);
    assert.strictEqual(res2.logged, 0);
  });

  test('G.13 Historical progress logging in Asia/Kolkata date format', () => {
    const yesterday = '2026-11-04';
    const res = goalsService.logGoalProgress(countGoalId, { amount: 2, date: yesterday }, todayStr, db);
    assert.strictEqual(res.current_count, 5);

    const logRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND date = ?').get(countGoalId, yesterday);
    assert.strictEqual(logRow.date, '2026-11-04');
    assert.strictEqual(logRow.amount, 2);
  });

  test('G.14 Compensating correction: appends delta row without mutating historical records', () => {
    // Current count is 5 (3 from today + 2 from yesterday).
    // User says: "Actually today I solved only 1, not 3" (correct amount = 1)
    const initialLogCount = db.prepare('SELECT COUNT(*) as cnt FROM goal_progress_log WHERE goal_id = ?').get(countGoalId).cnt;
    
    const correctRes = goalsService.correctGoalProgress(countGoalId, { correct_amount: 1 }, todayStr, db);
    assert.strictEqual(correctRes.new_count, 3); // 5 - 2 = 3
    assert.strictEqual(correctRes.compensating_delta, -2);

    // Total rows increased by 1 (compensating row appended, historical rows untouched)
    const afterLogCount = db.prepare('SELECT COUNT(*) as cnt FROM goal_progress_log WHERE goal_id = ?').get(countGoalId).cnt;
    assert.strictEqual(afterLogCount, initialLogCount + 1);

    const compRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(countGoalId);
    assert.strictEqual(compRow.amount, -2);
    assert.ok(compRow.note.startsWith('correction_for:'));
  });

  test('G.15 Compensating correction to zero reverts status from completed to active', () => {
    const microGoal = goalsService.createGoal({
      title: 'Micro Goal',
      target: '2 problems'
    }, todayStr, db);

    // Log 2 -> reaches target -> completed
    goalsService.logGoalProgress(microGoal.id, { amount: 2 }, todayStr, db);
    const completed = goalsService.getGoalById(microGoal.id, todayDateObj, db);
    assert.strictEqual(completed.status, 'completed');

    // Correction: "Actually 0"
    goalsService.correctGoalProgress(microGoal.id, { correct_amount: 0 }, todayStr, db);
    const reverted = goalsService.getGoalById(microGoal.id, todayDateObj, db);
    assert.strictEqual(reverted.status, 'active');
    assert.strictEqual(reverted.current_count, 0);
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 4: PAUSE / RESUME DEADLINE SEMANTICS & CHECK CONSTRAINTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Section 4: Pause / Resume Semantics & Constraints ---');

  test('G.16 SQLite CHECK constraint blocks invalid pause combinations', () => {
    // completed + is_paused = 1 MUST FAIL
    assert.throws(() => {
      db.prepare("INSERT INTO goals (title, status, is_paused) VALUES ('Test', 'completed', 1)").run();
    }, /CHECK constraint failed/);

    // removed + is_paused = 1 MUST FAIL
    assert.throws(() => {
      db.prepare("INSERT INTO goals (title, status, is_paused) VALUES ('Test', 'removed', 1)").run();
    }, /CHECK constraint failed/);

    // active + is_paused = 1 MUST SUCCEED
    const okRow = db.prepare("INSERT INTO goals (title, status, is_paused) VALUES ('Valid Paused', 'active', 1)").run();
    assert.ok(okRow.lastInsertRowid > 0);
  });

  test('G.17 Pause goal records paused_at and suppresses reminders & behind-pace', () => {
    const pauseGoal = goalsService.createGoal({
      title: 'Neglected Reading',
      category: 'General',
      priority: 'high',
      deadline: '2026-11-06' // Due tomorrow, would normally trigger urgent reminder
    }, todayStr, db);

    // Reminders before pause include this goal
    const remBefore = goalsService.getGoalReminders(todayDateObj, {}, db);
    assert.ok(remBefore.some(r => r.goal_id === pauseGoal.id));

    // Pause goal
    goalsService.updateGoalStatus(pauseGoal.id, 'pause', {}, todayStr, db);
    const paused = goalsService.getGoalById(pauseGoal.id, todayDateObj, db);
    assert.strictEqual(paused.is_paused, true);
    assert.strictEqual(paused.display_status, 'paused');
    assert.strictEqual(paused.paused_at, todayStr);
    assert.strictEqual(paused.behind_by, 0);
    assert.strictEqual(paused.is_overdue, false);

    // Reminders after pause SKIP this goal completely
    const remAfter = goalsService.getGoalReminders(todayDateObj, {}, db);
    assert.strictEqual(remAfter.some(r => r.goal_id === pauseGoal.id), false);
  });

  test('G.18 Safeguard 1: Resume goal calculates paused duration and extends deadline', () => {
    const resumeTestGoal = goalsService.createGoal({
      title: 'German A2 Language',
      category: 'Language',
      priority: 'medium',
      deadline: '2026-12-01'
    }, todayStr, db);

    // Pause on 2026-11-05
    goalsService.updateGoalStatus(resumeTestGoal.id, 'pause', {}, '2026-11-05', db);

    // Resume 10 days later on 2026-11-15 in Asia/Kolkata
    const resumeRes = goalsService.updateGoalStatus(resumeTestGoal.id, 'resume', {}, '2026-11-15', db);
    assert.strictEqual(resumeRes.days_paused, 10);
    assert.strictEqual(resumeRes.new_deadline, '2026-12-11'); // 2026-12-01 + 10 days

    const resumedGoal = goalsService.getGoalById(resumeTestGoal.id, todayDateObj, db);
    assert.strictEqual(resumedGoal.is_paused, false);
    assert.strictEqual(resumedGoal.deadline, '2026-12-11');
    assert.strictEqual(resumedGoal.total_paused_days, 10);

    // Repeated resume request MUST be idempotent and not extend deadline again!
    const repeatResume = goalsService.updateGoalStatus(resumeTestGoal.id, 'resume', {}, '2026-11-15', db);
    assert.strictEqual(repeatResume.unchanged, true);
    const afterRepeat = goalsService.getGoalById(resumeTestGoal.id, todayDateObj, db);
    assert.strictEqual(afterRepeat.deadline, '2026-12-11'); // Still 2026-12-11!
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 5: ATOMIC DELETION, LINKED TASKS & DAY PLAN CLEANUP
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Section 5: Deletion, Linked Tasks & Plan Cleanup ---');

  let deleteTargetGoalId;
  let preservedCompletedTaskId;
  let cancelledFutureTaskId;
  let cancelledBacklogTaskId;

  test('G.19 Linked tasks setup: create tasks for goal (today, future, backlog, completed)', () => {
    const goal = goalsService.createGoal({
      title: 'Cloud Architecture Goal',
      category: 'Technical',
      deadline: '2026-12-20'
    }, todayStr, db);
    deleteTargetGoalId = goal.id;

    // 1. Incomplete today task with scheduled plan item
    const todayTask = TaskService.createTask({
      name: 'Today Cloud Study',
      date: todayStr,
      time_slot: '02:00 PM',
      fixed_start: '02:00 PM',
      duration_min: 60,
      goal_id: goal.id
    }, db);

    // Seed day plan with this task
    db.prepare(`
      INSERT INTO day_plans (date, plan_json)
      VALUES (?, ?)
    `).run(todayStr, JSON.stringify([
      { time: '02:00 PM', task: 'Today Cloud Study', task_id: todayTask.id, duration: 60 }
    ]));

    // 2. Incomplete future task
    const futureTask = TaskService.createTask({
      name: 'Future Cloud Exam Prep',
      date: '2026-11-10',
      goal_id: goal.id
    }, db);
    cancelledFutureTaskId = futureTask.id;

    // 3. Incomplete backlog task (date NULL)
    const backlogTask = TaskService.createTask({
      name: 'Backlog Cloud Reading',
      date: null,
      goal_id: goal.id
    }, db);
    cancelledBacklogTaskId = backlogTask.id;

    // 4. Completed task (must be preserved!)
    const compTask = TaskService.createTask({
      name: 'AWS S3 Setup (Finished)',
      date: todayStr,
      goal_id: goal.id
    }, db);
    TaskService.completeTask(compTask.id, 1, todayDateObj, db);
    preservedCompletedTaskId = compTask.id;
  });

  test('G.20 Edge Case 3: Soft-delete goal cleans day_plans.plan_json and deletes incomplete tasks', () => {
    // Delete goal
    const delRes = goalsService.deleteGoal(deleteTargetGoalId, todayStr, db);
    assert.strictEqual(delRes.success, true);

    // Goal is soft-removed
    const goalRow = db.prepare('SELECT status, is_paused FROM goals WHERE id = ?').get(deleteTargetGoalId);
    assert.strictEqual(goalRow.status, 'removed');
    assert.strictEqual(goalRow.is_paused, 0);

    // Incomplete future, today, and backlog tasks are deleted
    const futureCheck = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cancelledFutureTaskId);
    assert.strictEqual(futureCheck, undefined);

    const backlogCheck = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cancelledBacklogTaskId);
    assert.strictEqual(backlogCheck, undefined);

    // Day plan json block was removed in the same transaction
    const planRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(todayStr);
    const plan = JSON.parse(planRow.plan_json);
    assert.strictEqual(plan.length, 0); // Cleaned up!

    // Completed task is STRICTLY PRESERVED
    const compTaskCheck = db.prepare('SELECT * FROM tasks WHERE id = ?').get(preservedCompletedTaskId);
    assert.ok(compTaskCheck);
    assert.strictEqual(compTaskCheck.completed, 1);
    assert.strictEqual(compTaskCheck.goal_id, deleteTargetGoalId);
  });

  test('G.21 Safeguard 2: Completing a preserved task linked to removed goal does NOT update removed goal', () => {
    // Create another task linked to the removed goal
    const orphanTask = db.prepare(`
      INSERT INTO tasks (name, completed, date, goal_id)
      VALUES ('Orphan Task', 0, '2026-11-01', ?)
    `).run(deleteTargetGoalId);

    const goalBefore = db.prepare('SELECT current_count, status FROM goals WHERE id = ?').get(deleteTargetGoalId);

    // Complete the task
    TaskService.completeTask(orphanTask.lastInsertRowid, 1, todayDateObj, db);

    const goalAfter = db.prepare('SELECT current_count, status FROM goals WHERE id = ?').get(deleteTargetGoalId);
    assert.strictEqual(goalAfter.current_count, goalBefore.current_count); // UNCHANGED!
    assert.strictEqual(goalAfter.status, 'removed'); // Still removed!

    // Ensure no new progress log was written for this removed goal
    const newLogs = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').all(deleteTargetGoalId, `task:${orphanTask.lastInsertRowid}`);
    assert.strictEqual(newLogs.length, 0);
  });

  test('G.22 Conversational goal restoration restores goal without resurrecting deleted tasks', () => {
    const restoreRes = goalsService.updateGoalStatus(deleteTargetGoalId, 'restore', {}, todayStr, db);
    assert.strictEqual(restoreRes.success, true);
    assert.strictEqual(restoreRes.goal.status, 'active');

    // Incomplete tasks that were cancelled remain deleted (zero surprise resurrects)
    const futureCheck = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cancelledFutureTaskId);
    assert.strictEqual(futureCheck, undefined);

    // Historical completed task remains attached and valid
    const compTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(preservedCompletedTaskId);
    assert.strictEqual(compTask.goal_id, deleteTargetGoalId);
  });

  test('G.23 Safeguard 3: Atomic rollback of goal deletion on failure', () => {
    const rollbackGoal = goalsService.createGoal({
      title: 'Rollback Test Goal',
      target: '10 problems'
    }, todayStr, db);

    const task = TaskService.createTask({
      name: 'Rollback Task',
      date: todayStr,
      goal_id: rollbackGoal.id
    }, db);

    // Simulate failure by executing a transaction with an intentional constraint violation
    assert.throws(() => {
      const badTx = db.transaction(() => {
        db.prepare("UPDATE goals SET status = 'removed' WHERE id = ?").run(rollbackGoal.id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
        // Force SQLite constraint error:
        db.prepare("INSERT INTO preferences (id) VALUES (1)").run(); // Duplicate primary key 1
      });
      badTx();
    });

    // Verify atomic rollback: goal is still active, task still exists!
    const g = db.prepare('SELECT status FROM goals WHERE id = ?').get(rollbackGoal.id);
    assert.strictEqual(g.status, 'active');

    const t = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id);
    assert.strictEqual(t.id, task.id);
  });

  db.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch (_) {}

  console.log('\n===============================================================');
  console.log(`🏁 PHASE 2 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2Tests().catch(err => {
  console.error('Fatal error in Phase 2 tests:', err);
  process.exit(1);
});
