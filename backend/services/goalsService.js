/**
 * backend/services/goalsService.js
 *
 * Core logic for goal import, progress computation, and goal queries.
 * Takes an injected `today` (Date) so tests can simulate other days.
 * No AI calls — all parsing, validation, and computation is deterministic code.
 */

const db = require('../database/db');
const { getTodayDate, getWeekMondayDate, getWeekSundayDate, daysBetween } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// REGEX CONSTANTS (documented assumptions)
// ─────────────────────────────────────────────────────────────

/**
 * Matches "<n> days/week", "<n> days per week", or "<n>/week".
 * A bare "<n> days" does NOT match — requires the /week or per week suffix.
 * Group 1 OR Group 2 contains the number.
 */
const RE_PER_WEEK = /(\d+)\s*days?\s*(?:per\s*week|\/week)|(\d+)\/week/i;

/**
 * Matches "<n> problems" or "<n> questions" for count goal inference.
 * Group 1 contains the number.
 */
const RE_TARGET_COUNT = /(\d+)\s*(?:problems?|questions?)/i;

/**
 * Strips trailing done/complete/completed/connected from the LAST step text only.
 * Applied ONLY to the final item after comma-splitting.
 */
const RE_TRAILING_DONE = /\s*\b(done|complete|completed|connected)\s*$/i;

