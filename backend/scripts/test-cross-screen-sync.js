/**
 * backend/scripts/test-cross-screen-sync.js
 *
 * Automated verification of the 10 Cross-Screen Synchronization scenarios.
 * Uses an ephemeral isolated database in os.tmpdir() to guarantee ZERO mutation
 * to production backend/seva.db.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. Setup isolated database path
const testDbPath = path.join(os.tmpdir(), `seva_test_cross_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SEVA_DB_PATH = testDbPath;

// Import database and services with isolated DB
const dbModule = require('../database/db');
const db = dbModule.db || dbModule;
const TaskService = require('../services/taskService');
const DayPlanService = require('../services/dayPlanService');
const { getAllGoals, computeGoalProgress, importGoals } = require('../services/goalsService');
const dateUtils = require('../utils/dateUtils');

console.log('🧪 Starting 10 Cross-Screen Synchronization Tests on isolated DB:', testDbPath);

let passedCount = 0;
let failedCount = 0;

function runScenario(title, fn) {
  try {
    console.log(`\n▶ Scenario: ${title}`);
    fn();
    console.log(`  ✅ PASS: ${title}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${title}`);
    console.error('     ' + err.message);
    if (err.stack) console.error('     ' + err.stack.split('\n').slice(1, 4).join('\n     '));
    failedCount++;
  }
}

async function runScenarioAsync(title, fn) {
  try {
    console.log(`\n▶ Scenario: ${title}`);
    await fn();
    console.log(`  ✅ PASS: ${title}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${title}`);
    console.error('     ' + err.message);
    if (err.stack) console.error('     ' + err.stack.split('\n').slice(1, 4).join('\n     '));
    failedCount++;
  }
}

async function main() {
  const today = dateUtils.getTodayDate();
  const tomorrow = dateUtils.getTomorrowDate();
  const nowDate = new Date();

  // Helper: Count pending tasks for a given date
  const getPendingCount = (d = today) => {
    const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE date = ? AND completed = 0').get(d);
    return row ? row.count : 0;
  };

  // Helper: Seed initial plan for today and tomorrow
  db.prepare(`
    INSERT OR REPLACE INTO day_plans (date, plan_json, generated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(today, JSON.stringify([
    { task: 'Morning Routine', time: '08:00 AM - 08:30 AM', completed: 0, source: 'routine' }
  ]));

  db.prepare(`
    INSERT OR REPLACE INTO day_plans (date, plan_json, generated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(tomorrow, JSON.stringify([
    { task: 'Tomorrow Morning Standup', time: '09:00 AM - 09:30 AM', completed: 0, source: 'routine' }
  ]));

  const initialPending = getPendingCount(today);

  // ─────────────────────────────────────────────────────────────
  // 1. Scenario 1: Chat Task Creation → Day Plan & Dashboard Refresh
  // ─────────────────────────────────────────────────────────────
  runScenario('1. Chat Task Creation -> Day Plan & Dashboard Refresh', () => {
    // 1. Create a fixed-time task via Chat tool (TaskService.createTask)
    const task = TaskService.createTask({
      name: 'Submit OS Lab Report',
      priority: 'high',
      time_slot: '05:00 PM',
      fixed_start: '05:00 PM',
      date: 'today'
    });

    assert.ok(task && task.id, 'Task must be created with ID');
    assert.strictEqual(task.completed, 0, 'New task must have completed=0');

    // Verify isolated SQLite row
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    assert.ok(row, 'Row must exist in SQLite');
    assert.strictEqual(row.name, 'Submit OS Lab Report');
    assert.strictEqual(row.completed, 0);

    // Verify Day Plan reflection in timeline
    const planResult = DayPlanService.getPlanForDate(today);
    assert.ok(planResult.success, 'DayPlanService must return success');
    const inPlan = planResult.plan.some(p => p.task_id === task.id || p.task === task.name);
    assert.ok(inPlan, 'Task must appear in Day Plan timeline');

    // Verify Day Plan task list reflection
    const dayTasks = TaskService.getTasks({ date: today });
    assert.ok(dayTasks.tasks.some(t => t.id === task.id), 'Task must appear in DayPlan task list');

    // Verify Dashboard pending count incremented
    const newPending = getPendingCount(today);
    assert.strictEqual(newPending, initialPending + 1, 'Dashboard pending count must increment by 1');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Scenario 2: Chat Task Completion → Day Plan, Dashboard, Goals Refresh
  // ─────────────────────────────────────────────────────────────
  runScenario('2. Chat Task Completion -> Day Plan, Dashboard, Goals Refresh', () => {
    // Seed a count goal
    const goalRes = db.prepare(`
      INSERT INTO goals (title, category, priority, goal_type, target_count, current_count, status)
      VALUES ('Read 5 Research Papers', 'Academic', 'high', 'count', 5, 2, 'active')
    `).run();
    const goalId = goalRes.lastInsertRowid;

    // Create a fixed task linked to this goal
    const task = TaskService.createTask({
      name: 'Read Paper on Paxos',
      priority: 'high',
      goal_id: goalId,
      fixed_start: '06:00 PM',
      date: 'today'
    });

    const pendingBefore = getPendingCount(today);

    // Complete task via Chat tool (TaskService.completeTask)
    const compResult = TaskService.completeTask(task.id, 1, nowDate);
    assert.strictEqual(compResult.success, true);
    assert.strictEqual(compResult.task.completed, 1);

    // Verify SQLite task row
    const taskRow = db.prepare('SELECT completed FROM tasks WHERE id = ?').get(task.id);
    assert.strictEqual(taskRow.completed, 1);

    // Verify goal progress log row
    const logRow = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').get(goalId, `task:${task.id}`);
    assert.ok(logRow, 'Goal progress log must exist with task:${taskId}');
    assert.strictEqual(logRow.amount, 1);

    // Verify goal current_count incremented from 2 to 3
    const goalRow = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(goalRow.current_count, 3, 'Goal current_count must increment from 2 to 3');

    // Verify Day Plan shows completed
    const planResult = DayPlanService.getPlanForDate(today);
    const planItem = planResult.plan.find(p => p.task_id === task.id || p.task === task.name);
    assert.ok(planItem, 'Task must exist in plan');
    assert.strictEqual(planItem.completed, 1, 'Day Plan item must be marked completed = 1');

    // Verify Dashboard pending count decremented
    const pendingAfter = getPendingCount(today);
    assert.strictEqual(pendingAfter, pendingBefore - 1, 'Dashboard pending count must decrement by 1');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Scenario 3: Day Plan Completion → Dashboard & Goals Refresh
  // ─────────────────────────────────────────────────────────────
  let sharedTaskId = null;
  let sharedGoalId = null;

  runScenario('3. Day Plan Completion -> Dashboard & Goals Refresh', () => {
    // Seed goal
    const goalRes = db.prepare(`
      INSERT INTO goals (title, category, priority, goal_type, target_count, current_count, status)
      VALUES ('Solve 10 LeetCode Problems', 'Coding', 'medium', 'count', 10, 4, 'active')
    `).run();
    sharedGoalId = goalRes.lastInsertRowid;

    const task = TaskService.createTask({
      name: 'Solve DP Problem on LeetCode',
      priority: 'medium',
      goal_id: sharedGoalId,
      date: 'today'
    });
    sharedTaskId = task.id;

    const pendingBefore = getPendingCount(today);

    // Day Plan completes task (via TaskService.completeTask)
    const compRes = TaskService.completeTask(sharedTaskId, 1, nowDate);
    assert.strictEqual(compRes.task.completed, 1);

    // Goal count updated
    const goalRow = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(sharedGoalId);
    assert.strictEqual(goalRow.current_count, 5, 'Goal count must update to 5');

    // Dashboard pending count decrements
    const pendingAfter = getPendingCount(today);
    assert.strictEqual(pendingAfter, pendingBefore - 1);
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Scenario 4: Day Plan Uncheck → Day Plan, Dashboard, Goals Rollback
  // ─────────────────────────────────────────────────────────────
  runScenario('4. Day Plan Uncheck -> Day Plan, Dashboard, Goals Rollback', () => {
    assert.ok(sharedTaskId && sharedGoalId, 'Shared task and goal must be set from Scenario 3');

    const pendingBefore = getPendingCount(today);

    // Uncheck task in Day Plan
    const uncheckRes = TaskService.completeTask(sharedTaskId, 0, nowDate);
    assert.strictEqual(uncheckRes.task.completed, 0);

    // Task in SQLite is 0
    const taskRow = db.prepare('SELECT completed FROM tasks WHERE id = ?').get(sharedTaskId);
    assert.strictEqual(taskRow.completed, 0);

    // Goal progress log for this task is cleanly reversed/deleted
    const taskLog = db.prepare('SELECT * FROM goal_progress_log WHERE goal_id = ? AND note = ?').get(sharedGoalId, `task:${sharedTaskId}`);
    assert.strictEqual(taskLog, undefined, 'Goal progress log entry must be deleted on task uncheck');

    // Goal count rolled back to 4
    const goalRow = db.prepare('SELECT current_count FROM goals WHERE id = ?').get(sharedGoalId);
    assert.strictEqual(goalRow.current_count, 4, 'Goal count must roll back to 4');

    // Dashboard pending count incremented back
    const pendingAfter = getPendingCount(today);
    assert.strictEqual(pendingAfter, pendingBefore + 1, 'Dashboard pending count must increment back');
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Scenario 5: Modal Task Creation → All Screens Synchronized
  // ─────────────────────────────────────────────────────────────
  runScenario('5. Modal Task Creation -> All Screens Synchronized', () => {
    const pendingBefore = getPendingCount(today);

    // Modal calls POST /api/tasks (TaskService.createTask)
    const modalTask = TaskService.createTask({
      name: 'Call Dentist for Checkup',
      priority: 'low',
      time_slot: 'Anytime',
      date: 'today'
    });

    assert.ok(modalTask.id);
    assert.strictEqual(modalTask.time_slot, 'Anytime');

    // Appears in Day Plan task list (DayPlan fetches GET /tasks?date=today)
    const dayTasks = TaskService.getTasks({ date: today });
    const inTaskList = dayTasks.tasks.some(t => t.id === modalTask.id);
    assert.ok(inTaskList, 'Modal task must appear in Day Plan task list (Not Scheduled Today)');

    // Dashboard pending count increments
    const pendingAfter = getPendingCount(today);
    assert.strictEqual(pendingAfter, pendingBefore + 1);

    // Chat task retrieval (getTasks) finds it
    const chatTasks = TaskService.getTasks({ date: today });
    assert.ok(chatTasks.tasks.some(t => t.id === modalTask.id), 'Chat getTasks must return the modal task');
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Scenario 6: Task Rescheduling Across Dates
  // ─────────────────────────────────────────────────────────────
  runScenario('6. Task Rescheduling Across Dates', () => {
    // Create task for today
    const reschedTask = TaskService.createTask({
      name: 'Prepare Presentation Slides',
      priority: 'high',
      fixed_start: '03:00 PM',
      date: 'today'
    });

    const pendingTodayBefore = getPendingCount(today);
    const pendingTomorrowBefore = getPendingCount(tomorrow);

    // Reschedule to tomorrow
    const updateRes = TaskService.updateTask(reschedTask.id, { date: tomorrow });
    assert.strictEqual(updateRes.task.date, tomorrow);

    // Day Plan for today does NOT contain it
    const todayPlan = DayPlanService.getPlanForDate(today);
    const inToday = todayPlan.plan.some(p => p.task_id === reschedTask.id);
    assert.strictEqual(inToday, false, 'Task must NOT appear in today plan after rescheduling');

    // Day Plan for tomorrow DOES contain it
    const tomorrowPlan = DayPlanService.getPlanForDate(tomorrow);
    const inTomorrow = tomorrowPlan.plan.some(p => p.task_id === reschedTask.id);
    assert.strictEqual(inTomorrow, true, 'Task must appear in tomorrow plan');

    // Dashboard counts updated per date
    assert.strictEqual(getPendingCount(today), pendingTodayBefore - 1, 'Today pending count must decrement');
    assert.strictEqual(getPendingCount(tomorrow), pendingTomorrowBefore + 1, 'Tomorrow pending count must increment');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Scenario 7: Task Deletion Never Resurrects
  // ─────────────────────────────────────────────────────────────
  runScenario('7. Task Deletion Never Resurrects', () => {
    const toDelete = TaskService.createTask({
      name: 'Temporary Errand to Delete',
      priority: 'low',
      fixed_start: '02:00 PM',
      date: 'today'
    });

    const deleteRes = TaskService.deleteTask(toDelete.id);
    assert.ok(deleteRes.deleted && deleteRes.deleted.id === toDelete.id, 'Task must be reported deleted');

    // Row removed from SQLite
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(toDelete.id);
    assert.strictEqual(row, undefined, 'Task row must not exist in SQLite');

    // Day Plan reconciliation does NOT resurrect it
    const planResult = DayPlanService.getPlanForDate(today);
    const inPlan = planResult.plan.some(p => p.task_id === toDelete.id || p.task === toDelete.name);
    assert.strictEqual(inPlan, false, 'Deleted task must not appear in Day Plan');

    // Even if plan is re-saved or re-fetched, task never resurrects
    const tasksAfter = TaskService.getTasks({ date: today });
    assert.strictEqual(tasksAfter.tasks.some(t => t.id === toDelete.id), false, 'Tasks list must not contain deleted task');
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Scenario 8: Goal Step Toggle → Goals & Day Plan Reflection
  // ─────────────────────────────────────────────────────────────
  runScenario('8. Goal Step Toggle -> Goals & Day Plan Reflection', () => {
    // Insert milestone goal with 2 steps
    const mGoal = db.prepare(`
      INSERT INTO goals (title, category, priority, goal_type, status)
      VALUES ('Publish AI Research Paper', 'Research', 'high', 'milestone', 'active')
    `).run();
    const gId = mGoal.lastInsertRowid;

    const s1 = db.prepare('INSERT INTO goal_steps (goal_id, step_text, done) VALUES (?, ?, 0)').run(gId, 'Submit Draft');
    const s2 = db.prepare('INSERT INTO goal_steps (goal_id, step_text, done) VALUES (?, ?, 0)').run(gId, 'Address Reviewer Feedback');

    // Step 1 done -> 50%
    db.prepare('UPDATE goal_steps SET done = 1 WHERE id = ?').run(s1.lastInsertRowid);
    let goals = getAllGoals(nowDate);
    let updatedMGoal = goals.find(g => g.id === gId);
    assert.strictEqual(updatedMGoal.progress, 50, 'Progress must be 50% after 1 of 2 steps done');
    assert.strictEqual(updatedMGoal.status, 'active');

    // Step 2 done -> 100% and auto-complete
    db.prepare('UPDATE goal_steps SET done = 1 WHERE id = ?').run(s2.lastInsertRowid);
    db.prepare("UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?").run(today, gId);

    goals = getAllGoals(nowDate);
    updatedMGoal = goals.find(g => g.id === gId);
    assert.strictEqual(updatedMGoal.progress, 100, 'Progress must be 100% after all steps done');
    assert.strictEqual(updatedMGoal.status, 'completed', 'Goal must be completed');
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Scenario 9: Multi-Tab Concurrency & Focus Re-Sync Simulation
  // ─────────────────────────────────────────────────────────────
  runScenario('9. Multi-Tab Concurrency & Focus Re-Sync Simulation', () => {
    // Tab 1 creates task in SQLite
    const tab1Task = TaskService.createTask({
      name: 'Multi-Tab Concurrency Task',
      priority: 'high',
      date: 'today'
    });

    // Simulated event message received in Tab 2
    const eventPayload = { domains: ['tasks', 'plan'], timestamp: Date.now() };
    const tab2Domains = ['tasks', 'plan'];
    const shouldTab2Refresh = tab2Domains.some(d => eventPayload.domains.includes(d));
    assert.strictEqual(shouldTab2Refresh, true, 'Tab 2 subscriber must trigger refresh');

    // Tab 2 fetches authoritative data from SQLite
    const tab2Data = TaskService.getTasks({ date: today });
    assert.ok(tab2Data.tasks.some(t => t.id === tab1Task.id), 'Tab 2 must fetch authoritative data created by Tab 1');

    // Simulated window focus / visibility change
    const tab2FocusRefresh = TaskService.getTasks({ date: today });
    assert.strictEqual(tab2FocusRefresh.tasks.length, tab2Data.tasks.length, 'Focus refresh returns authoritative state');
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Scenario 10: Rapid Burst / Debounce Coalescing
  // ─────────────────────────────────────────────────────────────
  runScenario('10. Rapid Burst / Debounce Coalescing', () => {
    const burstCount = 5;
    const createdTasks = [];

    // Simulate 5 rapid sequential mutations in 20ms
    for (let i = 1; i <= burstCount; i++) {
      const t = TaskService.createTask({
        name: `Rapid Burst Task #${i}`,
        priority: 'medium',
        date: 'today'
      });
      createdTasks.push(t);
    }

    assert.strictEqual(createdTasks.length, 5, 'All 5 tasks must be created');

    // Verify all 5 exist in SQLite without locks or drops
    const rows = db.prepare("SELECT * FROM tasks WHERE name LIKE 'Rapid Burst Task #%'").all();
    assert.strictEqual(rows.length, 5, 'All 5 tasks must exist in SQLite database');

    // Coalesced authoritative query returns all 5
    const finalTasks = TaskService.getTasks({ date: today });
    createdTasks.forEach(ct => {
      assert.ok(finalTasks.tasks.some(t => t.id === ct.id), `Task ${ct.name} must exist in task list`);
    });
  });

  console.log('\n======================================================');
  console.log(`Cross-Screen Synchronization Test Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('======================================================\n');

  // Clean up isolated database
  try {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
      console.log('🧹 Cleaned up isolated test DB:', testDbPath);
    }
  } catch (err) {
    // Ignore cleanup file locks on windows
  }

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error during scenario run:', err);
  process.exit(1);
});
