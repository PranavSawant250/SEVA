/**
 * backend/services/dayPlanService.js
 *
 * Dedicated service for Day Plan management and synchronization.
 *
 * Responsibilities:
 * 1. Read Reconciliation (reconcilePlanWithTasks): Synchronizes live task states
 *    (name, priority, completion, deletion) without mutating DB or injecting Anytime tasks.
 * 2. Transactional Plan Synchronization (syncFixedTaskToPlanTransaction, removeTaskFromPlanTransaction):
 *    Updates plan_json atomically within the caller's SQLite transaction.
 */

const defaultDb = require('../database/db');
const { getTodayDate, parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');

/**
 * Reconciles a plan array against live tasks for the given date.
 * Pure in-memory projection: does NOT mutate DB and does NOT append unplaced flexible tasks.
 */
function reconcilePlanWithTasks(planArray, tasksForDate) {
  if (!Array.isArray(planArray)) return [];

  const taskMap = new Map();
  const nameMap = new Map();
  for (const t of tasksForDate) {
    taskMap.set(t.id, t);
    if (t.name) {
      nameMap.set(t.name.trim().toLowerCase(), t);
    }
  }

  const reconciled = [];
  for (const item of planArray) {
    if (!item) continue;
    let liveTask = null;
    if (item.task_id != null) {
      liveTask = taskMap.get(item.task_id);
      if (!liveTask) {
        // Task was explicitly deleted from tasks table — drop stale plan item
        continue;
      }
    } else if (item.task && item.source !== 'fixed' && item.kind !== 'class') {
      liveTask = nameMap.get(item.task.trim().toLowerCase());
    }

    if (liveTask) {
      const sMins = liveTask.fixed_start ? parseTimeToMinutes(liveTask.fixed_start) : null;
      const timeDisplay = sMins !== null ? minutesToTimeString(sMins) : item.time;
      reconciled.push({
        ...item,
        task_id: liveTask.id,
        task: liveTask.name || item.task,
        priority: liveTask.priority || item.priority,
        completed: liveTask.completed != null ? liveTask.completed : item.completed,
        time: timeDisplay,
        duration: liveTask.duration_min != null ? liveTask.duration_min : item.duration
      });
    } else {
      // Non-task blocks (e.g. timetable classes) are preserved
      reconciled.push({ ...item });
    }
  }

  // Sort reconciled plan chronologically by time
  reconciled.sort((a, b) => {
    const aMins = parseTimeToMinutes(a.time) ?? 9999;
    const bMins = parseTimeToMinutes(b.time) ?? 9999;
    return aMins - bMins;
  });

  return reconciled;
}

/**
 * Fetches and reconciles the day plan for a specific date.
 * Read-only operation — never mutates DB or triggers unintended regeneration.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {object} [dbOverride] - Optional test DB instance
 */
function getPlanForDate(dateStr, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? dateStr
    : getTodayDate();

  const planRow = activeDb.prepare(`
    SELECT id, date, plan_json, generated_at, completed_count, missed_count
    FROM day_plans
    WHERE date = ?
  `).get(targetDate);

  if (!planRow || !planRow.plan_json) {
    return {
      success: true,
      exists: false,
      date: targetDate,
      count: 0,
      plan: [],
      message: `No plan generated yet for ${targetDate}.`
    };
  }

  let rawPlan;
  try {
    rawPlan = JSON.parse(planRow.plan_json);
  } catch (err) {
    throw new Error(`Failed to parse plan_json for date ${targetDate}: ${err.message}`);
  }

  // Fetch live tasks for targetDate to reconcile
  const liveTasks = activeDb.prepare(`
    SELECT id, name, priority, completed, time_slot, fixed_start, duration_min
    FROM tasks
    WHERE date = ?
  `).all(targetDate);

  const reconciledPlan = reconcilePlanWithTasks(rawPlan, liveTasks);

  return {
    success: true,
    exists: true,
    date: planRow.date,
    generated_at: planRow.generated_at,
    completed_count: planRow.completed_count,
    missed_count: planRow.missed_count,
    count: reconciledPlan.length,
    plan: reconciledPlan
  };
}

/**
 * Synchronizes fixed tasks into day_plans.plan_json within caller's atomic transaction.
 * Flexible tasks (fixed_start == null) are NOT appended to timed timelines.
 *
 * @param {object} task - Task row object
 * @param {string} action - 'INSERT' | 'UPDATE' | 'COMPLETE' | 'DELETE'
 * @param {object} [dbOverride] - Optional test DB instance
 */
function syncFixedTaskToPlanTransaction(task, action, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  if (!task || !task.date) return;

  const planRow = activeDb.prepare(`
    SELECT id, plan_json
    FROM day_plans
    WHERE date = ?
  `).get(task.date);

  if (!planRow || !planRow.plan_json) {
    // If no day plan exists yet for this date, the scheduler will pick up this task when generated
    return;
  }

  let plan;
  try {
    plan = JSON.parse(planRow.plan_json);
  } catch (_) {
    return;
  }

  if (!Array.isArray(plan)) return;

  if (action === 'DELETE') {
    const filtered = plan.filter(item => item && item.task_id !== task.id);
    activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
      .run(JSON.stringify(filtered), task.date);
    return;
  }

  const existingIndex = plan.findIndex(item => 
    item && (
      (item.task_id != null && item.task_id === task.id) ||
      (item.task_id == null && item.task && task.name && item.task.trim().toLowerCase() === task.name.trim().toLowerCase())
    )
  );

  if (action === 'COMPLETE') {
    if (existingIndex !== -1) {
      plan[existingIndex].completed = task.completed ? 1 : 0;
      activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
        .run(JSON.stringify(plan), task.date);
    }
    return;
  }

  const hasFixedStart = Boolean(task.fixed_start && String(task.fixed_start).trim());

  if (hasFixedStart) {
    const sMins = parseTimeToMinutes(task.fixed_start);
    const timeDisplay = sMins !== null ? minutesToTimeString(sMins) : String(task.fixed_start).trim();
    const duration = task.duration_min ? Number(task.duration_min) : 60;

    const block = {
      time: timeDisplay,
      task: task.name,
      priority: task.priority || 'medium',
      duration,
      source: task.source || 'manual',
      task_id: task.id,
      goal_id: task.goal_id || null,
      completed: task.completed ? 1 : 0
    };

    if (existingIndex !== -1) {
      // Update in place without creating duplicates
      plan[existingIndex] = { ...plan[existingIndex], ...block };
    } else {
      plan.push(block);
    }

    // Keep plan sorted chronologically by time
    plan.sort((a, b) => {
      const aMins = parseTimeToMinutes(a.time) ?? 9999;
      const bMins = parseTimeToMinutes(b.time) ?? 9999;
      return aMins - bMins;
    });

    activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
      .run(JSON.stringify(plan), task.date);
  } else if (existingIndex !== -1) {
    // If a previously fixed task was made flexible, remove it from the timed timeline
    const filtered = plan.filter(item => item && item.task_id !== task.id);
    activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
      .run(JSON.stringify(filtered), task.date);
  }
}

/**
 * Removes a task from day_plans.plan_json within caller's atomic transaction.
 */
function removeTaskFromPlanTransaction(taskId, dateStr, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  if (!taskId || !dateStr) return;

  const planRow = activeDb.prepare(`
    SELECT id, plan_json
    FROM day_plans
    WHERE date = ?
  `).get(dateStr);

  if (!planRow || !planRow.plan_json) return;

  try {
    const plan = JSON.parse(planRow.plan_json);
    if (Array.isArray(plan)) {
      const filtered = plan.filter(item => item && item.task_id !== taskId);
      activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
        .run(JSON.stringify(filtered), dateStr);
    }
  } catch (_) {}
}

/**
 * Removes timetable class block(s) from day_plans.plan_json for a date.
 * If subjectFilter is null, removes all timetable classes (e.g. for "cancel all classes today").
 * If subjectFilter is given, removes only matching class(es).
 */
function removeTimetableBlockFromPlan(dateStr, subjectFilter = null, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  if (!dateStr) return;

  const planRow = activeDb.prepare(`
    SELECT id, plan_json
    FROM day_plans
    WHERE date = ?
  `).get(dateStr);

  if (!planRow || !planRow.plan_json) return;

  try {
    const plan = JSON.parse(planRow.plan_json);
    if (!Array.isArray(plan)) return;

    let filtered = plan;
    if (!subjectFilter) {
      filtered = plan.filter(item => !(item && (item.kind === 'class' || item.source === 'fixed' && !item.task_id)));
    } else {
      const q = String(subjectFilter).trim().toLowerCase();
      filtered = plan.filter(item => {
        if (!item) return false;
        const isClass = item.kind === 'class' || (item.source === 'fixed' && !item.task_id);
        if (isClass && item.task && item.task.toLowerCase().includes(q)) {
          return false; // remove
        }
        return true;
      });
    }

    activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
      .run(JSON.stringify(filtered), dateStr);
  } catch (_) {}
}

/**
 * Adds an extra timetable block into day_plans.plan_json for a date,
 * keeping chronological time order.
 */
function addTimetableBlockToPlan(dateStr, classBlock, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  if (!dateStr || !classBlock) return;

  const planRow = activeDb.prepare(`
    SELECT id, plan_json
    FROM day_plans
    WHERE date = ?
  `).get(dateStr);

  if (!planRow || !planRow.plan_json) return;

  try {
    const plan = JSON.parse(planRow.plan_json);
    if (!Array.isArray(plan)) return;

    // Check if duplicate already exists
    const exists = plan.some(item =>
      item && item.task === classBlock.task && item.time === classBlock.time
    );
    if (!exists) {
      plan.push(classBlock);
      plan.sort((a, b) => {
        const aMins = parseTimeToMinutes(a.time) ?? 9999;
        const bMins = parseTimeToMinutes(b.time) ?? 9999;
        return aMins - bMins;
      });

      activeDb.prepare(`UPDATE day_plans SET plan_json = ? WHERE date = ?`)
        .run(JSON.stringify(plan), dateStr);
    }
  } catch (_) {}
}

module.exports = {
  reconcilePlanWithTasks,
  getPlanForDate,
  syncFixedTaskToPlanTransaction,
  removeTaskFromPlanTransaction,
  removeTimetableBlockFromPlan,
  addTimetableBlockToPlan
};

