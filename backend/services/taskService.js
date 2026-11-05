/**
 * backend/services/taskService.js
 *
 * Centralized, authoritative service for all task mutations and queries in SEVA.
 *
 * Invariants Enforced:
 * 1. Single Source of Truth: All mutations modify the `tasks` SQLite table atomically.
 * 2. Atomic Day Plan Synchronization: Day plan entries are synchronized inside the same transaction.
 * 3. Atomic Goal Progress Consistency: Task completion and corresponding goal log updates are atomic.
 * 4. Idempotency: Re-completing an already completed task produces no duplicate logs or increments.
 * 5. Historical Goal Protection: Deleting a task NEVER deletes historical progress records in `goal_progress_log`.
 * 6. Explicit Dates & Backlog: Tasks without a specified date are stored with date = NULL (Backlog).
 *    Never defaulted to today's date.
 */

const defaultDb = require('../database/db');
const { getTodayDate, getTomorrowDate, parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');
const DayPlanService = require('./dayPlanService');

const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];

/**
 * Normalizes input date:
 * - "today" -> local today's date YYYY-MM-DD
 * - "tomorrow" -> local tomorrow's date YYYY-MM-DD
 * - valid YYYY-MM-DD -> returns as-is
 * - null, undefined, '', 'unscheduled' -> returns null (backlog)
 */
