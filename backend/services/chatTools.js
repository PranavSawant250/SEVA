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
const { getAllGoals, computeGoalProgress } = require('./goalsService');
const { replan } = require('./plannerService');
const { findMatchingGoal } = require('./actionEngine');
const { getPendingState, setPendingState, clearPending } = require('./chatCommands');

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
      sql += ' ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 ELSE 3 END, id ASC';
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
    description: 'Retrieve all active goals with current progress, target, expected progress, behind-by percentage, and milestone steps. Read-only.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: {
          type: 'STRING',
          description: 'Optional category filter (e.g. Technical, DSA, College).'
        }
      }
    },
    handler: async (args, context) => {
      const goals = getAllGoals(context.todayDate);
      let filtered = goals.filter(g => g.status === 'active');
      if (args.category) {
        const cat = args.category.toLowerCase().trim();
        filtered = filtered.filter(g => (g.category || '').toLowerCase().includes(cat));
      }
      return {
        success: true,
        count: filtered.length,
        goals: filtered.map(g => ({
          id: g.id,
          title: g.title,
          category: g.category,
          priority: g.priority,
          goal_type: g.goal_type,
          progress: g.progress,
          expected_progress: g.expected_progress,
          behind_by: g.behind_by,
          days_left: g.days_left,
          current_count: g.current_count,
          target_count: g.target_count,
          steps: (g.steps || []).map(s => ({ id: s.id, text: s.step_text, done: Boolean(s.done) }))
        }))
      };
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

      const targetDate = resolveTargetDate(args.date, context.todayDate);

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

      // Insert task deterministically
      const res = db.prepare(`
        INSERT INTO tasks (name, priority, source, completed, date, duration_min, time_slot, goal_id)
        VALUES (?, ?, 'chat', 0, ?, ?, ?, ?)
      `).run(name, priority, targetDate, duration, formattedTime, linkedGoalId);

      const taskId = res.lastInsertRowid;

      // Sync Day Plan if target date matches today
      const todayStr = getTodayDate(context.todayDate);
      if (targetDate === todayStr) {
        const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
        if (planRow && planRow.plan_json) {
          try {
            const plan = JSON.parse(planRow.plan_json);
            plan.push({
              task_id: taskId,
              task: name,
              priority,
              duration,
              time: formattedTime || 'flexible',
              completed: 0,
              source: 'chat'
            });
            db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
          } catch (_) {}
        }
      }

      return {
        success: true,
        message: `Task "${name}" added for ${targetDate}${formattedTime ? ` at ${formattedTime}` : ''} (${priority} priority, ${duration} min).`,
        task_id: taskId,
        name,
        date: targetDate,
        priority,
        duration_min: duration,
        time_slot: formattedTime,
        updated: ['Day Plan']
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
      const q = (args.task_identifier || '').trim();
      if (!q) return { success: false, error: 'Task identifier is required.' };

      const todayStr = getTodayDate(context.todayDate);
      // Find candidate tasks
      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = db.prepare(`
          SELECT * FROM tasks
          WHERE LOWER(name) LIKE ? AND completed = 0 AND date >= ?
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

        // Check timetable conflict
        const taskDateObj = new Date(matchedTask.date + 'T00:00:00');
        const weekday = taskDateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const timetableBlocks = db.prepare('SELECT subject, start_time, end_time FROM timetable WHERE day_of_week = ?').all(weekday);
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

      // Perform update
      db.prepare(`
        UPDATE tasks
        SET time_slot = ?, priority = ?, duration_min = ?, date = ?
        WHERE id = ?
      `).run(formattedTime, priority, duration, targetDate, matchedTask.id);

      // Sync Day Plan
      const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(targetDate);
      if (planRow && planRow.plan_json) {
        try {
          const plan = JSON.parse(planRow.plan_json);
          for (const item of plan) {
            if (item.task_id === matchedTask.id || (item.task && item.task.toLowerCase() === matchedTask.name.toLowerCase())) {
              item.time = formattedTime;
              item.priority = priority;
              item.duration = duration;
            }
          }
          db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
        } catch (_) {}
      }

      return {
        success: true,
        message: `Updated "${matchedTask.name}" to ${formattedTime || 'flexible'} (${priority} priority).`,
        task_id: matchedTask.id,
        updated: ['Day Plan']
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
      const q = (args.task_identifier || '').trim();
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = db.prepare(`
          SELECT * FROM tasks
          WHERE LOWER(name) LIKE ? AND date = ?
        `).all(`%${q.toLowerCase()}%`, targetDate);

        if (candidates.length === 0) {
          return { success: false, error: `No tasks found matching "${q}" for ${targetDate}.` };
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
        } else {
          matchedTask = candidates[0];
        }
      }

      if (matchedTask.completed === 1) {
        return { success: true, message: `Task "${matchedTask.name}" was already completed.`, task_id: matchedTask.id };
      }

      db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(matchedTask.id);

      // Sync Day Plan
      const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(targetDate);
      if (planRow && planRow.plan_json) {
        try {
          const plan = JSON.parse(planRow.plan_json);
          for (const item of plan) {
            if (item.task_id === matchedTask.id || (item.task && item.task.toLowerCase() === matchedTask.name.toLowerCase())) {
              item.completed = 1;
            }
          }
          db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
        } catch (_) {}
      }

      return {
        success: true,
        message: `Done! Marked "${matchedTask.name}" as completed.`,
        task_id: matchedTask.id,
        updated: ['Day Plan', 'Goals']
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
      const q = (args.task_identifier || '').trim();
      const targetDate = resolveTargetDate(args.date, context.todayDate);

      let matchedTask = null;
      if (/^\d+$/.test(q)) {
        matchedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(q, 10));
      }
      if (!matchedTask) {
        const candidates = db.prepare('SELECT * FROM tasks WHERE LOWER(name) LIKE ? AND date = ?').all(`%${q.toLowerCase()}%`, targetDate);
        if (candidates.length === 0) return { success: false, error: `No tasks found matching "${q}".` };
        matchedTask = candidates[0];
      }

      db.prepare('UPDATE tasks SET completed = 0 WHERE id = ?').run(matchedTask.id);

      // Sync Day Plan
      const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(targetDate);
      if (planRow && planRow.plan_json) {
        try {
          const plan = JSON.parse(planRow.plan_json);
          for (const item of plan) {
            if (item.task_id === matchedTask.id || item.task === matchedTask.name) {
              item.completed = 0;
            }
          }
          db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
        } catch (_) {}
      }

      return {
        success: true,
        message: `Reopened "${matchedTask.name}".`,
        task_id: matchedTask.id,
        updated: ['Day Plan']
      };
    }
  },

  {
    name: 'log_goal_progress',
    description: 'Log newly completed problems or units for a count goal (e.g. solved 2 DSA problems), or 1 session for a frequency goal (e.g. ran today, 5km run). For frequency goals like running, 1 run counts as 1 session regardless of distance.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Goal title, keyword (e.g. "LeetCode", "DSA", "Daily run", "run"), or goal ID.'
        },
        amount: {
          type: 'INTEGER',
          description: 'Number of units/problems or sessions completed (default 1 for frequency goals like running).'
        },
        note: {
          type: 'STRING',
          description: 'Optional audit note (e.g. "5 km").'
        }
      },
      required: ['goal_identifier']
    },
    handler: async (args, context) => {
      let amount = parseInt(args.amount, 10);
      if (isNaN(amount) || amount <= 0) {
        amount = 1;
      }

      const q = (args.goal_identifier || '').trim();
      const { match: goal, ambiguous, candidates } = findMatchingGoal(q);

      if (ambiguous) {
        const titles = candidates.map(c => `"${c.title}"`).join(' or ');
        return {
          success: false,
          ambiguous: true,
          error: `Did you mean ${titles}? Please specify which goal you worked on.`
        };
      }

      if (!goal) {
        return { success: false, error: `Could not find an active goal matching "${q}".` };
      }

      const todayStr = getTodayDate(context.todayDate);
      const isFrequency = goal.goal_type === 'frequency';

      // For frequency goals, amount is strictly the number of sessions (1 per run), not distance
      let effectiveAmount = amount;
      let auditNote = args.note || 'agent:log_goal_progress';
      if (isFrequency) {
        effectiveAmount = 1;
        if (amount > 1 && (!args.note || args.note === 'agent:log_goal_progress')) {
          auditNote = `${amount} km`;
        } else if (args.note && !auditNote.includes('km') && amount > 1) {
          auditNote = `${amount} km - ${args.note}`;
        }
      }

      const currentCount = goal.current_count || 0;
      const targetCount = isFrequency ? (goal.per_week || 5) : (goal.target_count || 1);
      const newCount = currentCount + effectiveAmount;
      const reached = newCount >= targetCount;

      let msgIdNum = null;
      if (typeof context.messageId === 'number') msgIdNum = context.messageId;
      else if (typeof context.messageId === 'string') {
        const digits = context.messageId.replace(/\D/g, '');
        if (digits) msgIdNum = parseInt(digits.slice(-9), 10);
      }

      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE goals
          SET current_count = ?, status = ?, completed_date = ?
          WHERE id = ?
        `).run(newCount, reached ? 'completed' : 'active', reached ? todayStr : null, goal.id);

        db.prepare(`
          INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(goal.id, todayStr, effectiveAmount, auditNote, msgIdNum);

        // Check if today has a corresponding task to mark complete
        const task = db.prepare(`
          SELECT id FROM tasks
          WHERE (goal_id = ? OR LOWER(name) LIKE ?) AND date = ? AND completed = 0
          LIMIT 1
        `).get(goal.id, `%${goal.title.toLowerCase()}%`, todayStr);

        if (task) {
          db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(task.id);
        }
      });

      tx();

      const cleanTitle = goal.title.replace(/\s*(?:320|\d+|practice|topic)\s*/gi, '').trim() || goal.title;
      const unitLabel = isFrequency ? 'session' : 'problems';
      const replyMsg = reached
        ? `Logged ${effectiveAmount} ${unitLabel}. ${cleanTitle} target reached: ${newCount}/${targetCount}!`
        : `Logged ${effectiveAmount} ${unitLabel}. ${cleanTitle} progress: ${currentCount}/${targetCount} → ${newCount}/${targetCount}.`;

      return {
        success: true,
        message: replyMsg,
        goal_id: goal.id,
        goal_title: goal.title,
        amount: effectiveAmount,
        note: auditNote,
        previous_count: currentCount,
        new_count: newCount,
        target_count: targetCount,
        target_reached: reached,
        updated: ['Goals', 'Dashboard']
      };
    }
  },

  {
    name: 'correct_goal_progress',
    description: 'Correct a previously reported goal count (e.g. "correction: only one, not two" or "actually I solved 1, not 2"). Inserts an internal compensating adjustment row without modifying the original entry.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal_identifier: {
          type: 'STRING',
          description: 'Title, keyword, or ID of the goal being corrected. Optional if referring to the last updated goal.'
        },
        correct_amount: {
          type: 'INTEGER',
          description: 'The actual/corrected total amount of work completed (must be >= 0).'
        },
        reason: {
          type: 'STRING',
          description: 'Optional note explaining the correction.'
        }
      },
      required: ['correct_amount']
    },
    handler: async (args, context) => {
      const correctAmount = parseInt(args.correct_amount, 10);
      if (isNaN(correctAmount) || correctAmount < 0) {
        return { success: false, error: 'Corrected amount must be a non-negative integer (0 or greater).' };
      }

      // 1. Locate goal
      let goal = null;
      if (args.goal_identifier) {
        const { match, ambiguous, candidates } = findMatchingGoal(args.goal_identifier);
        if (ambiguous) {
          const titles = candidates.map(c => `"${c.title}"`).join(' or ');
          return { success: false, ambiguous: true, error: `Multiple goals match "${args.goal_identifier}": ${titles}. Which one are you correcting?` };
        }
        goal = match;
      }

      if (!goal) {
        const lastLog = db.prepare(`
          SELECT g.* FROM goal_progress_log l
          JOIN goals g ON l.goal_id = g.id
          WHERE g.goal_type = 'count'
          ORDER BY l.id DESC LIMIT 1
        `).get();
        if (lastLog) goal = lastLog;
      }

      if (!goal) {
        return { success: false, error: 'Could not determine which goal to correct. Please specify the goal name.' };
      }

      // 2. Query positive entries in the last 24 hours (today or yesterday)
      const todayStr = getTodayDate(context.todayDate);
      const yesterday = new Date(context.todayDate);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = getTodayDate(yesterday);

      const rawEntries = db.prepare(`
        SELECT id, amount, date, chat_message_id, note
        FROM goal_progress_log
        WHERE goal_id = ? AND date IN (?, ?) AND amount > 0 AND note NOT LIKE 'correction_for:%'
        ORDER BY id DESC
      `).all(goal.id, todayStr, yesterdayStr);

      // Compute effective remaining amount for each entry (original amount + compensating rows)
      const candidateEntries = [];
      for (const entry of rawEntries) {
        const comp = db.prepare(`
          SELECT SUM(amount) as comp_sum
          FROM goal_progress_log
          WHERE goal_id = ? AND note LIKE ?
        `).get(goal.id, `correction_for:${entry.id}:%`);

        const currentEffective = entry.amount + (comp && comp.comp_sum ? comp.comp_sum : 0);
        if (currentEffective > 0) {
          candidateEntries.push({
            ...entry,
            currentEffective
          });
        }
      }

      if (candidateEntries.length === 0) {
        return { success: false, error: `No recent progress entry found to correct for "${goal.title}".` };
      }

      // If several candidate entries exist with positive remaining amounts, ask for clarification
      if (candidateEntries.length > 1) {
        return {
          success: false,
          ambiguous: true,
          error: `Found ${candidateEntries.length} separate progress entries for "${goal.title}" in the last 24 hours. Please clarify which one you want to correct.`
        };
      }

      const targetEntry = candidateEntries[0];
      const currentEffectiveAmount = targetEntry.currentEffective;

      // Delta is always correctAmount - currentEffectiveAmount (ignoring any model-supplied previous_amount)
      const delta = correctAmount - currentEffectiveAmount;

      if (delta === 0) {
        return { success: true, message: `No change needed: "${goal.title}" is already recorded at ${correctAmount}.`, updated: [] };
      }

      const currentCount = goal.current_count || 0;
      const targetCount = goal.target_count || 1;
      const newCount = Math.max(0, currentCount + delta);

      let msgIdNum = null;
      if (typeof context.messageId === 'number') msgIdNum = context.messageId;
      else if (typeof context.messageId === 'string') {
        const digits = context.messageId.replace(/\D/g, '');
        if (digits) msgIdNum = parseInt(digits.slice(-9), 10);
      }

      // Status adjustment:
      // If newCount >= targetCount -> 'completed'
      // If goal was 'completed' and newCount < targetCount -> must return to 'active'!
      let newStatus = goal.status;
      let completedDate = goal.completed_date;
      if (newCount >= targetCount) {
        newStatus = 'completed';
        completedDate = completedDate || todayStr;
      } else {
        newStatus = 'active';
        completedDate = null;
      }

      // 3. Insert compensating row (never edit original row)
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE goals
          SET current_count = ?, status = ?, completed_date = ?
          WHERE id = ?
        `).run(newCount, newStatus, completedDate, goal.id);

        db.prepare(`
          INSERT INTO goal_progress_log (goal_id, date, amount, note, chat_message_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          goal.id,
          todayStr,
          delta,
          `correction_for:${targetEntry.id}:${args.reason || `adjusted from ${currentEffectiveAmount} to ${correctAmount}`}`,
          msgIdNum
        );
      });

      tx();

      const cleanTitle = goal.title.replace(/\s*(?:320|\d+|practice|topic)\s*/gi, '').trim() || goal.title;
      return {
        success: true,
        message: `Corrected! Adjusted ${cleanTitle} progress from ${currentCount} to ${newCount} (compensating delta: ${delta > 0 ? '+' : ''}${delta}).`,
        goal_id: goal.id,
        goal_title: goal.title,
        original_entry_id: targetEntry.id,
        previous_effective_amount: currentEffectiveAmount,
        corrected_amount: correctAmount,
        compensating_delta: delta,
        previous_count: currentCount,
        new_count: newCount,
        new_status: newStatus,
        updated: ['Goals', 'Dashboard']
      };
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
      const stepQuery = (args.step_identifier || '').trim().toLowerCase();
      if (!stepQuery) return { success: false, error: 'Step identifier is required.' };

      let stepsQuery = `
        SELECT s.id AS step_id, s.step_text, s.done, g.id AS goal_id, g.title AS goal_title, g.status AS goal_status
        FROM goal_steps s
        JOIN goals g ON s.goal_id = g.id
        WHERE g.status != 'removed'
      `;
      const steps = db.prepare(stepsQuery).all();

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

      const todayStr = getTodayDate(context.todayDate);
      db.transaction(() => {
        db.prepare('UPDATE goal_steps SET done = 1 WHERE id = ?').run(target.step_id);
        db.prepare(`
          INSERT INTO goal_progress_log (goal_id, date, amount, note)
          VALUES (?, ?, 1, ?)
        `).run(target.goal_id, todayStr, `agent:step:${target.step_id}`);

        // If all steps done, mark goal completed
        const rem = db.prepare('SELECT COUNT(*) as cnt FROM goal_steps WHERE goal_id = ? AND done = 0').get(target.goal_id);
        if (rem.cnt === 0) {
          db.prepare('UPDATE goals SET status = "completed", completed_date = ? WHERE id = ?').run(todayStr, target.goal_id);
        }
      })();

      return {
        success: true,
        message: `Done! ${target.step_text} is marked complete under ${cleanGoalTitle}.`,
        step_id: target.step_id,
        goal_id: target.goal_id,
        updated: ['Goals']
      };
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
    description: 'Trigger automatic replanning of today\'s remaining tasks within available time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'Reason for replanning (e.g. "Availability updated").'
        }
      }
    },
    handler: async (args, context) => {
      const reason = args.reason || 'Requested by chat';
      try {
        const result = replan(reason, context.nowDate || new Date());
        return {
          success: true,
          message: `Replanned today's schedule (${result ? result.count : 0} task(s) scheduled).`,
          updated: ['Day Plan']
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
      const type = (args.type || '').toLowerCase();
      if (!['task', 'goal'].includes(type)) {
        return { success: false, error: 'Type must be "task" or "goal".' };
      }

      const q = (args.identifier || '').trim();
      const todayStr = getTodayDate(context.todayDate);

      let target = null;
      if (type === 'goal') {
        if (/^(?:all\s+my\s+goals|all\s+goals|all)$/i.test(q)) {
          const activeGoals = db.prepare("SELECT id, title FROM goals WHERE status = 'active'").all();
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
        const { match, ambiguous, candidates } = findMatchingGoal(q);
        if (ambiguous) {
          const titles = candidates.map(c => `"${c.title}"`).join(' or ');
          return { success: false, ambiguous: true, error: `Multiple goals match "${q}": ${titles}. Please specify which one.` };
        }
        if (!match) return { success: false, error: `No active goal found matching "${q}".` };
        target = { id: match.id, targetIds: [match.id], title: match.title };
      } else {
        const cleanQ = q.replace(/\b(?:task|item|assignment|session)\b/gi, '').trim();
        const searchTerm = cleanQ.length > 0 ? cleanQ : q;
        const rows = db.prepare('SELECT id, name FROM tasks WHERE LOWER(name) LIKE ? AND date >= ? AND completed = 0').all(`%${searchTerm.toLowerCase()}%`, todayStr);
        if (rows.length === 0) return { success: false, error: `No incomplete tasks found matching "${q}".` };
        const uniqueTitles = [...new Set(rows.map(r => r.name.trim()))];
        if (uniqueTitles.length > 1) {
          return { success: false, ambiguous: true, error: `Multiple tasks match "${q}": ${uniqueTitles.map(t => `"${t}"`).join(', ')}. Please specify which one you want to delete.` };
        }
        target = { id: rows[0].id, targetIds: rows.map(r => r.id), title: rows[0].name };
      }

      // Store pending removal state (2 minutes)
      setPendingState({
        type: 'removal',
        removalType: type,
        targetId: target.id,
        targetIds: target.targetIds || [target.id],
        targetTitle: target.title,
        todayStr,
        expiresAt: Date.now() + 2 * 60 * 1000
      });

      return {
        success: true,
        pending_confirmation: true,
        message: `Remove ${type} "${target.title}"? Reply yes to confirm (or no to cancel). This expires in 2 minutes.`,
        target_id: target.id,
        target_title: target.title
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

module.exports = {
  TOOLS,
  getToolByName,
  getGeminiFunctionDeclarations,
  resolveTargetDate
};

