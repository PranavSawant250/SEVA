/**
 * backend/services/chatTools.js
 *
 * Deterministic Tool Registry for SEVA Agentic Chat.
 * Defines tools, JSON schemas (Gemini function declarations compatible),
 * validation rules, and deterministic handlers executing existing backend services.
 *
 * The LLM only interprets and calls tools; it NEVER executes SQL or writes raw data.
 * All mutations go through the deterministic execution layer.
 */

const db = require('../database/db');
const { getTodayDate, getTomorrowDate, parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');
const {
  getAllGoals,
  getGoalById,
  createGoal,
  updateGoal,
  manageGoalSteps,
  logGoalProgress,
  correctGoalProgress,
  updateGoalStatus,
  deleteGoal,
  computeGoalProgress,
  findMatchingGoal
} = require('./goalsService');
const { replan } = require('./plannerService');
const { getPendingState, setPendingState, clearPending } = require('./chatCommands');
const TaskService = require('./taskService');

// ─────────────────────────────────────────────────────────────
// DATE RESOLUTION HELPER (Injected today)
// ─────────────────────────────────────────────────────────────
function resolveTargetDate(dateStr, todayDt = new Date()) {
  if (!dateStr || typeof dateStr !== 'string') {
    return getTodayDate(todayDt);
  }
  const clean = dateStr.trim().toLowerCase();
  if (clean === 'today' || clean === 'for today') {
    return getTodayDate(todayDt);
  }
  if (clean === 'tomorrow' || clean === 'tmrw' || clean === 'tommorow') {
    return getTomorrowDate(todayDt);
  }
  if (clean === 'yesterday') {
    const y = new Date(todayDt);
    y.setDate(y.getDate() - 1);
    return getTodayDate(y);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const [y, m, d] = clean.split('-').map(Number);
    const valid = new Date(y, m - 1, d);
    if (valid.getFullYear() === y && valid.getMonth() === m - 1 && valid.getDate() === d) {
      return clean;
    }
  }
  // Fallback to today
  return getTodayDate(todayDt);
}

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS & SCHEMAS
// Compatible with Google GenAI / Gemini Function Declarations
// ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_today_plan',
    description: 'Retrieve the scheduled Day Plan items for today (or a specified date). Read-only, no side effects.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Optional date (YYYY-MM-DD, "today", or "tomorrow"). Defaults to today.'
        }
      }
    },
    handler: async (args, context) => {
      const targetDate = resolveTargetDate(args.date, context.todayDate);
      const planRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(targetDate);
      let items = [];
      if (planRow && planRow.plan_json) {
        try { items = JSON.parse(planRow.plan_json); } catch (_) {}
      }
      return {
        success: true,
        date: targetDate,
        count: items.length,
        plan: items.map(i => ({
          time: i.time || 'flexible',
          task: i.task,
          priority: i.priority || 'medium',
          duration: i.duration || 30,
          completed: Boolean(i.completed)
        }))
      };
    }
  },

  {
    name: 'get_tasks',
    description: 'Get tasks from the database for a specific date, optionally filtered by completion status. Read-only.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Date string (YYYY-MM-DD, "today", or "tomorrow"). Defaults to today.'
        },
        completed: {
          type: 'BOOLEAN',
          description: 'Optional filter: true for completed only, false for incomplete only.'
        }
      }
    },
    handler: async (args, context) => {
      const targetDate = resolveTargetDate(args.date, context.todayDate);
      let sql = 'SELECT id, name, priority, time_slot, duration_min, completed, date FROM tasks WHERE date = ?';
      const params = [targetDate];
      if (typeof args.completed === 'boolean') {
        sql += ' AND completed = ?';
        params.push(args.completed ? 1 : 0);
      }
      sql += " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id ASC";
      const rows = db.prepare(sql).all(...params);
      return {
        success: true,
        date: targetDate,
        count: rows.length,
        tasks: rows.map(r => ({
          id: r.id,
          name: r.name,
          priority: r.priority,
          time_slot: r.time_slot,
          duration_min: r.duration_min,
          completed: Boolean(r.completed)
        }))
      };
    }
  },

  {
    name: 'get_goals',
    description: 'Retrieve goals with current progress, targets, deadlines, pace, and step checklists. Filter by status ("active", "paused", "completed", "overdue", "all"), category, or priority. Read-only.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: {
          type: 'STRING',
          description: 'Filter by goal status: "active", "paused", "completed", "overdue", or "all". Defaults to visible goals.'
        },
        category: {
          type: 'STRING',
          description: 'Optional category filter (e.g. Technical, DSA, College, Fitness).'
        },
        priority: {
          type: 'STRING',
          description: 'Optional priority filter: "high", "medium", or "low".'
        },
        limit: {
          type: 'INTEGER',
          description: 'Maximum number of goals to return.'
        }
      }
    },
    handler: async (args, context) => {
      const todayDate = context.todayDate || new Date();
      const activeDb = context.db || db;
      const goals = getAllGoals(todayDate, {
        status: args.status,
        category: args.category,
        priority: args.priority,
        limit: args.limit
      }, activeDb);

      return {
        success: true,
        count: goals.length,
        filter_status: args.status || 'visible',
        goals: goals.map(g => ({
          id: g.id,
          title: g.title,
          category: g.category,
          priority: g.priority,
          goal_type: g.goal_type,
          status: g.display_status || g.status,
          is_paused: Boolean(g.is_paused),
          progress: g.progress,
          target_text: g.target_text,
          current_count: g.current_count,
          target_count: g.target_count,
          per_week: g.per_week,
          deadline: g.deadline,
          days_left: g.days_left,
          is_overdue: g.is_overdue,
          expected_progress: g.expected_progress,
          behind_by: g.behind_by,
          steps: (g.steps || []).map(s => ({ id: s.id, text: s.step_text, done: Boolean(s.done) }))
        }))
      };
    }
  },

  {
    name: 'get_goal_details',
    description: 'Retrieve detailed information for a specific goal including step checklists, recent progress log entries, remaining target, and pace metrics. Read-only.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Goal title, keyword, or numeric goal ID.'
        }
      },
      required: ['goal_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.goal_identifier || '').trim();
      const { match: goal, ambiguous, candidates } = findMatchingGoal(q, null, activeDb);

      if (ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `Multiple goals match "${q}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Please specify which one you want.`
        };
      }
      if (!goal) {
        return { success: false, error: `Could not find any goal matching "${q}".` };
      }

      const todayDate = context.todayDate || new Date();
      const details = getGoalById(goal.id, todayDate, activeDb);
      if (!details) return { success: false, error: 'Failed to load goal details.' };

      return {
        success: true,
        goal: {
          id: details.id,
          title: details.title,
          category: details.category,
          priority: details.priority,
          goal_type: details.goal_type,
          status: details.display_status || details.status,
          is_paused: Boolean(details.is_paused),
          paused_at: details.paused_at,
          total_paused_days: details.total_paused_days || 0,
          progress: details.progress,
          current_count: details.current_count,
          target_count: details.target_count,
          per_week: details.per_week,
          target_text: details.target_text,
          deadline: details.deadline,
          days_left: details.days_left,
          is_overdue: details.is_overdue,
          expected_progress: details.expected_progress,
          behind_by: details.behind_by,
          steps: (details.steps || []).map(s => ({ id: s.id, text: s.step_text, done: Boolean(s.done) })),
          recent_logs: (details.recent_logs || []).map(l => ({
            id: l.id,
            date: l.date,
            amount: l.amount,
            note: l.note
          }))
        }
      };
    }
  },

  {
    name: 'create_goal',
    description: 'Create a new personal goal with optional target count/frequency, category, priority, deadline, and initial milestone steps.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: {
          type: 'STRING',
          description: 'Title or name of the goal (e.g. "Solve 320 LeetCode problems", "Learn German A2").'
        },
        target: {
          type: 'STRING',
          description: 'Target text, count, or frequency (e.g. "320 problems", "5 days/week", "100 km", "A2 level").'
        },
        category: {
          type: 'STRING',
          description: 'Category name (e.g. "Technical", "Fitness", "Academics", "Language"). Defaults to "General".'
        },
        priority: {
          type: 'STRING',
          description: 'Priority: "high", "medium", or "low". Defaults to "medium".'
        },
        deadline: {
          type: 'STRING',
          description: 'Target completion date in YYYY-MM-DD format.'
        },
        goal_type: {
          type: 'STRING',
          description: 'Optional type: "count" (problems/units), "frequency" (times per week), or "milestone" (checklist).'
        },
        steps: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Optional initial list of milestone step names.'
        }
      },
      required: ['title']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const todayStr = getTodayDate(context.todayDate);

      try {
        const goal = createGoal({
          title: args.title,
          target: args.target,
          category: args.category,
          priority: args.priority,
          deadline: args.deadline,
          goal_type: args.goal_type,
          steps: args.steps
        }, todayStr, activeDb);

        return {
          success: true,
          message: `Created goal "${goal.title}" (${goal.priority} priority${goal.deadline ? `, due ${goal.deadline}` : ''}).`,
          goal_id: goal.id,
          title: goal.title,
          category: goal.category,
          priority: goal.priority,
          goal_type: goal.goal_type,
          deadline: goal.deadline,
          steps_count: (goal.steps || []).length,
          updated: ['Goals', 'Dashboard']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'update_goal',
    description: 'Update metadata for an existing goal (title, target, deadline, priority, category) while strictly preserving existing progress and history.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Title, keyword, or ID of the goal to update.'
        },
        title: {
          type: 'STRING',
          description: 'New title/name for the goal.'
        },
        target: {
          type: 'STRING',
          description: 'New target text or number (e.g. "400 problems", "4 days/week").'
        },
        deadline: {
          type: 'STRING',
          description: 'New deadline in YYYY-MM-DD format.'
        },
        priority: {
          type: 'STRING',
          description: 'New priority: "high", "medium", or "low".'
        },
        category: {
          type: 'STRING',
          description: 'New category name.'
        }
      },
      required: ['goal_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.goal_identifier || '').trim();
      const { match: goal, ambiguous, candidates } = findMatchingGoal(q, null, activeDb);

      if (ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `Multiple goals match "${q}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Which one do you want to update?`
        };
      }
      if (!goal) {
        return { success: false, error: `Could not find any goal matching "${q}".` };
      }

      try {
        const res = updateGoal(goal.id, {
          title: args.title,
          target: args.target,
          deadline: args.deadline,
          priority: args.priority,
          category: args.category
        }, activeDb);

        return {
          success: true,
          goal_id: goal.id,
          message: `Updated goal "${res.goal.title}".`,
          updated_fields: res.updated_fields || [],
          goal: {
            id: res.goal.id,
            title: res.goal.title,
            priority: res.goal.priority,
            deadline: res.goal.deadline,
            target_text: res.goal.target_text,
            current_count: res.goal.current_count
          },
          updated: ['Goals', 'Dashboard']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'manage_goal_steps',
    description: 'Add, rename, delete (soft-delete), toggle completion, or list steps under a milestone goal.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Goal title, keyword, or ID.'
        },
        action: {
          type: 'STRING',
          description: 'Action to perform: "add", "rename", "delete", "toggle", or "list".'
        },
        step_text: {
          type: 'STRING',
          description: 'Step name to add, new text for rename, or text of step to delete/toggle.'
        },
        step_id: {
          type: 'INTEGER',
          description: 'Numeric ID of the step to rename, delete, or toggle.'
        },
        steps: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of step names to add simultaneously.'
        },
        done: {
          type: 'BOOLEAN',
          description: 'Completion status when toggling (true = complete, false = incomplete).'
        }
      },
      required: ['goal_identifier', 'action']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.goal_identifier || '').trim();
      const { match: goal, ambiguous, candidates } = findMatchingGoal(q, null, activeDb);

      if (ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `Multiple goals match "${q}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Please specify which goal you mean.`
        };
      }
      if (!goal) {
        return { success: false, error: `Could not find any goal matching "${q}".` };
      }

      try {
        const res = manageGoalSteps(goal.id, args.action, {
          step_text: args.step_text,
          step_id: args.step_id,
          steps: args.steps,
          done: args.done
        }, activeDb);

        return {
          ...res,
          updated: ['Goals', 'Dashboard']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'update_goal_status',
    description: 'Manage goal lifecycle: pause an active goal, resume a paused goal, mark complete, reopen a completed goal, or restore a previously removed goal.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Title, keyword, or ID of the goal.'
        },
        action: {
          type: 'STRING',
          description: 'Status action to perform: "pause", "resume", "complete", "reopen", or "restore".'
        },
        extend_deadline: {
          type: 'BOOLEAN',
          description: 'When resuming, whether to extend the deadline by the paused duration (default true).'
        }
      },
      required: ['goal_identifier', 'action']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.goal_identifier || '').trim();
      const act = (args.action || '').toLowerCase().trim();

      const pool = act === 'restore'
        ? activeDb.prepare("SELECT * FROM goals WHERE status = 'removed'").all()
        : activeDb.prepare("SELECT * FROM goals WHERE status != 'removed'").all();

      const { match: goal, ambiguous, candidates } = findMatchingGoal(q, pool, activeDb);

      if (ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `Multiple goals match "${q}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Which one do you mean?`
        };
      }
      if (!goal) {
        return { success: false, error: `Could not find any ${act === 'restore' ? 'removed ' : ''}goal matching "${q}".` };
      }

      const todayStr = getTodayDate(context.todayDate);

      try {
        const res = updateGoalStatus(goal.id, act, {
          extend_deadline: args.extend_deadline !== false
        }, todayStr, activeDb);

        return {
          ...res,
          updated: ['Goals', 'Dashboard', 'Night Summary']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'add_task',
    description: 'Create a new task scheduled for today or tomorrow. Respects priority, duration, and optional fixed start time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: {
          type: 'STRING',
          description: 'Clear name or title of the task to add.'
        },
        date: {
          type: 'STRING',
          description: 'Target date (YYYY-MM-DD, "today", or "tomorrow"). Defaults to today.'
        },
        priority: {
          type: 'STRING',
          description: 'Priority: "high", "medium", or "low". Defaults to "medium".'
        },
        duration_min: {
          type: 'INTEGER',
          description: 'Estimated duration in minutes (between 15 and 480). Defaults to 30.'
        },
        time_slot: {
          type: 'STRING',
          description: 'Optional fixed start time (e.g. "4:00 PM", "16:00", "9:30 AM").'
        },
        goal_identifier: {
          type: 'STRING',
          description: 'Optional title or keyword of an active goal to link this task with.'
        }
      },
      required: ['name']
    },
    handler: async (args, context) => {
      const name = (args.name || '').trim();
      if (!name) {
        return { success: false, error: 'Task name cannot be empty.' };
      }

      const priority = ['high', 'medium', 'low'].includes((args.priority || '').toLowerCase())
        ? args.priority.toLowerCase()
        : 'medium';

      let duration = parseInt(args.duration_min, 10);
      if (isNaN(duration) || duration < 15) duration = 30;
      if (duration > 480) duration = 480;

      const isBacklog = args.date && (String(args.date).toLowerCase() === 'backlog' || String(args.date).toLowerCase() === 'unscheduled');
      const targetDate = isBacklog ? null : resolveTargetDate(args.date, context.todayDate);

      let formattedTime = null;
      if (args.time_slot) {
        const mins = parseTimeToMinutes(args.time_slot);
        if (mins !== null) formattedTime = minutesToTimeString(mins);
      }

      // Check optional goal link
      let linkedGoalId = null;
      if (args.goal_identifier) {
        const { match } = findMatchingGoal(args.goal_identifier);
        if (match) linkedGoalId = match.id;
      }

      // Check conflict with effective timetable if fixed time provided
      if (formattedTime && targetDate) {
        const targetMins = parseTimeToMinutes(formattedTime);
        const taskEnd = targetMins + duration;
        const availabilityService = require('./availabilityService');
        const eff = availabilityService.getEffectiveTimetableForDate(targetDate, context.db || db);
        for (const block of eff.classes) {
          const bStart = parseTimeToMinutes(block.start_time);
          const bEnd = parseTimeToMinutes(block.end_time);
          if (bStart !== null && bEnd !== null) {
            if (Math.max(targetMins, bStart) < Math.min(taskEnd, bEnd)) {
              return {
                success: false,
                error: `Cannot schedule "${name}" at ${formattedTime}: conflicts with ${block.subject} (${block.start_time} - ${block.end_time}).`
              };
            }
          }
        }
      }

      // Insert task via centralized TaskService
      const createdTask = TaskService.createTask({
        name,
        priority,
        duration_min: duration,
        date: targetDate,
        time_slot: formattedTime,
        fixed_start: formattedTime,
        goal_id: linkedGoalId,
        source: 'chat'
      }, context.db || db);

      return {
        success: true,
        message: `Task "${createdTask.name}" added for ${createdTask.date || 'backlog'}${createdTask.time_slot && createdTask.time_slot !== 'Anytime' ? ` at ${createdTask.time_slot}` : ''} (${createdTask.priority} priority, ${createdTask.duration_min} min).`,
        task_id: createdTask.id,
        name: createdTask.name,
        date: createdTask.date,
        priority: createdTask.priority,
        duration_min: createdTask.duration_min,
        time_slot: createdTask.time_slot,
        updated: ['Day Plan', 'Dashboard']
      };
    }
  },

  {
    name: 'update_task',
    description: 'Reschedule or modify an existing task (change time slot, priority, duration, or date).',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_identifier: {
          type: 'STRING',
          description: 'Name, fragment, or ID of the task to update.'
        },
        time_slot: {
          type: 'STRING',
          description: 'New time slot (e.g. "4:00 PM", "5 PM").'
        },
        priority: {
          type: 'STRING',
          description: 'New priority: "high", "medium", or "low".'
        },
        duration_min: {
          type: 'INTEGER',
          description: 'New duration in minutes (15 to 480).'
        },
        date: {
          type: 'STRING',
          description: 'New date for the task.'
        }
      },
      required: ['task_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.task_identifier || '').trim();
      if (!q) return { success: false, error: 'Task identifier is required.' };

      const todayStr = getTodayDate(context.todayDate);
      // Find candidate tasks
      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = activeDb.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = activeDb.prepare(`
          SELECT * FROM tasks
          WHERE LOWER(name) LIKE ? AND completed = 0 AND (date >= ? OR date IS NULL)
          ORDER BY date ASC, id ASC
        `).all(`%${q.toLowerCase()}%`, todayStr);

        if (candidates.length === 0) {
          return { success: false, error: `No incomplete tasks found matching "${q}".` };
        }
        if (candidates.length > 1) {
          const titles = candidates.map(c => `"${c.name}" (${c.date})`).join(', ');
          return {
            success: false,
            ambiguous: true,
            error: `Multiple tasks match "${q}": ${titles}. Please specify which one you want to update.`
          };
        }
        matchedTask = candidates[0];
      }

      // Check conflict with timetable if time_slot changed
      let formattedTime = matchedTask.time_slot;
      if (args.time_slot) {
        const targetMins = parseTimeToMinutes(args.time_slot);
        if (targetMins === null) {
          return { success: false, error: `Could not parse time "${args.time_slot}". Try "4:00 PM" or "16:00".` };
        }
        formattedTime = minutesToTimeString(targetMins);

        // Check timetable conflict against effective schedule for task date
        const targetDay = args.date ? resolveTargetDate(args.date, context.todayDate) : matchedTask.date;
        if (targetDay) {
          const availabilityService = require('./availabilityService');
          const eff = availabilityService.getEffectiveTimetableForDate(targetDay, activeDb);
          const timetableBlocks = eff.classes || [];
          const taskEnd = targetMins + (args.duration_min || matchedTask.duration_min || 30);

          for (const block of timetableBlocks) {
            const bStart = parseTimeToMinutes(block.start_time);
            const bEnd = parseTimeToMinutes(block.end_time);
            if (bStart !== null && bEnd !== null) {
              if (Math.max(targetMins, bStart) < Math.min(taskEnd, bEnd)) {
                return {
                  success: false,
                  error: `Cannot reschedule "${matchedTask.name}" to ${formattedTime}: conflicts with ${block.subject} (${block.start_time} - ${block.end_time}).`
                };
              }
            }
          }
        }
      }

      let priority = matchedTask.priority;
      if (args.priority && ['high', 'medium', 'low'].includes(args.priority.toLowerCase())) {
        priority = args.priority.toLowerCase();
      }

      let duration = matchedTask.duration_min;
      if (args.duration_min && args.duration_min >= 15 && args.duration_min <= 480) {
        duration = args.duration_min;
      }

      let targetDate = matchedTask.date;
      if (args.date) {
        targetDate = resolveTargetDate(args.date, context.todayDate);
      }

      // Perform update via TaskService
      TaskService.updateTask(matchedTask.id, {
        time_slot: formattedTime,
        fixed_start: formattedTime,
        priority,
        duration_min: duration,
        date: targetDate
      }, context.db || db);

      return {
        success: true,
        message: `Updated "${matchedTask.name}" to ${formattedTime || 'flexible'} (${priority} priority).`,
        task_id: matchedTask.id,
        updated: ['Day Plan', 'Dashboard']
      };
    }
  },

  {
    name: 'complete_task',
    description: 'Mark a task as completed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_identifier: {
          type: 'STRING',
          description: 'Name, fragment, or ID of the task to mark completed.'
        },
        date: {
          type: 'STRING',
          description: 'Optional date of the task. Defaults to today.'
        }
      },
      required: ['task_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.task_identifier || '').trim();
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = activeDb.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = activeDb.prepare(`
          SELECT * FROM tasks
          WHERE LOWER(name) LIKE ? AND date = ?
        `).all(`%${q.toLowerCase()}%`, targetDate);

        if (candidates.length === 0) {
          // Check if q matches a goal and that goal has an incomplete task for targetDate
          const { match: matchedGoal } = findMatchingGoal(q, activeDb.prepare("SELECT * FROM goals WHERE status != 'removed'").all(), activeDb);
          if (matchedGoal) {
            const goalTask = activeDb.prepare(`
              SELECT * FROM tasks WHERE goal_id = ? AND date = ? AND completed = 0 ORDER BY id ASC LIMIT 1
            `).get(matchedGoal.id, targetDate);
            if (goalTask) matchedTask = goalTask;
          }

          // Check day_plans for targetDate
          if (!matchedTask) {
            const planRow = activeDb.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(targetDate);
            if (planRow && planRow.plan_json) {
              try {
                const plan = JSON.parse(planRow.plan_json);
                const matchedItem = plan.find(i => (i.task || '').toLowerCase().includes(q.toLowerCase()));
                if (matchedItem && matchedItem.task_id) {
                  matchedTask = activeDb.prepare('SELECT * FROM tasks WHERE id = ?').get(matchedItem.task_id);
                }
              } catch (_) {}
            }
          }

          if (!matchedTask) {
            const fallbackCandidates = activeDb.prepare(`
              SELECT * FROM tasks
              WHERE LOWER(name) LIKE ? AND completed = 0
              ORDER BY date DESC, id DESC
            `).all(`%${q.toLowerCase()}%`);
            if (fallbackCandidates.length === 1) {
              matchedTask = fallbackCandidates[0];
            } else if (fallbackCandidates.length > 1) {
              return {
                success: false,
                ambiguous: true,
                error: `Multiple tasks match "${q}". Please specify which one.`
              };
            } else {
              return { success: false, error: `No tasks found matching "${q}" for ${targetDate}.` };
            }
          }
        }
        if (candidates.length > 1) {
          // If multiple, prefer incomplete one
          const incomplete = candidates.filter(c => c.completed === 0);
          if (incomplete.length === 1) matchedTask = incomplete[0];
          else {
            return {
              success: false,
              ambiguous: true,
              error: `Multiple tasks match "${q}". Please specify which one.`
            };
          }
        } else if (!matchedTask && candidates.length === 1) {
          matchedTask = candidates[0];
        }
      }

      if (matchedTask.completed === 1) {
        return { success: true, message: `Task "${matchedTask.name}" was already completed.`, task_id: matchedTask.id };
      }

      // Mark complete via TaskService (atomic with goal consistency & day plan)
      TaskService.completeTask(matchedTask.id, 1, context.todayDate, context.db || db);

      return {
        success: true,
        message: `Done! Marked "${matchedTask.name}" as completed.`,
        task_id: matchedTask.id,
        updated: ['Day Plan', 'Goals', 'Dashboard']
      };
    }
  },

  {
    name: 'uncomplete_task',
    description: 'Reopen or unmark a task as not completed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_identifier: {
          type: 'STRING',
          description: 'Name, fragment, or ID of the task to reopen.'
        },
        date: {
          type: 'STRING',
          description: 'Optional date. Defaults to today.'
        }
      },
      required: ['task_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.task_identifier || '').trim();
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = activeDb.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = activeDb.prepare(`
          SELECT * FROM tasks 
          WHERE LOWER(name) LIKE ? AND date = ?
        `).all(`%${q.toLowerCase()}%`, targetDate);

        if (candidates.length === 0) {
          const fallback = activeDb.prepare(`
            SELECT * FROM tasks 
            WHERE LOWER(name) LIKE ? AND completed = 1 
            ORDER BY date DESC, id DESC LIMIT 1
          `).get(`%${q.toLowerCase()}%`);
          if (fallback) matchedTask = fallback;
          else return { success: false, error: `No tasks found matching "${q}".` };
        } else {
          const completed = candidates.filter(c => c.completed === 1);
          if (completed.length === 1) matchedTask = completed[0];
          else matchedTask = candidates[0];
        }
      }

      // Mark incomplete via TaskService (atomic reversal & day plan)
      TaskService.completeTask(matchedTask.id, 0, context.todayDate, activeDb);

      return {
        success: true,
        message: `Reopened "${matchedTask.name}".`,
        task_id: matchedTask.id,
        updated: ['Day Plan', 'Goals', 'Dashboard']
      };
    }
  },

  {
    name: 'log_goal_progress',
    description: 'Log newly completed units/problems for a count goal, 1 session for a frequency goal, or practice session for a milestone goal. Supports optional historical date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Goal title, keyword (e.g. "LeetCode", "DSA", "Daily run", "German"), or goal ID.'
        },
        amount: {
          type: 'INTEGER',
          description: 'Number of units/problems or sessions completed (default 1).'
        },
        unit: {
          type: 'STRING',
          description: 'Optional unit label (e.g. "problems", "session", "km", "minutes").'
        },
        date: {
          type: 'STRING',
          description: 'Date string: "today", "yesterday", or YYYY-MM-DD. Defaults to today in Asia/Kolkata.'
        },
        note: {
          type: 'STRING',
          description: 'Optional audit note (e.g. "5 km", "BFS topic").'
        }
      },
      required: ['goal_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const q = (args.goal_identifier || '').trim();
      const activeGoals = activeDb.prepare("SELECT * FROM goals WHERE status != 'removed'").all();
      const { match: goal, ambiguous, candidates } = findMatchingGoal(q, activeGoals, activeDb);

      if (ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `Multiple goals match "${q}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Please specify which goal you worked on.`
        };
      }
      if (!goal) {
        return { success: false, error: `Could not find an active goal matching "${q}".` };
      }

      const todayStr = getTodayDate(context.todayDate);
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let effectiveNote = args.note || (args.unit ? `${args.amount || 1} ${args.unit}` : null);
      if (goal.goal_type === 'frequency' && args.unit && args.unit.toLowerCase().includes('km')) {
        effectiveNote = `${args.amount || 1} km`;
      }

      let msgIdNum = null;
      if (typeof context.messageId === 'number') msgIdNum = context.messageId;
      else if (typeof context.messageId === 'string') {
        const digits = context.messageId.replace(/\D/g, '');
        if (digits) msgIdNum = parseInt(digits.slice(-9), 10);
      }

      try {
        const res = logGoalProgress(goal.id, {
          amount: args.amount,
          date: targetDate,
          note: effectiveNote,
          chat_message_id: msgIdNum
        }, todayStr, activeDb);

        // Also check if today's day plan has an incomplete scheduled task for this goal
        let dayPlanTaskCompleted = false;
        const matchingTodayTask = activeDb.prepare(`
          SELECT id, name FROM tasks 
          WHERE goal_id = ? AND date = ? AND completed = 0 
          ORDER BY id ASC LIMIT 1
        `).get(goal.id, targetDate);

        if (matchingTodayTask) {
          TaskService.completeTask(matchingTodayTask.id, 1, context.todayDate, activeDb);
          dayPlanTaskCompleted = true;
        }

        return {
          ...res,
          day_plan_task_completed: dayPlanTaskCompleted,
          updated: ['Goals', 'Dashboard', 'Night Summary', 'Day Plan']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'correct_goal_progress',
    description: 'Correct a previously reported goal count (e.g. "actually I solved 1, not 3"). Appends a compensating adjustment ledger row without modifying or deleting original records.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Title, keyword, or ID of the goal being corrected.'
        },
        correct_amount: {
          type: 'INTEGER',
          description: 'The actual/corrected total amount of work completed (must be >= 0).'
        },
        entry_id: {
          type: 'INTEGER',
          description: 'Optional ID of the specific progress log entry to adjust.'
        },
        reason: {
          type: 'STRING',
          description: 'Optional note explaining the correction.'
        }
      },
      required: ['correct_amount']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      let goal = null;
      if (args.goal_identifier) {
        const { match, ambiguous, candidates } = findMatchingGoal(args.goal_identifier, null, activeDb);
        if (ambiguous) {
          return {
            success: false,
            ambiguous: true,
            error: `Multiple goals match "${args.goal_identifier}": ${candidates.map(c => `"${c.title}"`).join(', ')}. Which one are you correcting?`
          };
        }
        goal = match;
      }

      if (!goal) {
        const lastLog = activeDb.prepare(`
          SELECT g.* FROM goal_progress_log l
          JOIN goals g ON l.goal_id = g.id
          WHERE g.goal_type = 'count' AND g.status != 'removed'
          ORDER BY l.id DESC LIMIT 1
        `).get();
        if (lastLog) goal = lastLog;
      }

      if (!goal) {
        return { success: false, error: 'Could not determine which goal to correct. Please specify the goal name.' };
      }

      const todayStr = getTodayDate(context.todayDate);

      let msgIdNum = null;
      if (typeof context.messageId === 'number') msgIdNum = context.messageId;
      else if (typeof context.messageId === 'string') {
        const digits = context.messageId.replace(/\D/g, '');
        if (digits) msgIdNum = parseInt(digits.slice(-9), 10);
      }

      try {
        const res = correctGoalProgress(goal.id, {
          correct_amount: args.correct_amount,
          entry_id: args.entry_id,
          reason: args.reason,
          chat_message_id: msgIdNum
        }, todayStr, activeDb);

        return {
          ...res,
          updated: ['Goals', 'Dashboard', 'Night Summary']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'complete_goal_step',
    description: 'Mark a specific named milestone step as completed under a goal (e.g. BFS under Trees).',
    parameters: {
      type: 'OBJECT',
      properties: {
        step_identifier: {
          type: 'STRING',
          description: 'Name of the step (e.g. "BFS", "DFS", "Services") or 1-based step index.'
        },
        goal_identifier: {
          type: 'STRING',
          description: 'Optional goal title or keyword to narrow down search.'
        }
      },
      required: ['step_identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const stepQuery = (args.step_identifier || '').trim().toLowerCase();
      if (!stepQuery) return { success: false, error: 'Step identifier is required.' };

      let stepsQuery = `
        SELECT s.id AS step_id, s.step_text, s.done, g.id AS goal_id, g.title AS goal_title, g.status AS goal_status
        FROM goal_steps s
        JOIN goals g ON s.goal_id = g.id
        WHERE g.status != 'removed' AND (s.is_deleted IS NULL OR s.is_deleted = 0)
      `;
      const steps = activeDb.prepare(stepsQuery).all();

      const matched = steps.filter(s => {
        const text = (s.step_text || '').toLowerCase();
        if (args.goal_identifier) {
          const gTitle = (s.goal_title || '').toLowerCase();
          if (!gTitle.includes(args.goal_identifier.toLowerCase())) return false;
        }
        return text === stepQuery || text.includes(stepQuery) || stepQuery.includes(text);
      });

      if (matched.length === 0) {
        return { success: false, error: `No goal step found matching "${args.step_identifier}".` };
      }
      if (matched.length > 1) {
        const titles = matched.map(m => `"${m.step_text}" under "${m.goal_title}"`).join(', ');
        return {
          success: false,
          ambiguous: true,
          error: `Multiple steps match "${args.step_identifier}": ${titles}. Please specify which goal you mean.`
        };
      }

      const target = matched[0];
      const cleanGoalTitle = target.goal_title.replace(/\s+topic$/i, '').trim() || target.goal_title;

      if (target.done === 1) {
        return {
          success: true,
          message: `${target.step_text} is already marked complete under ${cleanGoalTitle}.`,
          step_id: target.step_id,
          already_completed: true
        };
      }

      try {
        const res = manageGoalSteps(target.goal_id, 'complete', { step_id: target.step_id }, activeDb);
        return {
          success: true,
          message: `Done! ${target.step_text} is marked complete under ${cleanGoalTitle}.`,
          step_id: target.step_id,
          goal_id: target.goal_id,
          updated: ['Goals', 'Dashboard']
        };
      } catch (err) {
        return { success: false, error: err.error || err.message };
      }
    }
  },

  {
    name: 'set_window',
    description: 'Set available working time or window end time for today or a specific date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        available_minutes: {
          type: 'INTEGER',
          description: 'Total available free minutes (between 15 and 960 minutes).'
        },
        window_end_time: {
          type: 'STRING',
          description: 'Time string user is available until (e.g. "9:00 PM", "21:00").'
        },
        done_for_day: {
          type: 'BOOLEAN',
          description: 'True if user has finished work/study for the day.'
        },
        date: {
          type: 'STRING',
          description: 'Date string. Defaults to today.'
        }
      }
    },
    handler: async (args, context) => {
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let avail = args.available_minutes ? parseInt(args.available_minutes, 10) : null;
      if (avail !== null && (avail < 15 || avail > 960)) {
        return { success: false, error: 'Available minutes must be between 15 and 960.' };
      }

      let endMins = null;
      if (args.window_end_time) {
        endMins = parseTimeToMinutes(args.window_end_time);
      }

      const doneForDay = args.done_for_day ? 1 : 0;

      db.prepare(`
        INSERT INTO daily_settings (date, available_minutes, window_end_minutes, done_for_day)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          available_minutes = COALESCE(?, available_minutes),
          window_end_minutes = COALESCE(?, window_end_minutes),
          done_for_day = CASE WHEN ? = 1 THEN 1 ELSE done_for_day END
      `).run(targetDate, avail, endMins, doneForDay, avail, endMins, doneForDay);

      let msg = '';
      if (doneForDay === 1) {
        msg = `Noted! You're done for today. Enjoy your rest!`;
      } else if (avail) {
        const hrs = (avail / 60).toFixed(1).replace('.0', '');
        msg = `Set available time to ${avail} minutes (${hrs}h) for ${targetDate}.`;
      } else if (endMins !== null) {
        msg = `Set active window until ${minutesToTimeString(endMins)} for ${targetDate}.`;
      } else {
        msg = `Updated window settings for ${targetDate}.`;
      }

      return {
        success: true,
        message: msg,
        available_minutes: avail,
        window_end_minutes: endMins,
        done_for_day: Boolean(doneForDay),
        updated: ['Day Plan']
      };
    }
  },

  {
    name: 'replan_today',
    description: 'Report an unexpected event, urgent meeting, disruption, or trigger automatic replanning of today\'s remaining tasks within available time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'The unexpected event or reason (e.g. "unexpected meeting at 4 PM", "urgent doctor appointment at 3 PM for 1 hour").'
        }
      },
      required: ['reason']
    },
    handler: async (args, context) => {
      const reason = args.reason || 'Unexpected event reported';
      try {
        const result = await replan(reason, context.nowDate || new Date());
        return {
          success: true,
          message: `Replanned today's schedule around "${reason}" (${result ? result.count : 0} item(s) in timeline).`,
          plan: result ? result.plan : [],
          updated: ['Day Plan', 'Dashboard']
        };
      } catch (err) {
        return { success: false, error: `Replanning failed: ${err.message}` };
      }
    }
  },

  {
    name: 'ask_user',
    description: 'Ask the user a short, direct clarification question when details are missing or ambiguous. Makes ZERO database changes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        question: {
          type: 'STRING',
          description: 'Short clarification question to display to the user.'
        }
      },
      required: ['question']
    },
    handler: async (args) => {
      return {
        success: true,
        clarification_needed: true,
        message: args.question
      };
    }
  },

  {
    name: 'request_removal',
    description: 'Initiate a request to delete or remove a task or goal. Requires user confirmation before performing actual deletion.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: {
          type: 'STRING',
          description: 'Type of item to remove: "task" or "goal".'
        },
        identifier: {
          type: 'STRING',
          description: 'Title, name, or ID of the task or goal.'
        }
      },
      required: ['type', 'identifier']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const type = (args.type || '').toLowerCase();
      if (!['task', 'goal'].includes(type)) {
        return { success: false, error: 'Type must be "task" or "goal".' };
      }

      const q = (args.identifier || '').trim();
      const todayStr = getTodayDate(context.todayDate);

      let target = null;
      if (type === 'goal') {
        const activeGoals = activeDb.prepare("SELECT id, title FROM goals WHERE status = 'active'").all();
        if (/^(?:all\s+my\s+goals|all\s+goals|all)$/i.test(q)) {
          if (activeGoals.length === 0) return { success: false, error: 'No active goals found to remove.' };
          const targetIds = activeGoals.map(g => g.id);
          const goalListDesc = activeGoals.map(g => `"${g.title}" (ID: ${g.id})`).join(', ');
          setPendingState({
            type: 'removal',
            removalType: 'goal',
            targetId: targetIds[0],
            targetIds,
            targetTitle: `all active goals [${goalListDesc}]`,
            todayStr,
            expiresAt: Date.now() + 2 * 60 * 1000
          });
          return {
            success: true,
            pending_confirmation: true,
            message: `Remove all ${activeGoals.length} active goals (${goalListDesc})? Reply yes to confirm (or no to cancel). This expires in 2 minutes.`,
            target_ids: targetIds,
            target_titles: activeGoals.map(g => g.title)
          };
        }
        const { match, ambiguous, candidates } = findMatchingGoal(q, activeGoals);
        if (ambiguous) {
          const titles = candidates.map(c => `"${c.title}"`).join(' or ');
          return { success: false, ambiguous: true, error: `Multiple goals match "${q}": ${titles}. Please specify which one.` };
        }
        if (!match) return { success: false, error: `No active goal found matching "${q}".` };
        target = { id: match.id, targetIds: [match.id], title: match.title };
      } else {
        const cleanQ = q.replace(/\b(?:task|item|assignment|session)\b/gi, '').trim();
        const searchTerm = cleanQ.length > 0 ? cleanQ : q;
        const rows = activeDb.prepare('SELECT id, name FROM tasks WHERE LOWER(name) LIKE ? AND date >= ? AND completed = 0').all(`%${searchTerm.toLowerCase()}%`, todayStr);
        if (rows.length === 0) {
          // Check day_plans for today
          const planRow = activeDb.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(todayStr);
          if (planRow && planRow.plan_json) {
            try {
              const plan = JSON.parse(planRow.plan_json);
              const matchedPlanItem = plan.find(i => (i.task || '').toLowerCase().includes(searchTerm.toLowerCase()));
              if (matchedPlanItem) {
                target = {
                  id: matchedPlanItem.task_id || 0,
                  targetIds: matchedPlanItem.task_id ? [matchedPlanItem.task_id] : [],
                  title: matchedPlanItem.task,
                  isPlanItem: true
                };
              }
            } catch (_) {}
          }
          if (!target) return { success: false, error: `No incomplete tasks or plan items found matching "${q}".` };
        } else {
          const uniqueTitles = [...new Set(rows.map(r => r.name.trim()))];
          if (uniqueTitles.length > 1) {
            return { success: false, ambiguous: true, error: `Multiple tasks match "${q}": ${uniqueTitles.map(t => `"${t}"`).join(', ')}. Please specify which one you want to delete.` };
          }
          target = { id: rows[0].id, targetIds: rows.map(r => r.id), title: rows[0].name };
        }
      }

      // Store pending removal state (2 minutes)
      setPendingState({
        type: 'removal',
        removalType: target.isPlanItem ? 'plan_item' : type,
        targetId: target.id,
        targetIds: target.targetIds || [target.id],
        targetTaskId: target.id || null,
        targetTitle: target.title,
        todayStr,
        expiresAt: Date.now() + 2 * 60 * 1000
      });

      return {
        success: true,
        pending_confirmation: true,
        message: `Remove ${target.isPlanItem ? 'plan item' : type} "${target.title}"? Reply yes to confirm (or no to cancel). This expires in 2 minutes.`,
        target_id: target.id,
        target_title: target.title
      };
    }
  },

  {
    name: 'get_free_slots',
    description: 'Calculate and return available / free time slots for a specific date (e.g. "today", "tomorrow", or "YYYY-MM-DD") based on timetable and scheduled tasks.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Date string: "today", "tomorrow", or YYYY-MM-DD. Defaults to today.'
        }
      }
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const targetDate = resolveTargetDate(args.date, context.todayDate);
      const availabilityService = require('./availabilityService');
      const avail = availabilityService.calculateFreeSlots(targetDate, {}, activeDb);

      let summary = `Free slots for ${avail.day_of_week} (${avail.date}):\n`;
      if (avail.free_slots.length === 0) {
        summary += 'No free time slots available within your scheduled window.';
      } else {
        avail.free_slots.forEach(f => {
          summary += `• ${f.start_time}–${f.end_time} (${f.duration_min} min free)\n`;
        });
        summary += `Total available time: ${avail.total_free_hours} hours (${avail.total_free_minutes} min).`;
      }

      return {
        success: true,
        date: targetDate,
        day_of_week: avail.day_of_week,
        total_free_hours: avail.total_free_hours,
        total_free_minutes: avail.total_free_minutes,
        free_slots: avail.free_slots,
        committed_blocks: avail.committed_blocks,
        message: summary.trim()
      };
    }
  },

  {
    name: 'get_weekly_availability',
    description: 'Get weekly free hours and availability summary across 7 days starting from a given date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: {
          type: 'STRING',
          description: 'Start date: "today" or YYYY-MM-DD. Defaults to today.'
        }
      }
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const targetDate = resolveTargetDate(args.start_date, context.todayDate);
      const availabilityService = require('./availabilityService');
      const summary = availabilityService.getWeeklyAvailabilitySummary(targetDate, activeDb);

      let msg = `Weekly Availability Summary (7 days starting ${targetDate}):\n`;
      msg += `Total Free Time: ${summary.total_free_hours} hours (Committed: ${summary.total_committed_hours} hours)\n\n`;
      summary.days.forEach(d => {
        msg += `• ${d.day_of_week} (${d.date}): ${d.free_hours} hrs free (${d.classes_count} classes scheduled)\n`;
      });

      return {
        success: true,
        start_date: targetDate,
        total_free_hours: summary.total_free_hours,
        total_committed_hours: summary.total_committed_hours,
        days: summary.days,
        message: msg.trim()
      };
    }
  },

  {
    name: 'cancel_classes_for_date',
    description: 'Record a one-day cancellation for all classes or a specific lecture without altering the permanent recurring timetable.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Date of cancellation: "today", "tomorrow", or YYYY-MM-DD.'
        },
        subject: {
          type: 'STRING',
          description: 'Optional subject name if only cancelling a single lecture (e.g. "Operating Systems"). Omit to cancel all classes.'
        },
        reason: {
          type: 'STRING',
          description: 'Optional reason or note (e.g. "Holiday", "Professor absent").'
        }
      }
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const targetDate = resolveTargetDate(args.date, context.todayDate);
      const availabilityService = require('./availabilityService');

      let res;
      if (args.subject && args.subject.trim()) {
        res = availabilityService.cancelSingleClass(targetDate, args.subject.trim(), activeDb);
      } else {
        res = availabilityService.cancelClassesForDate(targetDate, args.reason || 'Cancelled via Chat', activeDb);
      }

      return {
        ...res,
        updated: ['timetable', 'plan', 'Dashboard']
      };
    }
  },

  {
    name: 'add_extra_class',
    description: 'Add an extra lecture or one-day temporary timetable commitment for a specific date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Date for the extra class ("today", "tomorrow", or YYYY-MM-DD).'
        },
        subject: {
          type: 'STRING',
          description: 'Subject or lecture title (e.g. "Practical Lab", "Extra Math").'
        },
        start_time: {
          type: 'STRING',
          description: 'Start time (e.g. "2:00 PM" or "14:00").'
        },
        end_time: {
          type: 'STRING',
          description: 'End time (e.g. "4:00 PM" or "16:00").'
        },
        location: {
          type: 'STRING',
          description: 'Optional classroom or lab.'
        }
      },
      required: ['subject', 'start_time', 'end_time']
    },
    handler: async (args, context) => {
      const activeDb = context.db || db;
      const targetDate = resolveTargetDate(args.date, context.todayDate);
      const availabilityService = require('./availabilityService');

      const res = availabilityService.addExtraClass(targetDate, {
        subject: args.subject.trim(),
        start_time: args.start_time.trim(),
        end_time: args.end_time.trim(),
        location: args.location || null
      }, activeDb);

      return {
        ...res,
        updated: ['timetable', 'plan', 'Dashboard']
      };
    }
  }
];

