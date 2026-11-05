/**
 * backend/services/goalsService.js
 *
 * Core logic for goal import, CRUD, step management, progress computation,
 * compensating corrections, lifecycle status transitions, and goal queries.
 *
 * Takes an optional injected `dbOverride` and `todayDateObj` so tests can simulate other days/databases.
 * No AI calls — all parsing, validation, and computation is deterministic code.
 */

const defaultDb = require('../database/db');
const DayPlanService = require('./dayPlanService');
const {
  getTodayDate,
  getWeekMondayDate,
  getWeekSundayDate,
  daysBetween,
  addDaysToDate,
  computeDaysSinceActivity
} = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// REGEX CONSTANTS (documented assumptions)
// ─────────────────────────────────────────────────────────────

const RE_PER_WEEK = /(\d+)\s*days?\s*(?:per\s*week|\/week)|(\d+)\/week/i;
const RE_TARGET_COUNT = /(\d+)\s*(?:problems?|questions?|pages?|chapters?|units?|km|kms?|hours?|hrs?|sessions?)/i;
const RE_TRAILING_DONE = /\s*\b(done|complete|completed|connected)\s*$/i;

// ─────────────────────────────────────────────────────────────
// STEP INFERENCE
// Splits target_text into steps for milestone goals.
// ─────────────────────────────────────────────────────────────
function inferSteps(targetText) {
  if (!targetText || typeof targetText !== 'string') return [];
  const parts = targetText.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return [];

  // Strip trailing completion word from last item only
  parts[parts.length - 1] = parts[parts.length - 1].replace(RE_TRAILING_DONE, '').trim();
  return parts.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// GOAL TYPE INFERENCE (pure code, no AI)
// ─────────────────────────────────────────────────────────────
function inferGoalType(goal) {
  if (goal.per_week !== undefined && goal.per_week !== null) {
    return { type: 'frequency', per_week: Number(goal.per_week), target_count: null };
  }
  if (goal.target_count !== undefined && goal.target_count !== null) {
    return { type: 'count', per_week: null, target_count: Number(goal.target_count) };
  }

  const target = goal.target || goal.target_text || '';

  const mWeek = target.match(RE_PER_WEEK);
  if (mWeek) {
    const n = parseInt(mWeek[1] || mWeek[2], 10);
    if (!isNaN(n) && n >= 1 && n <= 7) return { type: 'frequency', per_week: n, target_count: null };
  }

  const mCount = target.match(RE_TARGET_COUNT);
  if (mCount) {
    const n = parseInt(mCount[1], 10);
    if (!isNaN(n) && n > 0) return { type: 'count', per_week: null, target_count: n };
  }

  return { type: 'milestone', per_week: null, target_count: null };
}

// ─────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];

function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function validateGoalEntry(goal, index) {
  const errors = [];
  if (!goal.title || typeof goal.title !== 'string' || !goal.title.trim()) {
    errors.push(`index ${index}: title is required`);
  } else if (goal.title.trim().length > 200) {
    errors.push(`index ${index}: title too long (max 200 chars)`);
  }
  if (!goal.category || typeof goal.category !== 'string' || !goal.category.trim()) {
    errors.push(`index ${index}: category is required`);
  }
  if (!goal.deadline || !isValidDate(goal.deadline)) {
    errors.push(`index ${index}: deadline must be YYYY-MM-DD`);
  }
  const priority = (goal.priority || '').toLowerCase().trim();
  if (!ALLOWED_PRIORITIES.includes(priority)) {
    errors.push(`index ${index}: priority must be high/medium/low`);
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────
// SERVICE ERROR FACTORY
// ─────────────────────────────────────────────────────────────
function createServiceError(statusCode, message, details = undefined) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = message;
  if (details) err.details = details;
  return err;
}

// ─────────────────────────────────────────────────────────────
// IMPORT GOALS (Bulk import from JSON)
// ─────────────────────────────────────────────────────────────
function importGoals(payload, todayDate, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  if (!payload || !Array.isArray(payload.goals) || payload.goals.length === 0) {
    throw createServiceError(400, '"goals" must be a non-empty array' );
  }
  if (payload.goals.length > 30) {
    throw createServiceError(400, 'Maximum 30 goals per import' );
  }

  const allErrors = [];
  payload.goals.forEach((g, i) => {
    allErrors.push(...validateGoalEntry(g, i));
  });
  if (allErrors.length > 0) {
    throw createServiceError(400, 'Validation failed', allErrors );
  }

  const month = payload.month || null;
  let created = 0;
  let updated = 0;
  const overdue = [];

  const importTx = activeDb.transaction(() => {
    for (const rawGoal of payload.goals) {
      const title = rawGoal.title.trim();
      const category = rawGoal.category.trim();
      const deadline = rawGoal.deadline;
      const priority = rawGoal.priority.toLowerCase().trim();
      const targetText = (rawGoal.target || rawGoal.target_text || '').trim();

      const inferred = inferGoalType(rawGoal);

      if (daysBetween(deadline, todayDate) > 0) {
        overdue.push(title);
      }

      const existing = activeDb.prepare(
        "SELECT id FROM goals WHERE LOWER(title) = LOWER(?) AND status = 'active'"
      ).get(title);

      if (existing) {
        activeDb.prepare(`
          UPDATE goals SET deadline=?, priority=?, target_text=?, month=?
          WHERE id=?
        `).run(deadline, priority, targetText, month, existing.id);
        updated++;
      } else {
        const result = activeDb.prepare(`
          INSERT INTO goals (month, category, title, target_text, deadline, priority,
            goal_type, target_count, current_count, per_week, status, is_paused, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', 0, ?)
        `).run(month, category, title, targetText, deadline, priority,
            inferred.type, inferred.target_count, inferred.per_week, todayDate);

        const newId = result.lastInsertRowid;

        if (inferred.type === 'milestone') {
          const steps = inferSteps(targetText);
          for (const stepText of steps) {
            activeDb.prepare('INSERT INTO goal_steps (goal_id, step_text, done, is_deleted) VALUES (?, ?, 0, 0)')
              .run(newId, stepText);
          }
        }
        created++;
      }
    }
  });

  importTx();
  return { created, updated, overdue, month };
}

// ─────────────────────────────────────────────────────────────
// COMPUTE GOAL PROGRESS
// ─────────────────────────────────────────────────────────────
function computeGoalProgress(goal, todayDateStr, todayDateObj, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;

  // Last activity date via positive net amounts
  const lastLog = activeDb.prepare(`
    SELECT date FROM goal_progress_log 
    WHERE goal_id = ? AND date <= ? 
    GROUP BY date 
    HAVING SUM(amount) > 0 
    ORDER BY date DESC LIMIT 1
  `).get(goal.id, todayDateStr);

  const lastActivityDate = lastLog ? lastLog.date : goal.created_date;
  const daysSinceActivity = computeDaysSinceActivity(
    { last_log_date: lastLog ? lastLog.date : null, created_date: goal.created_date },
    todayDateStr
  );
  const lastLoggedToday = Boolean(
    activeDb.prepare(`
      SELECT 1 FROM goal_progress_log 
      WHERE goal_id = ? AND date = ? 
      GROUP BY date 
      HAVING SUM(amount) > 0 
      LIMIT 1
    `).get(goal.id, todayDateStr)
  );

  const isOverdue = goal.deadline ? daysBetween(goal.deadline, todayDateStr) > 0 : false;
  const daysLeft = goal.deadline
    ? Math.max(0, daysBetween(todayDateStr, goal.deadline))
    : null;

  let expectedProgress = 0;
  if (goal.deadline && daysBetween(todayDateStr, goal.deadline) <= 0) {
    expectedProgress = 100;
  } else if (goal.deadline) {
    const monthStart = `${goal.deadline.slice(0, 7)}-01`;
    const paceStart = (
      goal.created_date &&
      daysBetween(goal.created_date, goal.deadline) > 0 &&
      daysBetween(goal.created_date, todayDateStr) >= 0
    )
      ? goal.created_date
      : monthStart;
    const totalDays = daysBetween(paceStart, goal.deadline);
    const elapsedDays = daysBetween(paceStart, todayDateStr);
    if (totalDays > 0) {
      expectedProgress = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));
    }
  }

  // 1. Paused Goal Semantics: suppress behind-by and pace alerts
  if (goal.is_paused === 1) {
    let progress = 0;
    if (goal.goal_type === 'count' && goal.target_count) {
      progress = Math.min(100, Math.round(((goal.current_count || 0) / goal.target_count) * 100));
    }
    return {
      progress,
      progress_source: 'paused',
      days_left: daysLeft,
      expected_progress: expectedProgress,
      behind_by: 0,
      is_overdue: false, // Paused goals do not trigger overdue alerts
      is_paused: true,
      paused_at: goal.paused_at,
      total_paused_days: goal.total_paused_days || 0,
      last_activity_date: lastActivityDate,
      days_since_activity: daysSinceActivity,
      last_logged_today: lastLoggedToday
    };
  }

  // 2. Completed goals are always 100%
  if (goal.status === 'completed') {
    return {
      progress: 100,
      progress_source: 'completed',
      days_left: daysLeft,
      expected_progress: expectedProgress,
      behind_by: 0,
      is_overdue: isOverdue,
      is_paused: false,
      last_activity_date: lastActivityDate,
      days_since_activity: daysSinceActivity,
      last_logged_today: lastLoggedToday
    };
  }

  let progress = 0;
  let progressSource = 'auto';

  if (goal.manual_progress !== null && goal.manual_progress !== undefined) {
    progress = Math.min(100, Math.max(0, goal.manual_progress));
    progressSource = 'manual';
  } else if (goal.goal_type === 'count') {
    const target = goal.target_count || 1;
    progress = Math.min(100, Math.round(((goal.current_count || 0) / target) * 100));
    progressSource = 'count';
  } else if (goal.goal_type === 'frequency') {
    const monday = getWeekMondayDate(todayDateObj);
    const sunday = getWeekSundayDate(todayDateObj);
    const rows = activeDb.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT date
        FROM goal_progress_log
        WHERE goal_id = ? AND date >= ? AND date <= ?
        GROUP BY date
        HAVING SUM(amount) > 0
      )
    `).get(goal.id, monday, sunday);
    const daysThisWeek = rows ? rows.cnt : 0;
    const perWeek = goal.per_week || 1;
    progress = Math.min(100, Math.round((daysThisWeek / perWeek) * 100));
    progressSource = 'frequency';

    return {
      progress,
      progress_source: progressSource,
      days_left: daysLeft,
      expected_progress: expectedProgress,
      behind_by: Math.max(0, expectedProgress - progress),
      is_overdue: isOverdue,
      is_paused: false,
      days_this_week: daysThisWeek,
      last_activity_date: lastActivityDate,
      days_since_activity: daysSinceActivity,
      last_logged_today: lastLoggedToday
    };
  } else {
    // Milestone Goal: active (non-deleted) steps only
    const steps = activeDb.prepare(`
      SELECT done FROM goal_steps 
      WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
    `).all(goal.id);

    if (steps.length === 0) {
      // Edge Case 2: Zero active steps yields 0% progress and avoids division by zero
      progress = 0;
      progressSource = 'no_progress_data';
    } else {
      const done = steps.filter(s => s.done === 1).length;
      progress = Math.round((done / steps.length) * 100);
      progressSource = 'milestone_steps';
    }
  }

  const behindBy = Math.max(0, expectedProgress - progress);

  return {
    progress,
    progress_source: progressSource,
    days_left: daysLeft,
    expected_progress: expectedProgress,
    behind_by: behindBy,
    is_overdue: isOverdue,
    is_paused: false,
    last_activity_date: lastActivityDate,
    days_since_activity: daysSinceActivity,
    last_logged_today: lastLoggedToday
  };
}

// ─────────────────────────────────────────────────────────────
// GET ALL GOALS
// ─────────────────────────────────────────────────────────────
function getAllGoals(todayDateObj = new Date(), opts = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const todayDateStr = getTodayDate(todayDateObj);

  let query = 'SELECT * FROM goals';
  const params = [];
  const statusFilter = (opts.status || '').toLowerCase().trim();

  if (statusFilter === 'active') {
    query += " WHERE status = 'active' AND (is_paused IS NULL OR is_paused = 0)";
  } else if (statusFilter === 'paused') {
    query += " WHERE status = 'active' AND is_paused = 1";
  } else if (statusFilter === 'completed') {
    query += " WHERE status = 'completed'";
  } else if (statusFilter === 'removed') {
    query += " WHERE status = 'removed'";
  } else if (statusFilter === 'all') {
    // No status filter
  } else if (!statusFilter) {
    // Default: visible goals (active, paused, completed; not removed)
    query += " WHERE status != 'removed'";
  }

  query += " ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, priority, deadline";
  const goals = activeDb.prepare(query).all(...params);

  let results = goals.map(g => {
    const computed = computeGoalProgress(g, todayDateStr, todayDateObj, activeDb);
    const steps = activeDb.prepare(`
      SELECT id, step_text, done, is_deleted 
      FROM goal_steps 
      WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0) 
      ORDER BY id ASC
    `).all(g.id).map(s => ({ id: s.id, step_text: s.step_text, done: Boolean(s.done) }));

    return {
      ...g,
      ...computed,
      is_paused: Boolean(g.is_paused),
      display_status: g.is_paused ? 'paused' : g.status,
      steps
    };
  });

  if (statusFilter === 'overdue') {
    results = results.filter(g => g.is_overdue && !g.is_paused && g.status === 'active');
  }

  if (opts.category) {
    const cat = opts.category.toLowerCase().trim();
    results = results.filter(g => (g.category || '').toLowerCase().includes(cat));
  }

  if (opts.priority) {
    const p = opts.priority.toLowerCase().trim();
    results = results.filter(g => (g.priority || '').toLowerCase() === p);
  }

  if (opts.limit && !isNaN(parseInt(opts.limit, 10))) {
    results = results.slice(0, parseInt(opts.limit, 10));
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// GET GOAL BY ID (detailed info)
// ─────────────────────────────────────────────────────────────
function getGoalById(goalId, todayDateObj = new Date(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) return null;

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) return null;

  const todayDateStr = getTodayDate(todayDateObj);
  const computed = computeGoalProgress(goal, todayDateStr, todayDateObj, activeDb);

  const steps = activeDb.prepare(`
    SELECT id, step_text, done, is_deleted 
    FROM goal_steps 
    WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
    ORDER BY id ASC
  `).all(id).map(s => ({ id: s.id, step_text: s.step_text, done: Boolean(s.done) }));

  const recentLogs = activeDb.prepare(`
    SELECT id, date, amount, note, chat_message_id 
    FROM goal_progress_log 
    WHERE goal_id = ? 
    ORDER BY date DESC, id DESC LIMIT 20
  `).all(id);

  return {
    ...goal,
    ...computed,
    is_paused: Boolean(goal.is_paused),
    display_status: goal.is_paused ? 'paused' : goal.status,
    steps,
    recent_logs: recentLogs
  };
}

// ─────────────────────────────────────────────────────────────
// CREATE GOAL
// ─────────────────────────────────────────────────────────────
function createGoal(data, todayDateStr = getTodayDate(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const title = (data.title || '').trim();
  if (!title) throw createServiceError(400, 'Goal title is required' );
  if (title.length > 200) throw createServiceError(400, 'Goal title cannot exceed 200 characters' );

  const category = (data.category || 'General').trim();
  const rawPriority = (data.priority || 'medium').toLowerCase().trim();
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';

  const deadline = data.deadline && isValidDate(data.deadline) ? data.deadline : null;

  // Duplicate check on active goals (case-insensitive)
  const existing = activeDb.prepare(
    "SELECT id, title FROM goals WHERE LOWER(title) = LOWER(?) AND status = 'active'"
  ).get(title);
  if (existing) {
    throw createServiceError(409, `An active goal titled "${existing.title}" already exists.`);
  }

  const targetText = (data.target || data.target_text || '').trim();
  const inferred = inferGoalType({
    target: targetText,
    target_count: data.target_count,
    per_week: data.per_week
  });

  const month = data.month || (deadline ? deadline.slice(0, 7) : todayDateStr.slice(0, 7));

  let newId;
  const tx = activeDb.transaction(() => {
    const res = activeDb.prepare(`
      INSERT INTO goals (
        month, category, title, target_text, deadline, priority,
        goal_type, target_count, current_count, per_week, status, is_paused, created_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', 0, ?)
    `).run(
      month, category, title, targetText, deadline, priority,
      inferred.type, inferred.target_count, inferred.per_week, todayDateStr
    );
    newId = res.lastInsertRowid;

    let stepsToAdd = [];
    if (Array.isArray(data.steps) && data.steps.length > 0) {
      stepsToAdd = data.steps.map(s => String(s).trim()).filter(Boolean);
    } else if (inferred.type === 'milestone' && targetText) {
      stepsToAdd = inferSteps(targetText);
    }

    for (const stepText of stepsToAdd) {
      activeDb.prepare('INSERT INTO goal_steps (goal_id, step_text, done, is_deleted) VALUES (?, ?, 0, 0)')
        .run(newId, stepText);
    }
  });
  tx();

  return getGoalById(newId, new Date(todayDateStr), activeDb);
}

// ─────────────────────────────────────────────────────────────
// UPDATE GOAL METADATA
// ─────────────────────────────────────────────────────────────
function updateGoal(goalId, updates = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );

  const dbUpdates = {};
  if ('title' in updates) {
    const t = (updates.title || '').trim();
    if (!t || t.length > 200) throw createServiceError(400, 'Title must be 1-200 characters.' );
    dbUpdates.title = t;
  }
  if ('category' in updates) {
    const c = (updates.category || '').trim();
    if (c) dbUpdates.category = c;
  }
  if ('priority' in updates) {
    const p = (updates.priority || '').toLowerCase().trim();
    if (!ALLOWED_PRIORITIES.includes(p)) throw createServiceError(400, 'Priority must be high/medium/low.' );
    dbUpdates.priority = p;
  }
  if ('deadline' in updates) {
    if (updates.deadline === null) {
      dbUpdates.deadline = null;
    } else {
      if (!isValidDate(updates.deadline)) throw createServiceError(400, 'Deadline must be YYYY-MM-DD.' );
      dbUpdates.deadline = updates.deadline;
    }
  }
  if ('target' in updates || 'target_text' in updates) {
    const tt = (updates.target || updates.target_text || '').trim();
    dbUpdates.target_text = tt;
    const inferred = inferGoalType({ target: tt });
    if (inferred.target_count != null) dbUpdates.target_count = inferred.target_count;
    if (inferred.per_week != null) dbUpdates.per_week = inferred.per_week;
  }
  if ('target_count' in updates) {
    const tc = parseInt(updates.target_count, 10);
    if (!isNaN(tc) && tc > 0) dbUpdates.target_count = tc;
  }
  if ('per_week' in updates) {
    const pw = parseInt(updates.per_week, 10);
    if (!isNaN(pw) && pw >= 1 && pw <= 7) dbUpdates.per_week = pw;
  }

  if (Object.keys(dbUpdates).length === 0) {
    return { success: true, unchanged: true, goal: getGoalById(id, new Date(), activeDb) };
  }

  const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
  activeDb.prepare(`UPDATE goals SET ${setClauses} WHERE id = ?`).run(...Object.values(dbUpdates), id);

  return {
    success: true,
    updated_fields: Object.keys(dbUpdates),
    goal: getGoalById(id, new Date(), activeDb)
  };
}

// ─────────────────────────────────────────────────────────────
// MANAGE GOAL STEPS (add, rename, delete, toggle, list)
// ─────────────────────────────────────────────────────────────
function manageGoalSteps(goalId, action, params = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );

  const act = (action || '').toLowerCase().trim();

  if (act === 'list') {
    const steps = activeDb.prepare(`
      SELECT id, step_text, done, is_deleted 
      FROM goal_steps 
      WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
      ORDER BY id ASC
    `).all(id).map(s => ({ id: s.id, step_text: s.step_text, done: Boolean(s.done) }));
    return { success: true, goal_id: id, count: steps.length, steps };
  }

  if (act === 'add') {
    const stepTexts = [];
    if (typeof params.step_text === 'string' && params.step_text.trim()) {
      stepTexts.push(params.step_text.trim());
    } else if (Array.isArray(params.steps)) {
      params.steps.forEach(s => {
        if (typeof s === 'string' && s.trim()) stepTexts.push(s.trim());
      });
    }
    if (stepTexts.length === 0) {
      throw createServiceError(400, 'No valid step text provided' );
    }

    const inserted = [];
    const tx = activeDb.transaction(() => {
      for (const text of stepTexts) {
        const res = activeDb.prepare(`
          INSERT INTO goal_steps (goal_id, step_text, done, is_deleted)
          VALUES (?, ?, 0, 0)
        `).run(id, text);
        inserted.push({ id: res.lastInsertRowid, step_text: text, done: 0 });
      }
    });
    tx();

    return {
      success: true,
      goal_id: id,
      added_count: inserted.length,
      steps: inserted,
      message: `Added ${inserted.length} step(s) to "${goal.title}".`
    };
  }

  if (act === 'rename') {
    const stepId = parseInt(params.step_id, 10);
    const newText = (params.step_text || '').trim();
    if (!newText) throw createServiceError(400, 'New step text is required.' );

    let targetStep = null;
    if (!isNaN(stepId)) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE id = ? AND goal_id = ?').get(stepId, id);
    } else if (params.old_text) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE goal_id = ? AND LOWER(step_text) = ? AND (is_deleted IS NULL OR is_deleted = 0)').get(id, params.old_text.toLowerCase().trim());
    }
    if (!targetStep) throw createServiceError(404, 'Step not found.' );

    activeDb.prepare('UPDATE goal_steps SET step_text = ? WHERE id = ?').run(newText, targetStep.id);
    return {
      success: true,
      goal_id: id,
      step_id: targetStep.id,
      previous_text: targetStep.step_text,
      new_text: newText,
      message: `Step renamed to "${newText}".`
    };
  }

  if (act === 'delete') {
    const stepId = parseInt(params.step_id, 10);
    let targetStep = null;
    if (!isNaN(stepId)) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE id = ? AND goal_id = ?').get(stepId, id);
    } else if (params.step_text) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE goal_id = ? AND LOWER(step_text) LIKE ? AND (is_deleted IS NULL OR is_deleted = 0)').get(id, `%${params.step_text.toLowerCase().trim()}%`);
    }
    if (!targetStep) throw createServiceError(404, 'Step not found.' );

    // Soft delete step
    activeDb.prepare('UPDATE goal_steps SET is_deleted = 1 WHERE id = ?').run(targetStep.id);

    // Edge Case 2: Check remaining non-deleted steps count
    const remaining = activeDb.prepare('SELECT id FROM goal_steps WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0)').all(id);
    const zeroStepsWarning = remaining.length === 0
      ? ` All active steps for "${goal.title}" have been removed (0% milestone progress). Would you like to add replacement steps?`
      : '';

    return {
      success: true,
      goal_id: id,
      step_id: targetStep.id,
      remaining_steps_count: remaining.length,
      zero_steps: remaining.length === 0,
      message: `Step "${targetStep.step_text}" removed.${zeroStepsWarning}`
    };
  }

  if (act === 'toggle' || act === 'complete' || act === 'uncomplete') {
    const stepId = parseInt(params.step_id, 10);
    let targetStep = null;
    if (!isNaN(stepId)) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE id = ? AND goal_id = ?').get(stepId, id);
    } else if (params.step_text) {
      targetStep = activeDb.prepare('SELECT * FROM goal_steps WHERE goal_id = ? AND LOWER(step_text) LIKE ? AND (is_deleted IS NULL OR is_deleted = 0)').get(id, `%${params.step_text.toLowerCase().trim()}%`);
    }
    if (!targetStep) throw createServiceError(404, 'Step not found.' );

    let done = 1;
    if (act === 'uncomplete') done = 0;
    else if (act === 'toggle') done = targetStep.done === 1 ? 0 : 1;
    else if (params.done !== undefined) done = params.done ? 1 : 0;

    activeDb.prepare('UPDATE goal_steps SET done = ? WHERE id = ?').run(done, targetStep.id);

    // Auto-complete or reopen milestone goal based on all active steps
    const activeSteps = activeDb.prepare('SELECT id, done FROM goal_steps WHERE goal_id = ? AND (is_deleted IS NULL OR is_deleted = 0)').all(id);
    const allDone = activeSteps.length > 0 && activeSteps.every(s => s.id === targetStep.id ? done === 1 : s.done === 1);

    if (allDone && goal.status === 'active') {
      activeDb.prepare("UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?").run(getTodayDate(), id);
    } else if (!allDone && goal.status === 'completed' && done === 0) {
      activeDb.prepare("UPDATE goals SET status = 'active', completed_date = NULL WHERE id = ?").run(id);
    }

    return {
      success: true,
      goal_id: id,
      step_id: targetStep.id,
      step_text: targetStep.step_text,
      done: Boolean(done),
      all_done: allDone,
      message: `Step "${targetStep.step_text}" marked as ${done ? 'completed' : 'incomplete'}.`
    };
  }

  throw createServiceError(400, `Unknown step action "${action}". Allowed: add, rename, delete, toggle, list.`);
}

// ─────────────────────────────────────────────────────────────
// LOG GOAL PROGRESS
// ─────────────────────────────────────────────────────────────
function logGoalProgress(goalId, params = {}, todayDateStr = getTodayDate(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );
  if (goal.status === 'removed') throw createServiceError(400, 'Cannot log progress on a removed goal. Restore it first.' );
  if (goal.is_paused === 1) throw createServiceError(400, `Cannot log progress on paused goal "${goal.title}". Resume it first.`);
  if (goal.status === 'completed') throw createServiceError(400, `Goal "${goal.title}" is already completed.`);

  const targetDate = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : todayDateStr;

  let amount = parseInt(params.amount, 10);
  if (isNaN(amount) || amount <= 0) amount = 1;

  const note = params.note ? String(params.note).substring(0, 200) : null;
  const chatMessageId = params.chat_message_id || null;

  if (goal.goal_type === 'count') {
    const target = goal.target_count || Infinity;
    const newCount = Math.min(goal.current_count + amount, target);
    const delta = newCount - goal.current_count;

    const tx = activeDb.transaction(() => {
      activeDb.prepare('UPDATE goals SET current_count = ? WHERE id = ?').run(newCount, id);
      activeDb.prepare(`
        INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, targetDate, delta, note, chatMessageId);

      if (target !== Infinity && newCount >= target) {
        activeDb.prepare("UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?").run(targetDate, id);
      }
    });
    tx();

    return {
      success: true,
      goal_id: id,
      goal_title: goal.title,
      logged: delta,
      previous_count: goal.current_count,
      current_count: newCount,
      target_count: goal.target_count,
      target_reached: target !== Infinity && newCount >= target,
      message: `Logged ${delta} for "${goal.title}". Progress: ${newCount}/${goal.target_count || 'open'}.`
    };
  }

  if (goal.goal_type === 'frequency') {
    // One session per day rule
    const existing = activeDb.prepare(`
      SELECT 1 FROM goal_progress_log 
      WHERE goal_id = ? AND date = ? 
      GROUP BY date HAVING SUM(amount) > 0
    `).get(id, targetDate);

    if (existing) {
      return {
        success: true,
        already_logged: true,
        logged: 0,
        goal_id: id,
        goal_title: goal.title,
        message: `Already logged a session for "${goal.title}" on ${targetDate}. One session per day counts.`
      };
    }

    const newCount = (goal.current_count || 0) + 1;
    activeDb.prepare('UPDATE goals SET current_count = ? WHERE id = ?').run(newCount, id);

    activeDb.prepare(`
      INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
      VALUES (?, ?, 1, ?, ?)
    `).run(id, targetDate, note, chatMessageId);

    return {
      success: true,
      logged: 1,
      goal_id: id,
      goal_title: goal.title,
      current_count: newCount,
      date: targetDate,
      message: `Logged 1 session for "${goal.title}" on ${targetDate}.`
    };
  }

  // Milestone / Qualitative goal practice session
  activeDb.prepare(`
    INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
    VALUES (?, ?, 1, ?, ?)
  `).run(id, targetDate, note || 'worked', chatMessageId);

  return {
    success: true,
    logged: 1,
    goal_id: id,
    goal_title: goal.title,
    message: `Session logged for "${goal.title}".`
  };
}