// ─────────────────────────────────────────────────────────────
// STEP INFERENCE
// Splits target_text into steps for milestone goals.
// Rules:
//  - Split on commas only when there are 2-5 comma-separated items
//  - Strip trailing done/complete/completed/connected from the LAST item only
//  - Each step trimmed; empty steps dropped
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
  // Explicit fields take precedence over text parsing
  if (goal.per_week !== undefined && goal.per_week !== null) return { type: 'frequency', per_week: goal.per_week, target_count: null };
  if (goal.target_count !== undefined && goal.target_count !== null) return { type: 'count', per_week: null, target_count: goal.target_count };

  const target = goal.target || '';

  // Try per_week regex on free text
  const mWeek = target.match(RE_PER_WEEK);
  if (mWeek) {
    const n = parseInt(mWeek[1] || mWeek[2], 10);
    if (!isNaN(n) && n >= 1 && n <= 7) return { type: 'frequency', per_week: n, target_count: null };
  }

  // Try target_count regex on free text
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
// IMPORT GOALS (exported for use in route AND chat command handler)
// Returns { created, updated, overdue, errors } or throws on bad input.
// ─────────────────────────────────────────────────────────────
function importGoals(payload, todayDate) {
  if (!payload || !Array.isArray(payload.goals) || payload.goals.length === 0) {
    throw { statusCode: 400, error: '"goals" must be a non-empty array' };
  }
  if (payload.goals.length > 30) {
    throw { statusCode: 400, error: 'Maximum 30 goals per import' };
  }

  // Validate all entries first — reject whole import on any error
  const allErrors = [];
  payload.goals.forEach((g, i) => {
    allErrors.push(...validateGoalEntry(g, i));
  });
  if (allErrors.length > 0) {
    throw { statusCode: 400, error: 'Validation failed', details: allErrors };
  }

  const month = payload.month || null;
  let created = 0;
  let updated = 0;
  const overdue = [];

  const importTx = db.transaction(() => {
    for (const rawGoal of payload.goals) {
      const title = rawGoal.title.trim();
      const category = rawGoal.category.trim();
      const deadline = rawGoal.deadline;
      const priority = rawGoal.priority.toLowerCase().trim();
      const targetText = (rawGoal.target || '').trim();

      // Infer goal type + numeric fields from code
      const inferred = inferGoalType(rawGoal);

      // Check if overdue (deadline in the past)
      if (daysBetween(deadline, todayDate) > 0) {
        overdue.push(title);
      }

      // Duplicate check: active goal with same title (case-insensitive)
      const existing = db.prepare(
        "SELECT id FROM goals WHERE LOWER(title) = LOWER(?) AND status = 'active'"
      ).get(title);

      if (existing) {
        // UPDATE deadline, priority, target; keep progress and steps
        db.prepare(`
          UPDATE goals SET deadline=?, priority=?, target_text=?, month=?
          WHERE id=?
        `).run(deadline, priority, targetText, month, existing.id);
        updated++;
      } else {
        // INSERT new goal
        const result = db.prepare(`
          INSERT INTO goals (month, category, title, target_text, deadline, priority,
            goal_type, target_count, current_count, per_week, status, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)
        `).run(month, category, title, targetText, deadline, priority,
            inferred.type, inferred.target_count, inferred.per_week, todayDate);

        const newId = result.lastInsertRowid;

        // Auto-create steps for milestone goals only
        if (inferred.type === 'milestone') {
          const steps = inferSteps(targetText);
          for (const stepText of steps) {
            db.prepare('INSERT INTO goal_steps (goal_id, step_text, done) VALUES (?, ?, 0)')
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
// COMPUTE PROGRESS for a single goal row + its steps/logs
// Returns progress (0-100), progress_source, and derived fields.
// todayDate is "YYYY-MM-DD", todayDateObj is the Date object for week calc.
// ─────────────────────────────────────────────────────────────
function computeGoalProgress(goal, todayDateStr, todayDateObj) {
  // last_activity_date
  const lastLog = db.prepare(
    'SELECT date FROM goal_progress_log WHERE goal_id = ? ORDER BY date DESC LIMIT 1'
  ).get(goal.id);
  const lastActivityDate = lastLog ? lastLog.date : goal.created_date;
  const daysSinceActivity = lastActivityDate
    ? Math.max(0, daysBetween(lastActivityDate, todayDateStr))
    : 0;
  const lastLoggedToday = Boolean(
    db.prepare('SELECT 1 FROM goal_progress_log WHERE goal_id = ? AND date = ? LIMIT 1').get(goal.id, todayDateStr)
  );

  // days_left, expected_progress, behind_by, is_overdue
  const isOverdue = goal.deadline ? daysBetween(goal.deadline, todayDateStr) > 0 : false;
  const daysLeft = goal.deadline
    ? Math.max(0, daysBetween(todayDateStr, goal.deadline))
    : null;

  let expectedProgress = 0;
  if (goal.deadline && daysBetween(todayDateStr, goal.deadline) <= 0) {
    expectedProgress = 100;
  } else if (goal.created_date && goal.deadline) {
    const totalDays = daysBetween(goal.created_date, goal.deadline);
    const elapsedDays = daysBetween(goal.created_date, todayDateStr);
    if (totalDays > 0) {
      expectedProgress = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));
    }
  }

  // Completed goals are always 100
  if (goal.status === 'completed') {
    return {
      progress: 100, progress_source: 'completed',
      days_left: daysLeft, expected_progress: expectedProgress,
      behind_by: 0, is_overdue: isOverdue,
      last_activity_date: lastActivityDate, days_since_activity: daysSinceActivity,
      last_logged_today: lastLoggedToday
    };
  }

  let progress = 0;
  let progressSource = 'auto';

  if (goal.manual_progress !== null && goal.manual_progress !== undefined) {
    // Manual override takes precedence
    progress = Math.min(100, Math.max(0, goal.manual_progress));
    progressSource = 'manual';
  } else if (goal.goal_type === 'count') {
    const target = goal.target_count || 1;
    progress = Math.min(100, Math.round((goal.current_count / target) * 100));
    progressSource = 'count';
  } else if (goal.goal_type === 'frequency') {
    const monday = getWeekMondayDate(todayDateObj);
    const sunday = getWeekSundayDate(todayDateObj);
    const rows = db.prepare(`
      SELECT COUNT(DISTINCT date) as cnt
      FROM goal_progress_log
      WHERE goal_id = ? AND date >= ? AND date <= ?
    `).get(goal.id, monday, sunday);
    const daysThisWeek = rows ? rows.cnt : 0;
    const perWeek = goal.per_week || 1;
    progress = Math.min(100, Math.round((daysThisWeek / perWeek) * 100));
    progressSource = 'frequency';
    // Attach days_this_week as extra field
    return {
      progress, progress_source: progressSource,
      days_left: daysLeft, expected_progress: expectedProgress,
      behind_by: Math.max(0, expectedProgress - progress),
      is_overdue: isOverdue, days_this_week: daysThisWeek,
      last_activity_date: lastActivityDate, days_since_activity: daysSinceActivity,
      last_logged_today: lastLoggedToday
    };
  } else {
    // milestone
    const steps = db.prepare('SELECT done FROM goal_steps WHERE goal_id = ?').all(goal.id);
    if (steps.length === 0) {
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
    progress, progress_source: progressSource,
    days_left: daysLeft, expected_progress: expectedProgress,
    behind_by: behindBy, is_overdue: isOverdue,
    last_activity_date: lastActivityDate, days_since_activity: daysSinceActivity,
    last_logged_today: lastLoggedToday
  };
}

// ─────────────────────────────────────────────────────────────
// GET ALL GOALS with computed progress
// ─────────────────────────────────────────────────────────────
function getAllGoals(todayDateObj) {
  const todayDateStr = getTodayDate(todayDateObj);
  const goals = db.prepare("SELECT * FROM goals ORDER BY status, priority, deadline").all();
  return goals.map(g => {
    const computed = computeGoalProgress(g, todayDateStr, todayDateObj);
    const steps = db.prepare('SELECT id, step_text, done FROM goal_steps WHERE goal_id = ? ORDER BY id').all(g.id);
    return { ...g, ...computed, steps };
  });
}

// ─────────────────────────────────────────────────────────────
// SET STEPS for a milestone goal (used by "steps for <goal>: a; b; c")
// Replaces all UNTICKED steps; ticked steps are never deleted.
// ─────────────────────────────────────────────────────────────
function setGoalSteps(goalId, stepTexts) {
  db.transaction(() => {
    // Delete only unticked steps
    db.prepare('DELETE FROM goal_steps WHERE goal_id = ? AND done = 0').run(goalId);
    for (const text of stepTexts) {
      db.prepare('INSERT INTO goal_steps (goal_id, step_text, done) VALUES (?, ?, 0)').run(goalId, text.trim());
    }
  })();
}

module.exports = {
  importGoals,
  getAllGoals,
  computeGoalProgress,
  inferGoalType,
  inferSteps,
  setGoalSteps,
  RE_PER_WEEK,
  RE_TARGET_COUNT
};