// Helper to get tool by name
function getToolByName(name) {
  return TOOLS.find(t => t.name === name) || null;
}

// Convert tools to Gemini API function declarations format
function getGeminiFunctionDeclarations() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }));
}

// Convert schema types recursively to lowercase for OpenAI / Groq standard JSON Schema
function normalizeSchemaType(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(s => normalizeSchemaType(s));
  const normalized = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === 'type' && typeof val === 'string') {
      normalized.type = val.toLowerCase();
    } else if (key === 'properties' && typeof val === 'object' && val !== null) {
      const props = {};
      const reqs = schema.required || [];
      for (const [propName, propDef] of Object.entries(val)) {
        const normProp = normalizeSchemaType(propDef);
        // If not in required list and type is a single string (not array or object), allow null for resilient model compatibility
        if (!reqs.includes(propName) && typeof normProp.type === 'string' && normProp.type !== 'object' && normProp.type !== 'array') {
          normProp.type = [normProp.type, 'null'];
        }
        props[propName] = normProp;
      }
      normalized.properties = props;
    } else if (typeof val === 'object' && val !== null) {
      normalized[key] = normalizeSchemaType(val);
    } else {
      normalized[key] = val;
    }
  }
  return normalized;
}

// Convert tools to OpenAI / Groq API tool definitions format
function getOpenAIToolDefinitions() {
  return TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: normalizeSchemaType(t.parameters)
    }
  }));
}

module.exports = {
  TOOLS,
  getToolByName,
  getGeminiFunctionDeclarations,
  getOpenAIToolDefinitions,
  resolveTargetDate
};