// ─────────────────────────────────────────────────────────────
// CORRECT GOAL PROGRESS (compensating adjustment)
// ─────────────────────────────────────────────────────────────
function correctGoalProgress(goalId, params = {}, todayDateStr = getTodayDate(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );

  const correctAmount = parseInt(params.correct_amount, 10);
  if (isNaN(correctAmount) || correctAmount < 0) {
    throw createServiceError(400, 'Corrected amount must be a non-negative integer (0 or greater).' );
  }

    let candidateEntries = [];
  if (params.entry_id) {
    const ent = activeDb.prepare('SELECT * FROM goal_progress_log WHERE id = ? AND goal_id = ?').get(params.entry_id, id);
    if (ent) candidateEntries = [ent];
  } else {
    const targetDate = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;
    if (targetDate) {
      candidateEntries = activeDb.prepare(`
        SELECT * FROM goal_progress_log
        WHERE goal_id = ? AND date = ? AND amount > 0 AND (note IS NULL OR note NOT LIKE 'correction_for:%')
        ORDER BY id DESC LIMIT 5
      `).all(id, targetDate);
    } else {
      // Check today's positive entries first
      candidateEntries = activeDb.prepare(`
        SELECT * FROM goal_progress_log
        WHERE goal_id = ? AND date = ? AND amount > 0 AND (note IS NULL OR note NOT LIKE 'correction_for:%')
        ORDER BY id DESC LIMIT 5
      `).all(id, todayDateStr);

      // If no entries today, look at yesterday
      if (candidateEntries.length === 0) {
        const yesterday = new Date(todayDateStr);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = getTodayDate(yesterday);

        candidateEntries = activeDb.prepare(`
          SELECT * FROM goal_progress_log
          WHERE goal_id = ? AND date = ? AND amount > 0 AND (note IS NULL OR note NOT LIKE 'correction_for:%')
          ORDER BY id DESC LIMIT 5
        `).all(id, yesterdayStr);
      }
    }
  }

  if (candidateEntries.length === 0) {
    throw createServiceError(404, `No recent progress entry found to correct for "${goal.title}".`);
  }

  const enriched = [];
  for (const entry of candidateEntries) {
    const comp = activeDb.prepare(`
      SELECT SUM(amount) as comp_sum 
      FROM goal_progress_log 
      WHERE goal_id = ? AND note LIKE ?
    `).get(id, `correction_for:${entry.id}:%`);
    const currentEffective = entry.amount + (comp && comp.comp_sum ? comp.comp_sum : 0);
    if (currentEffective > 0 || params.entry_id) {
      enriched.push({ ...entry, currentEffective });
    }
  }

  if (enriched.length === 0) {
    throw createServiceError(400, `All recent entries for "${goal.title}" have already been corrected.`);
  }
  if (enriched.length > 1 && !params.entry_id) {
    return {
      success: false,
      ambiguous: true,
      error: `Found ${enriched.length} separate recent progress entries for "${goal.title}". Please specify which entry or amount you want to adjust.`
    };
  }

  const targetEntry = enriched[0];
  const delta = correctAmount - targetEntry.currentEffective;
  if (delta === 0) {
    return {
      success: true,
      unchanged: true,
      message: `No adjustment needed: entry #${targetEntry.id} for "${goal.title}" is already recorded at ${correctAmount}.`
    };
  }

  const currentCount = goal.current_count || 0;
  const targetCount = goal.target_count || 1;
  const newCount = Math.max(0, currentCount + delta);

  let newStatus = goal.status;
  let completedDate = goal.completed_date;
  if (newCount >= targetCount && targetCount > 0) {
    newStatus = 'completed';
    completedDate = completedDate || todayDateStr;
  } else if (goal.status === 'completed' && newCount < targetCount) {
    newStatus = 'active';
    completedDate = null;
  }

  const tx = activeDb.transaction(() => {
    activeDb.prepare(`
      UPDATE goals 
      SET current_count = ?, status = ?, completed_date = ? 
      WHERE id = ?
    `).run(newCount, newStatus, completedDate, id);

    activeDb.prepare(`
      INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      todayDateStr,
      delta,
      `correction_for:${targetEntry.id}:${params.reason || `adjusted from ${targetEntry.currentEffective} to ${correctAmount}`}`,
      params.chat_message_id || null
    );
  });
  tx();

  return {
    success: true,
    goal_id: id,
    goal_title: goal.title,
    previous_count: currentCount,
    new_count: newCount,
    compensating_delta: delta,
    message: `Corrected! Adjusted "${goal.title}" progress from ${currentCount} to ${newCount} (delta: ${delta > 0 ? '+' : ''}${delta}).`
  };
}

// ─────────────────────────────────────────────────────────────
// UPDATE GOAL STATUS (pause, resume, complete, reopen, restore)
// ─────────────────────────────────────────────────────────────
function updateGoalStatus(goalId, action, params = {}, todayDateStr = getTodayDate(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );

  const act = (action || '').toLowerCase().trim();

  if (act === 'pause') {
    if (goal.status === 'completed') {
      throw createServiceError(400, 'Cannot pause a completed goal. Reopen it first if you wish to pause or adjust work.' );
    }
    if (goal.status === 'removed') {
      throw createServiceError(400, 'Cannot pause a removed goal. Restore it first.' );
    }
    if (goal.is_paused === 1) {
      return { success: true, unchanged: true, goal, message: `Goal "${goal.title}" is already paused.` };
    }

    activeDb.prepare(`
      UPDATE goals 
      SET is_paused = 1, paused_at = ? 
      WHERE id = ?
    `).run(todayDateStr, id);

    const updated = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return {
      success: true,
      goal: updated,
      message: `Goal "${goal.title}" paused. Reminders and pace tracking are temporarily suspended.`
    };
  }

  if (act === 'resume') {
    if (goal.status === 'completed') {
      throw createServiceError(400, 'Cannot resume a completed goal. Use "reopen" to make a completed goal active.' );
    }
    if (goal.status === 'removed') {
      throw createServiceError(400, 'Cannot resume a removed goal. Use "restore" to reactivate it.' );
    }
    if (goal.is_paused === 0 || goal.is_paused == null) {
      return { success: true, unchanged: true, goal, message: `Goal "${goal.title}" is already active and unpaused.` };
    }

    let daysPaused = 0;
    if (goal.paused_at) {
      daysPaused = Math.max(0, daysBetween(goal.paused_at, todayDateStr));
    }

    let newDeadline = goal.deadline;
    const shouldExtendDeadline = params.extend_deadline !== false;
    if (goal.deadline && daysPaused > 0 && shouldExtendDeadline) {
      newDeadline = addDaysToDate(goal.deadline, daysPaused);
    }

    activeDb.prepare(`
      UPDATE goals 
      SET is_paused = 0, paused_at = NULL, deadline = ?, total_paused_days = (COALESCE(total_paused_days, 0) + ?)
      WHERE id = ?
    `).run(newDeadline, daysPaused, id);

    const updated = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    const deadlineMsg = (daysPaused > 0 && shouldExtendDeadline && newDeadline !== goal.deadline)
      ? ` Deadline extended by ${daysPaused} day(s) to ${newDeadline}.`
      : '';
    return {
      success: true,
      goal: updated,
      days_paused: daysPaused,
      new_deadline: newDeadline,
      message: `Goal "${goal.title}" resumed.${deadlineMsg}`
    };
  }

  if (act === 'complete') {
    if (goal.status === 'removed') {
      throw createServiceError(400, 'Cannot complete a removed goal. Restore it first.' );
    }
    activeDb.prepare(`
      UPDATE goals 
      SET status = 'completed', is_paused = 0, paused_at = NULL, completed_date = ? 
      WHERE id = ?
    `).run(todayDateStr, id);
    const updated = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return {
      success: true,
      goal: updated,
      message: `Goal "${goal.title}" marked as completed!`
    };
  }

  if (act === 'reopen') {
    if (goal.status !== 'completed') {
      throw createServiceError(400, `Goal "${goal.title}" is ${goal.status}, not completed.`);
    }
    activeDb.prepare(`
      UPDATE goals 
      SET status = 'active', is_paused = 0, paused_at = NULL, completed_date = NULL 
      WHERE id = ?
    `).run(id);
    const updated = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return {
      success: true,
      goal: updated,
      message: `Goal "${goal.title}" reopened and returned to active status.`
    };
  }

  if (act === 'restore') {
    if (goal.status !== 'removed') {
      return { success: true, unchanged: true, goal, message: `Goal "${goal.title}" is already ${goal.status}.` };
    }
    activeDb.prepare(`
      UPDATE goals 
      SET status = 'active', is_paused = 0, paused_at = NULL 
      WHERE id = ?
    `).run(id);
    const updated = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return {
      success: true,
      goal: updated,
      message: `Goal "${goal.title}" restored. Progress and historical logs are intact.`
    };
  }

  throw createServiceError(400, `Unknown goal status action "${action}". Allowed: pause, resume, complete, reopen, restore.`);
}

// ─────────────────────────────────────────────────────────────
// DELETE GOAL (Atomic soft-deletion + task & day plan cleanup)
// ─────────────────────────────────────────────────────────────
function deleteGoal(goalId, todayDateStr = getTodayDate(), dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const id = parseInt(goalId, 10);
  if (isNaN(id)) throw createServiceError(400, 'Invalid goal ID' );

  const goal = activeDb.prepare('SELECT id, title, status FROM goals WHERE id = ?').get(id);
  if (!goal) throw createServiceError(404, 'Goal not found' );

  const deleteTx = activeDb.transaction(() => {
    // 1. Soft-delete goal
    activeDb.prepare("UPDATE goals SET status = 'removed', is_paused = 0, paused_at = NULL WHERE id = ?").run(id);

    // 2. Identify incomplete tasks to cancel (today, future, backlog)
    const tasksToCancel = activeDb.prepare(`
      SELECT id, date 
      FROM tasks 
      WHERE goal_id = ? AND completed = 0 AND (date >= ? OR date IS NULL)
    `).all(id, todayDateStr);

    // 3. Atomically clean day_plans.plan_json for any scheduled tasks
    for (const t of tasksToCancel) {
      if (t.date) {
        DayPlanService.removeTaskFromPlanTransaction(t.id, t.date, activeDb);
      }
    }

    // 4. Delete incomplete tasks
    activeDb.prepare(`
      DELETE FROM tasks 
      WHERE goal_id = ? AND completed = 0 AND (date >= ? OR date IS NULL)
    `).run(id, todayDateStr);
  });

  deleteTx();
  return {
    success: true,
    goal_id: id,
    title: goal.title,
    message: `Goal "${goal.title}" removed. Completed tasks and progress history are preserved.`
  };
}

// ─────────────────────────────────────────────────────────────
// SET STEPS for a milestone goal
// ─────────────────────────────────────────────────────────────
function setGoalSteps(goalId, stepTexts, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  activeDb.transaction(() => {
    activeDb.prepare('DELETE FROM goal_steps WHERE goal_id = ? AND done = 0').run(goalId);
    for (const text of stepTexts) {
      activeDb.prepare('INSERT INTO goal_steps (goal_id, step_text, done, is_deleted) VALUES (?, ?, 0, 0)').run(goalId, text.trim());
    }
  })();
}

// ─────────────────────────────────────────────────────────────
// GET GOAL REMINDERS
// ─────────────────────────────────────────────────────────────
const LEVEL_RANK = { urgent: 1, warning: 2, info: 3 };
const PRIO_RANK = { high: 1, medium: 2, low: 3 };

function getGoalReminders(todayDateObj = new Date(), opts = {}, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  const todayStr = getTodayDate(todayDateObj);
  const prefs = activeDb.prepare('SELECT neglect_days FROM preferences WHERE id = 1').get() || {};
  const neglectDays = prefs.neglect_days ?? 3;

  // Filter: active goals that are NOT paused and not 100% complete
  const activeGoals = getAllGoals(todayDateObj, { status: 'active' }, activeDb)
    .filter(g => g.status === 'active' && !g.is_paused && g.progress < 100);

  const reminders = [];

  for (const g of activeGoals) {
    const matchedRules = [];
    const prio = (g.priority || 'medium').toLowerCase();
    const isNoProgressData = g.progress_source === 'no_progress_data';
    const dsa = computeDaysSinceActivity(g, todayStr);

    if (g.is_overdue) {
      matchedRules.push({
        level: 'urgent',
        text: `Overdue (deadline ${g.deadline}) — ${g.progress}% complete`
      });
    } else if (g.days_left !== null && g.days_left <= 3 && g.progress < 100) {
      matchedRules.push({
        level: 'urgent',
        text: `Deadline in ${g.days_left} day${g.days_left === 1 ? '' : 's'} (${g.deadline}) — ${g.progress}% complete`
      });
    }

    if (!isNoProgressData) {
      if (prio === 'high' && g.behind_by >= 10) {
        matchedRules.push({
          level: 'urgent',
          text: `Behind pace by ${g.behind_by}% (${g.progress}% vs ${g.expected_progress}% expected)`
        });
      } else if (prio === 'medium' && g.behind_by >= 20) {
        matchedRules.push({
          level: 'warning',
          text: `Behind pace by ${g.behind_by}% (${g.progress}% vs ${g.expected_progress}% expected)`
        });
      } else if (prio === 'low' && g.behind_by >= 30) {
        matchedRules.push({
          level: 'info',
          text: `Behind pace by ${g.behind_by}% (${g.progress}% vs ${g.expected_progress}% expected)`
        });
      }
    }

    if (dsa >= neglectDays) {
      matchedRules.push({
        level: 'warning',
        text: `No progress in ${dsa} days`
      });
    }

    if (isNoProgressData) {
      matchedRules.push({
        level: 'info',
        text: `No steps defined. Say 'steps for ${g.title}: a; b; c' or set progress manually.`
      });
    }

    if (matchedRules.length === 0) continue;

    matchedRules.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
    const topLevel = matchedRules[0].level;
    const strongestRules = matchedRules.filter(r => r.level === topLevel);
    const combinedReason = strongestRules.map(r => r.text).join(' • ');

    reminders.push({
      goal_id: g.id,
      title: g.title,
      category: g.category,
      priority: prio,
      level: topLevel,
      reason: combinedReason,
      reasons: strongestRules.map(r => r.text),
      progress: g.progress,
      expected_progress: g.expected_progress,
      behind_by: g.behind_by,
      days_left: g.days_left,
      is_overdue: g.is_overdue,
      days_since_activity: dsa,
      progress_source: g.progress_source
    });
  }

  reminders.sort((a, b) => {
    const lDiff = (LEVEL_RANK[a.level] || 9) - (LEVEL_RANK[b.level] || 9);
    if (lDiff !== 0) return lDiff;
    const pDiff = (PRIO_RANK[a.priority] || 9) - (PRIO_RANK[b.priority] || 9);
    if (pDiff !== 0) return pDiff;
    return a.goal_id - b.goal_id;
  });

  return opts && opts.uncapped ? reminders : reminders.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────
// FIND MATCHING GOAL (Fuzzy & Semantic matcher)
// ─────────────────────────────────────────────────────────────
function findMatchingGoal(query, goals = null, dbOverride = null) {
  const activeDb = dbOverride || defaultDb;
  let candidatePool = goals;
  if (!candidatePool) {
    candidatePool = activeDb.prepare("SELECT * FROM goals WHERE status != 'removed'").all();
  }
  if (!query) return { match: null, ambiguous: false, candidates: [] };

  const q = String(query).trim().toLowerCase();

  // Numeric ID
  if (/^\d+$/.test(q)) {
    const targetId = parseInt(q, 10);
    const byId = candidatePool.find(g => g.id === targetId);
    if (byId) return { match: byId, ambiguous: false, candidates: [byId] };
    const anyById = activeDb.prepare('SELECT * FROM goals WHERE id = ?').get(targetId);
    if (anyById) return { match: anyById, ambiguous: false, candidates: [anyById] };
  }

  // Exact title match (case-insensitive)
  const exact = candidatePool.filter(g => g.title.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], ambiguous: false, candidates: exact };

  // Substring match
  const matches = candidatePool.filter(g => {
    const t = g.title.toLowerCase();
    const c = (g.category || '').toLowerCase();
    return t.includes(q) || q.includes(t) || c.includes(q);
  });

  if (matches.length === 1) {
    return { match: matches[0], ambiguous: false, candidates: matches };
  }
  if (matches.length > 1) {
    return { match: null, ambiguous: true, candidates: matches };
  }

  return { match: null, ambiguous: false, candidates: [] };
}

module.exports = {
  importGoals,
  getAllGoals,
  getGoalById,
  createGoal,
  updateGoal,
  manageGoalSteps,
  logGoalProgress,
  correctGoalProgress,
  updateGoalStatus,
  deleteGoal,
  setGoalSteps,
  getGoalReminders,
  computeGoalProgress,
  inferGoalType,
  inferSteps,
  findMatchingGoal,
  RE_PER_WEEK,
  RE_TARGET_COUNT
};