function normalizeTaskDate(dateInput) {
  if (!dateInput) return null;
  const str = String(dateInput).trim().toLowerCase();
  if (str === 'today') return getTodayDate();
  if (str === 'tomorrow') return getTomorrowDate();
  if (str === 'unscheduled' || str === 'backlog') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

/**
 * Creates a new task atomically.
 */
function createTask(data, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;

  const rawName = (data && data.name) || '';
  const name = String(rawName).trim();
  if (!name) {
    throw new Error('Task name is required and must be non-empty.');
  }
  if (name.length > 300) {
    throw new Error(`Task name too long (${name.length} chars). Maximum allowed is 300.`);
  }

  const rawPriority = (data && data.priority && String(data.priority).toLowerCase().trim()) || 'medium';
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';

  const date = normalizeTaskDate(data && data.date);

  const durationMin = data && data.duration_min != null && !isNaN(parseInt(data.duration_min, 10))
    ? Math.max(5, Math.min(480, parseInt(data.duration_min, 10)))
    : 30;

  const dueDate = data && data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(data.due_date).trim())
    ? String(data.due_date).trim()
    : null;

  // Fixed start & end time normalization
  let fixedStart = null;
  let fixedEnd = null;
  let timeSlot = null;

  if (data && data.fixed_start && String(data.fixed_start).trim()) {
    const sMins = parseTimeToMinutes(String(data.fixed_start));
    if (sMins !== null) {
      fixedStart = minutesToTimeString(sMins);
      if (data.fixed_end && parseTimeToMinutes(String(data.fixed_end)) !== null) {
        fixedEnd = minutesToTimeString(parseTimeToMinutes(String(data.fixed_end)));
      } else {
        fixedEnd = minutesToTimeString(sMins + durationMin);
      }
      timeSlot = fixedStart;
    }
  } else if (data && data.time_slot && String(data.time_slot).trim()) {
    const sMins = parseTimeToMinutes(String(data.time_slot));
    if (sMins !== null) {
      fixedStart = minutesToTimeString(sMins);
      fixedEnd = minutesToTimeString(sMins + durationMin);
      timeSlot = fixedStart;
    } else {
      timeSlot = String(data.time_slot).trim();
    }
  } else {
    timeSlot = 'Anytime';
  }

  const source = (data && data.source && String(data.source).trim()) || 'manual';
  const goalId = (data && data.goal_id != null && !isNaN(parseInt(data.goal_id, 10)))
    ? parseInt(data.goal_id, 10)
    : null;
  const isUrgent = (data && data.is_urgent) ? 1 : 0;
  const carryForward = (data && data.carry_forward) ? 1 : 0;

  const tx = activeDb.transaction(() => {
    const info = activeDb.prepare(`
      INSERT INTO tasks (
        name, priority, time_slot, source, completed, date, carry_forward,
        goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
      )
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, priority, timeSlot, source, date, carryForward,
      goalId, dueDate, fixedStart, fixedEnd, durationMin, isUrgent
    );

    const createdTask = activeDb.prepare(`
      SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
             goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
      FROM tasks
      WHERE id = ?
    `).get(info.lastInsertRowid);

    // Atomically synchronize fixed tasks to day plan if date and fixed_start are set
    if (createdTask.date && createdTask.fixed_start) {
      DayPlanService.syncFixedTaskToPlanTransaction(createdTask, 'INSERT', activeDb);
    }

    return createdTask;
  });

  return tx();
}

/**
 * Marks a task as completed (or incomplete) atomically.
 * Safeguard 1: Task completion and associated goal progress updates are strictly atomic.
 * Idempotency: Duplicate calls produce no duplicate logs or increments.
 */
function completeTask(taskId, requestedStatus = 1, nowDate = new Date(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(taskId, 10);
  if (isNaN(id)) throw new Error('Invalid task ID.');

  const task = activeDb.prepare(`
    SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
           goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
    FROM tasks
    WHERE id = ?
  `).get(id);

  if (!task) {
    return { success: false, notFound: true, error: `No task found with id ${id}` };
  }

  const willBeCompleted = Number(requestedStatus) === 1 ? 1 : 0;
  const wasCompleted = Number(task.completed) === 1 ? 1 : 0;

  // Idempotency guard: if already in requested state, do not double-log or double-reverse
  if (wasCompleted === willBeCompleted) {
    return {
      success: true,
      unchanged: true,
      message: `Task ${id} is already ${willBeCompleted ? 'completed' : 'incomplete'}.`,
      task
    };
  }

  const todayStr = getTodayDate(nowDate);
  const effectiveDate = (willBeCompleted && task.date && task.date < todayStr) ? todayStr : task.date;

  const tx = activeDb.transaction(() => {
    // 1. Update task row
    activeDb.prepare(`
      UPDATE tasks
      SET completed = ?, date = ?
      WHERE id = ?
    `).run(willBeCompleted, effectiveDate, id);

    let progressAction = null;

    // 2. Goal progress consistency (Safeguard 2: removed or paused goals are never silently updated)
    if (task.goal_id != null) {
      const goal = activeDb.prepare(`
        SELECT id, goal_type, target_count, current_count, status, completed_date, is_paused
        FROM goals
        WHERE id = ?
      `).get(task.goal_id);

      if (goal && goal.status === 'active' && (goal.is_paused === 0 || goal.is_paused == null)) {
        const logDate = effectiveDate || todayStr;

        if (willBeCompleted === 1) {
          // Marking COMPLETED
          if (goal.goal_type === 'count') {
            const target = goal.target_count || 1;
            const current = goal.current_count || 0;
            const added = Math.max(0, Math.min(1, target - current));
            const newCount = current + added;
            const reachedTarget = newCount >= target;

            activeDb.prepare(`
              UPDATE goals
              SET current_count = ?, status = ?, completed_date = ?
              WHERE id = ?
            `).run(newCount, reachedTarget ? 'completed' : goal.status, reachedTarget ? logDate : goal.completed_date, goal.id);

            activeDb.prepare(`
              INSERT INTO goal_progress_log (goal_id, date, amount, note)
              VALUES (?, ?, ?, ?)
            `).run(goal.id, logDate, added, `task:${id}`);

            progressAction = { type: 'count_increment', added, current_count: newCount, target_count: target };
          } else if (goal.goal_type === 'frequency') {
            const sameDayLog = activeDb.prepare(`
              SELECT 1 FROM goal_progress_log WHERE goal_id = ? AND date = ? GROUP BY date HAVING SUM(amount) > 0 LIMIT 1
            `).get(goal.id, logDate);

            if (!sameDayLog) {
              activeDb.prepare(`
                INSERT INTO goal_progress_log (goal_id, date, amount, note)
                VALUES (?, ?, 1, ?)
              `).run(goal.id, logDate, `task:${id}`);
              progressAction = { type: 'frequency_logged', date: logDate };
            } else {
              progressAction = { type: 'frequency_already_logged_today', date: logDate };
            }
          } else {
            // milestone goal
            const steps = activeDb.prepare(`
              SELECT id, step_text, done FROM goal_steps WHERE goal_id = ? ORDER BY id ASC
            `).all(goal.id);

            const isShorterThanFullUnit = task.duration_min != null && Number(task.duration_min) < 60;
            if (steps.length === 0 || isShorterThanFullUnit) {
              activeDb.prepare(`
                INSERT INTO goal_progress_log (goal_id, date, amount, note)
                VALUES (?, ?, 1, ?)
              `).run(goal.id, logDate, `worked:task:${id}`);
              progressAction = { type: 'stepless_worked', note: 'worked' };
            } else {
              const nextStep = steps.find(s => Number(s.done) === 0);
              if (nextStep) {
                activeDb.prepare(`UPDATE goal_steps SET done = 1 WHERE id = ?`).run(nextStep.id);
                activeDb.prepare(`
                  INSERT INTO goal_progress_log (goal_id, date, amount, note)
                  VALUES (?, ?, 1, ?)
                `).run(goal.id, logDate, `task:${id}:step:${nextStep.id}`);
                const allDone = steps.every(s => s.id === nextStep.id || Number(s.done) === 1);
                if (allDone) {
                  activeDb.prepare(`UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?`).run(logDate, goal.id);
                }
                progressAction = { type: 'milestone_step_done', step_id: nextStep.id };
              }
            }
          }
        } else {
          // UNCHECKING (reversing ONLY the entry associated with this task)
          if (goal.goal_type === 'count') {
            const taskLog = activeDb.prepare(`
              SELECT id, amount FROM goal_progress_log
              WHERE goal_id = ? AND (note = ? OR note LIKE ? OR note = ?)
              ORDER BY id DESC LIMIT 1
            `).get(goal.id, `task:${id}`, `task:${id}:%`, `worked:task:${id}`);

            if (taskLog) {
              const current = goal.current_count || 0;
              const newCount = Math.max(0, current - (taskLog.amount || 1));
              activeDb.prepare(`
                UPDATE goals
                SET current_count = ?, status = 'active', completed_date = NULL
                WHERE id = ?
              `).run(newCount, goal.id);
              activeDb.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(taskLog.id);
              progressAction = { type: 'count_decremented', removed: taskLog.amount, current_count: newCount };
            }
          } else if (goal.goal_type === 'frequency') {
            const taskLog = activeDb.prepare(`
              SELECT id FROM goal_progress_log
              WHERE goal_id = ? AND (note = ? OR note LIKE ? OR note = ?)
              ORDER BY id DESC LIMIT 1
            `).get(goal.id, `task:${id}`, `task:${id}:%`, `worked:task:${id}`);

            if (taskLog) {
              activeDb.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(taskLog.id);
              progressAction = { type: 'frequency_log_removed' };
            }
          } else {
            // milestone goal
            const stepLog = activeDb.prepare(`
              SELECT id, note FROM goal_progress_log
              WHERE goal_id = ? AND (note LIKE ? OR note = ? OR note = ?)
              ORDER BY id DESC LIMIT 1
            `).get(goal.id, `task:${id}:step:%`, `task:${id}`, `worked:task:${id}`);

            if (stepLog) {
              if (stepLog.note && stepLog.note.includes(':step:')) {
                const stepId = parseInt(stepLog.note.split(':step:')[1], 10);
                if (!isNaN(stepId)) {
                  activeDb.prepare(`UPDATE goal_steps SET done = 0 WHERE id = ? AND goal_id = ?`).run(stepId, goal.id);
                }
                progressAction = { type: 'milestone_step_unticked', step_id: stepId };
              } else {
                progressAction = { type: 'milestone_worked_reversed' };
              }
              activeDb.prepare(`DELETE FROM goal_progress_log WHERE id = ?`).run(stepLog.id);
              if (goal.status === 'completed') {
                activeDb.prepare(`UPDATE goals SET status = 'active', completed_date = NULL WHERE id = ?`).run(goal.id);
              }
            }
          }
        }
      }
    }

    // 3. Atomically sync Day Plan
    const updatedTask = activeDb.prepare(`
      SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
             goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
      FROM tasks
      WHERE id = ?
    `).get(id);

    if (updatedTask && updatedTask.date) {
      DayPlanService.syncFixedTaskToPlanTransaction(updatedTask, 'COMPLETE', activeDb);
    }

    return {
      success: true,
      message: `Task ${id} marked as ${willBeCompleted ? 'completed' : 'incomplete'}.`,
      task: updatedTask,
      progress_action: progressAction
    };
  });

  return tx();
}

/**
 * Updates a task's fields atomically and synchronizes Day Plan when dates or times shift.
 */
function updateTask(taskId, updates = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(taskId, 10);
  if (isNaN(id)) throw new Error('Invalid task ID.');

  const existing = activeDb.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!existing) {
    return { success: false, notFound: true, error: `No task found with id ${id}` };
  }

  const tx = activeDb.transaction(() => {
    const newName = updates.name !== undefined ? String(updates.name).trim() : existing.name;
    const newPriority = updates.priority !== undefined && ALLOWED_PRIORITIES.includes(String(updates.priority).toLowerCase())
      ? String(updates.priority).toLowerCase()
      : existing.priority;

    let newDate = existing.date;
    if (updates.date !== undefined) {
      newDate = normalizeTaskDate(updates.date);
    }

    const newDuration = updates.duration_min !== undefined && !isNaN(parseInt(updates.duration_min, 10))
      ? Math.max(5, Math.min(480, parseInt(updates.duration_min, 10)))
      : existing.duration_min;

    let newFixedStart = existing.fixed_start;
    let newFixedEnd = existing.fixed_end;
    let newTimeSlot = existing.time_slot;

    if (updates.fixed_start !== undefined) {
      if (updates.fixed_start && parseTimeToMinutes(String(updates.fixed_start)) !== null) {
        newFixedStart = minutesToTimeString(parseTimeToMinutes(String(updates.fixed_start)));
        newTimeSlot = newFixedStart;
      } else {
        newFixedStart = null;
      }
    }

    if (updates.time_slot !== undefined) {
      newTimeSlot = updates.time_slot ? String(updates.time_slot).trim() : 'Anytime';
      const sMins = parseTimeToMinutes(newTimeSlot);
      if (sMins !== null) {
        newFixedStart = minutesToTimeString(sMins);
      }
    }

    activeDb.prepare(`
      UPDATE tasks
      SET name = ?, priority = ?, date = ?, duration_min = ?,
          fixed_start = ?, fixed_end = ?, time_slot = ?
      WHERE id = ?
    `).run(newName, newPriority, newDate, newDuration, newFixedStart, newFixedEnd, newTimeSlot, id);

    const updatedTask = activeDb.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);

    // If date changed, remove from old plan and sync to new plan
    if (existing.date && existing.date !== newDate) {
      DayPlanService.removeTaskFromPlanTransaction(id, existing.date, activeDb);
    }
    if (updatedTask.date && updatedTask.fixed_start) {
      DayPlanService.syncFixedTaskToPlanTransaction(updatedTask, 'UPDATE', activeDb);
    }

    return { success: true, task: updatedTask };
  });

  return tx();
}

/**
 * Permanently deletes a task row.
 * Safeguard 1 & 3: Historical goal records in goal_progress_log are permanently PRESERVED.
 */
function deleteTask(taskId, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(taskId, 10);
  if (isNaN(id)) throw new Error('Invalid task ID.');

  const task = activeDb.prepare(`SELECT id, name, date FROM tasks WHERE id = ?`).get(id);
  if (!task) {
    return { success: false, notFound: true, error: `No task found with id ${id}` };
  }

  const tx = activeDb.transaction(() => {
    // 1. Delete from tasks table (hard delete)
    activeDb.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);

    // 2. Atomically remove from Day Plan
    if (task.date) {
      DayPlanService.removeTaskFromPlanTransaction(id, task.date, activeDb);
    }

    // Notice: goal_progress_log is intentionally NOT deleted to preserve historical progress
    return {
      success: true,
      message: `Task ${id} deleted.`,
      deleted: { id: task.id, name: task.name, date: task.date }
    };
  });

  return tx();
}

/**
 * Reschedules a task to a target date and optional time.
 */
function rescheduleTask(taskId, targetDate, targetTime = null, dbOverride = null) {
  return updateTask(taskId, {
    date: targetDate,
    ...(targetTime ? { time_slot: targetTime, fixed_start: targetTime } : {})
  }, dbOverride);
}

/**
 * Retrieves tasks with optional filtering:
 * - view='backlog': tasks where date IS NULL
 * - date='YYYY-MM-DD': tasks scheduled for specific date
 * - default: tasks scheduled for today
 */
function getTasks(options = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const { date, view } = options;

  if (view === 'backlog') {
    const backlogTasks = activeDb.prepare(`
      SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
             goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
      FROM tasks
      WHERE date IS NULL OR date = 'unscheduled'
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        id ASC
    `).all();

    return {
      success: true,
      view: 'backlog',
      count: backlogTasks.length,
      tasks: backlogTasks
    };
  }

  const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : (date === 'today' || !date ? getTodayDate() : null);

  if (!targetDate) {
    throw new Error('Invalid date filter. Expected YYYY-MM-DD or "today".');
  }

  const tasks = activeDb.prepare(`
    SELECT id, name, priority, time_slot, source, completed, date, carry_forward,
           goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
    FROM tasks
    WHERE date = ?
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id ASC
  `).all(targetDate);

  const backlogCountRow = activeDb.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE date IS NULL OR date = 'unscheduled'
  `).get();

  return {
    success: true,
    date: targetDate,
    count: tasks.length,
    backlog_count: backlogCountRow ? backlogCountRow.count : 0,
    tasks
  };
}

module.exports = {
  createTask,
  completeTask,
  updateTask,
  deleteTask,
  rescheduleTask,
  getTasks,
  normalizeTaskDate
};

