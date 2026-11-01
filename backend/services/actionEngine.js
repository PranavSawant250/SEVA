/**
 * backend/services/actionEngine.js
 *
 * Deterministic Natural Language Action Engine for SEVA.
 * Executes validated backend operations for:
 *  - Goal progress logging (e.g., "I completed two DSA problems")
 *  - Goal step completion (e.g., "I finished the next two Spring Boot steps")
 *  - Goal progress corrections (e.g., "Correction: I solved only 1 DSA problem")
 *  - Task creation (e.g., "I want a 45-minute DSA session today")
 *  - Task rescheduling (e.g., "Move Spring Boot to 5 PM", asking clarification if ambiguous like "Move database study to 4")
 *  - Task priority changes (e.g., "Make my SEVA demo presentation high priority")
 *  - Task completion & uncompletion (e.g., "I've finished my database study session")
 *  - Availability updates & Day Plan replanning (e.g., "I have only one hour available today", "I finished studying for today")
 *  - Email summaries query (e.g., "Show me only important emails")
 *  - Habit acknowledgment (e.g., "I didn't run today")
 *
 * Rules:
 *  - Never executes raw arbitrary SQL from LLM.
 *  - All mutations are atomic transactions using SQLite.
 *  - Strictly distinguishes completed work from future intentions.
 *  - Prevents duplicate counting via idempotency guards.
 *  - Synchronizes Goals <-> Tasks <-> Day Plan in real time.
 */

const db = require('../database/db');
const { getTodayDate, parseTimeToMinutes, minutesToTimeString, daysBetween } = require('../utils/dateUtils');
const { getAllGoals, computeGoalProgress } = require('./goalsService');
const { replan, generateDayPlan } = require('./plannerService');

// Number words converter for English
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};

function parseNumber(str) {
  if (!str) return null;
  const clean = str.trim().toLowerCase();
  if (NUMBER_WORDS[clean] !== undefined) return NUMBER_WORDS[clean];
  const num = parseInt(clean, 10);
  return isNaN(num) ? null : num;
}

// ─────────────────────────────────────────────────────────────
// RECENT ACTION IDEMPOTENCY CACHE
// Prevents duplicate operations within 30 seconds
// ─────────────────────────────────────────────────────────────
const recentActions = new Map(); // key: hash, value: timestamp

function checkIdempotency(actionKey) {
  const now = Date.now();
  if (recentActions.has(actionKey)) {
    const lastTime = recentActions.get(actionKey);
    if (now - lastTime < 30000) {
      return true; // Duplicate detected
    }
  }
  recentActions.set(actionKey, now);
  // Clean old entries
  for (const [k, v] of recentActions.entries()) {
    if (now - v > 60000) recentActions.delete(k);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// GOAL MATCHER
// ─────────────────────────────────────────────────────────────
function findMatchingGoal(query, goals = null) {
  let candidatePool = goals || db.prepare("SELECT * FROM goals WHERE status = 'active'").all();
  if (!query) return { match: null, ambiguous: false, candidates: [] };

  const q = query.trim().toLowerCase();

  // Synonym mapping
  const synonyms = {
    'dsa': ['dsa', 'leetcode', 'algorithm', 'problem', 'coding'],
    'leetcode': ['leetcode', 'dsa', 'problem'],
    'spring': ['spring boot', 'spring', 'backend', 'java'],
    'spring boot': ['spring boot', 'spring'],
    'database': ['database', 'db', 'sql'],
    'run': ['run', 'running', 'jog']
  };

  let searchTerms = [q];
  for (const [key, synList] of Object.entries(synonyms)) {
    if (q.includes(key)) {
      searchTerms.push(...synList);
    }
  }

  function searchIn(pool) {
    const exact = pool.find(g => g.title.toLowerCase() === q);
    if (exact) return { match: exact, ambiguous: false, candidates: [exact] };

    const matches = pool.filter(g => {
      const title = g.title.toLowerCase();
      return searchTerms.some(term => title.includes(term) || term.includes(title));
    });

    if (matches.length === 1) return { match: matches[0], ambiguous: false, candidates: matches };
    if (matches.length > 1) return { match: null, ambiguous: true, candidates: matches };
    return { match: null, ambiguous: false, candidates: [] };
  }

  // 1. Search active goals first
  let res = searchIn(candidatePool);
  if (res.match || res.ambiguous) return res;

  // 2. Fall back to all non-removed goals (including completed goals)
  if (!goals) {
    const allNonRemoved = db.prepare("SELECT * FROM goals WHERE status != 'removed'").all();
    res = searchIn(allNonRemoved);
    if (res.match || res.ambiguous) return res;
  }

  return { match: null, ambiguous: false, candidates: [] };
}

// ─────────────────────────────────────────────────────────────
// INTENT PARSER & DISPATCHER
// ─────────────────────────────────────────────────────────────

/**
 * Handle Goal Progress Logging:
 * "I completed two DSA problems", "I solved 3 LeetCode problems", "Logged 2 DSA problems"
 */
function handleCountProgress(msg, todayDateObj) {
  // Guard: ignore future intentions ("I will", "I plan to", "I want to", "going to", "tomorrow")
  if (/\b(?:i\s+will|i'll|i\s+plan\s+to|i\s+want\s+to|going\s+to|tomorrow|later)\b/i.test(msg)) {
    return null;
  }

  // Guard: ignore corrections (handled by handleGoalCorrection)
  if (/\b(?:correction|actually|mistake)\b/i.test(msg)) {
    return null;
  }

  // Completed regex: "I completed/solved/did/finished/logged [N] [goal/problem]"
  const countPattern = /\b(?:i\s+have\s+)?(?:completed|solved|did|finished|logged)\s+(?:another\s+)?([a-z0-9]+)\s+(.+?)(?:\s+problems?|\s+questions?|\s+items?)?(?:\.|$)/i;
  const match = msg.match(countPattern);
  if (!match) return null;

  const rawNum = match[1];
  const num = parseNumber(rawNum);
  if (num === null || num <= 0) return null;

  const rawGoalQuery = match[2].trim().replace(/\b(?:problems?|questions?|for|today|more)\b/gi, '').trim() || 'dsa';
  const { match: goal, ambiguous, candidates } = findMatchingGoal(rawGoalQuery);

  if (ambiguous) {
    const titles = candidates.map(c => `"${c.title}"`).join(' or ');
    return `Did you mean ${titles}? Please specify which goal you worked on.`;
  }

  if (!goal) {
    // If no goal found matching query, check if there's any active count goal
    const countGoals = db.prepare("SELECT * FROM goals WHERE status = 'active' AND goal_type = 'count'").all();
    if (countGoals.length === 1) {
      return executeCountProgress(countGoals[0], num, todayDateObj, msg);
    }
    return null;
  }

  if (goal.goal_type !== 'count') {
    return null; // Let other handlers (e.g. milestone steps) process it
  }

  return executeCountProgress(goal, num, todayDateObj, msg);
}

function executeCountProgress(goal, num, todayDateObj, rawMsg) {
  const todayStr = getTodayDate(todayDateObj);
  const actionKey = `count:${goal.id}:${num}:${todayStr}:${rawMsg}`;
  if (checkIdempotency(actionKey)) {
    return `Already logged ${num} for "${goal.title}" today.`;
  }

  // If already reached target
  if (goal.status === 'completed' && (goal.current_count || 0) >= (goal.target_count || 1)) {
    return `Already logged! Goal "${goal.title}" has reached its target (${goal.current_count}/${goal.target_count}).`;
  }

  const currentCount = goal.current_count || 0;
  const target = goal.target_count || 1;
  const newCount = currentCount + num;
  const reached = newCount >= target;

  const tx = db.transaction(() => {
    // Update goal
    db.prepare(`
      UPDATE goals
      SET current_count = ?, status = ?, completed_date = ?
      WHERE id = ?
    `).run(newCount, reached ? 'completed' : 'active', reached ? todayStr : null, goal.id);

    // Add audit log
    db.prepare(`
      INSERT INTO goal_progress_log (goal_id, date, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(goal.id, todayStr, num, `chat:completed:${num}`);

    // Update today's corresponding task in `tasks` table if exists
    const matchingTask = db.prepare(`
      SELECT id FROM tasks
      WHERE (goal_id = ? OR LOWER(name) LIKE ? OR LOWER(name) LIKE ?)
        AND date = ?
        AND completed = 0
      LIMIT 1
    `).get(goal.id, `%${goal.title.toLowerCase()}%`, '%dsa%', todayStr);

    if (matchingTask) {
      db.prepare(`UPDATE tasks SET completed = 1 WHERE id = ?`).run(matchingTask.id);

      // Sync Day Plan json if present
      const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
      if (planRow && planRow.plan_json) {
        try {
          const plan = JSON.parse(planRow.plan_json);
          let planChanged = false;
          for (const item of plan) {
            if (item.task_id === matchingTask.id || (item.goal_id === goal.id)) {
              item.completed = 1;
              planChanged = true;
            }
          }
          if (planChanged) {
            db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
          }
        } catch (_) {}
      }
    }
  });

  tx();

  const cleanTitle = goal.title.replace(/\s*(?:320|\d+|practice|topic)\s*/gi, '').trim() || goal.title;
  if (reached) {
    return `Logged ${num} problems. ${cleanTitle} target reached: ${newCount}/${target}!`;
  }
  return `Logged ${num} problems. ${cleanTitle} progress: ${currentCount}/${target} → ${newCount}/${target}.`;
}

/**
 * Handle Named Goal Step Completion:
 * "Today i have completed bfs topic of tree", "I finished BFS", "Mark BFS done in Trees"
 */
function handleNamedStepCompletion(msg, todayDateObj) {
  // Guard against future intentions
  if (/\b(?:i\s+will|i'll|i\s+plan\s+to|i\s+want\s+to|going\s+to|tomorrow|later)\b/i.test(msg)) {
    return null;
  }
  // Guard against corrections
  if (/\b(?:correction|actually|mistake)\b/i.test(msg)) {
    return null;
  }

  const hasCompleteSignal = /\b(?:completed|complete|finished|done(?:\s+with)?|solved|did|marked?)\b/i.test(msg) ||
                            /\bis\s+(?:completed|complete|done)\b/i.test(msg);
  if (!hasCompleteSignal) return null;

  const todayStr = getTodayDate(todayDateObj);
  const lower = msg.toLowerCase();

  const steps = db.prepare(`
    SELECT s.id AS step_id, s.step_text, s.done, g.id AS goal_id, g.title AS goal_title, g.status AS goal_status
    FROM goal_steps s
    JOIN goals g ON s.goal_id = g.id
    WHERE g.status != 'removed'
    ORDER BY s.id ASC
  `).all();

  if (steps.length === 0) return null;

  const matches = [];

  for (const s of steps) {
    const stepText = (s.step_text || '').trim();
    if (!stepText) continue;

    const escaped = stepText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stepRegex = new RegExp(`\\b${escaped}\\b`, 'i');

    if (stepRegex.test(lower)) {
      const goalTitle = (s.goal_title || '').toLowerCase();
      const goalWords = goalTitle.split(/\s+/).filter(w => w.length > 2 && w !== 'topic' && w !== 'basics');
      let goalMatch = false;

      if (lower.includes(goalTitle)) {
        goalMatch = true;
      } else {
        for (const gw of goalWords) {
          const stem = gw.replace(/s$/, '');
          if (lower.includes(stem)) {
            goalMatch = true;
            break;
          }
        }
      }

      matches.push({
        step: s,
        goalMatch,
        done: s.done
      });
    }
  }

  if (matches.length === 0) return null;

  // Prioritize goal match, then incomplete steps
  matches.sort((a, b) => {
    if (a.goalMatch !== b.goalMatch) return a.goalMatch ? -1 : 1;
    if (a.done !== b.done) return a.done === 0 ? -1 : 1;
    return 0;
  });

  const target = matches[0].step;
  const cleanGoalTitle = target.goal_title.replace(/\s+topic$/i, '').trim() || target.goal_title;

  if (target.done === 1) {
    return `${target.step_text} is already marked complete under ${cleanGoalTitle}.`;
  }

  const actionKey = `named_step:${target.step_id}:${todayStr}:${lower}`;
  if (checkIdempotency(actionKey)) {
    return `Done! ${target.step_text} is marked complete under ${cleanGoalTitle}.`;
  }

  const tx = db.transaction(() => {
    // 1. Mark step complete
    db.prepare('UPDATE goal_steps SET done = 1 WHERE id = ?').run(target.step_id);

    // 2. Add progress log
    db.prepare(`
      INSERT INTO goal_progress_log (goal_id, date, amount, note)
      VALUES (?, ?, 1, ?)
    `).run(target.goal_id, todayStr, `chat:step:${target.step_id}`);

    // 3. Check if all steps of this goal are now completed
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM goal_steps WHERE goal_id = ? AND done = 0').get(target.goal_id);
    if (remaining.cnt === 0) {
      db.prepare("UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?").run(todayStr, target.goal_id);
    }

    // 4. Update matching task for today in `tasks` table
    const tasks = db.prepare(`
      SELECT id, name FROM tasks
      WHERE (goal_id = ? OR LOWER(name) LIKE ? OR LOWER(name) LIKE ?)
        AND date = ?
        AND completed = 0
    `).all(target.goal_id, `%${target.step_text.toLowerCase()}%`, `%${cleanGoalTitle.toLowerCase()}%`, todayStr);

    for (const t of tasks) {
      db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(t.id);

      // Sync Day Plan json
      const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
      if (planRow && planRow.plan_json) {
        try {
          const plan = JSON.parse(planRow.plan_json);
          let planChanged = false;
          for (const item of plan) {
            if (item.task_id === t.id || item.goal_id === target.goal_id) {
              item.completed = 1;
              planChanged = true;
            }
          }
          if (planChanged) {
            db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
          }
        } catch (_) {}
      }
    }
  });

  tx();

  return `Done! ${target.step_text} is marked complete under ${cleanGoalTitle}.`;
}

/**
 * Handle Goal Step Completion:
 * "I have finished the next two Spring Boot steps", "Finished step 2 of Spring Boot"
 */
function handleMilestoneSteps(msg, todayDateObj) {
  if (/\b(?:i\s+will|i'll|i\s+plan\s+to|i\s+want\s+to|going\s+to)\b/i.test(msg)) {
    return null;
  }

  const stepPattern = /\b(?:finished|completed|done(?:\s+with)?)\s+(?:the\s+)?(?:next\s+)?([a-z0-9]+)\s+(.+?)\s+steps?\b/i;
  const match = msg.match(stepPattern);
  if (!match) return null;

  const rawNum = match[1];
  const num = parseNumber(rawNum) || 1;
  const rawGoalQuery = match[2].trim().replace(/\b(?:for|of)\b/gi, '').trim();

  const { match: goal, ambiguous, candidates } = findMatchingGoal(rawGoalQuery);
  if (ambiguous) {
    const titles = candidates.map(c => `"${c.title}"`).join(' or ');
    return `Did you mean ${titles}? Please specify which goal.`;
  }

  if (!goal) return null;

  const todayStr = getTodayDate(todayDateObj);
  const untickedSteps = db.prepare(`
    SELECT id, step_text FROM goal_steps
    WHERE goal_id = ? AND done = 0
    ORDER BY id ASC
  `).all(goal.id);

  if (untickedSteps.length === 0) {
    return `All steps for "${goal.title}" are already completed!`;
  }

  const stepsToComplete = untickedSteps.slice(0, num);
  const tx = db.transaction(() => {
    for (const step of stepsToComplete) {
      db.prepare('UPDATE goal_steps SET done = 1 WHERE id = ?').run(step.id);
      db.prepare(`
        INSERT INTO goal_progress_log (goal_id, date, amount, note)
        VALUES (?, ?, 1, ?)
      `).run(goal.id, todayStr, `chat:step:${step.id}`);
    }

    // Check if all steps now completed
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM goal_steps WHERE goal_id = ? AND done = 0').get(goal.id);
    if (remaining.cnt === 0) {
      db.prepare("UPDATE goals SET status = 'completed', completed_date = ? WHERE id = ?").run(todayStr, goal.id);
    }
  });

  tx();

  const stepList = stepsToComplete.map(s => `"${s.step_text}"`).join(', ');
  return `Great progress! Marked ${stepsToComplete.length} step(s) as complete for "${goal.title}" (${stepList}).`;
}

/**
 * Handle Goal Corrections:
 * "Correction: I solved only 1 DSA problem", "Actually I did only 1 problem"
 */
function handleGoalCorrection(msg, todayDateObj) {
  const correctionPattern = /\b(?:correction|actually|mistake)[\s:,]+(?:i\s+)?(?:only\s+)?(?:solved|did|completed)\s+([a-z0-9]+)\s+(.+?)(?:\s+problems?|\s+steps?)?(?:\.|$)/i;
  const match = msg.match(correctionPattern);
  if (!match) return null;

  const actualNum = parseNumber(match[1]);
  if (actualNum === null) return null;

  const rawGoal = match[2].trim().replace(/\b(?:problems?|for|today)\b/gi, '').trim() || 'dsa';
  const { match: goal } = findMatchingGoal(rawGoal);
  if (!goal || goal.goal_type !== 'count') return null;

  const todayStr = getTodayDate(todayDateObj);
  // Find today's chat logs for this goal, most recent first
  const logs = db.prepare(`
    SELECT id, amount FROM goal_progress_log
    WHERE goal_id = ? AND date = ?
    ORDER BY id DESC
  `).all(goal.id, todayStr);

  const lastLog = logs[0];
  const lastAmount = lastLog ? (lastLog.amount || 0) : 0;
  const diff = actualNum - lastAmount;

  if (diff === 0) {
    return `Your progress for "${goal.title}" is already recorded as ${actualNum} for today.`;
  }

  const target = goal.target_count || 1;
  const currentCount = goal.current_count || 0;
  const newCount = Math.max(0, currentCount + diff);

  const tx = db.transaction(() => {
    db.prepare('UPDATE goals SET current_count = ? WHERE id = ?').run(newCount, goal.id);
    db.prepare(`
      INSERT INTO goal_progress_log (goal_id, date, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(goal.id, todayStr, diff, `chat:correction:${actualNum}`);
  });
  tx();

  return `Got it, corrected your progress for "${goal.title}". Current total is now ${newCount}/${target}.`;
}

/**
 * Handle Task Rescheduling:
 * "Move Spring Boot to 5 PM", "Move database study session to 4 PM", "Move database study to 4"
 */
function handleTaskReschedule(msg, todayDateObj) {
  const movePattern = /\b(?:move|reschedule|shift)\s+(.+?)\s+to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
  const match = msg.match(movePattern);
  if (!match) return null;

  const taskQuery = match[1].trim().replace(/\b(?:study\s+session|session|task)\b/gi, '').trim();
  let timeStr = match[2].trim();

  // Ambiguity check: e.g. "Move database study to 4" (missing AM/PM)
  if (!/(?:am|pm)/i.test(timeStr)) {
    const rawHour = parseInt(timeStr, 10);
    if (!isNaN(rawHour) && rawHour >= 1 && rawHour <= 12) {
      return `Do you mean ${rawHour} PM today?`;
    }
  }

  // Normalize time string (e.g. "5 PM" -> "5:00 PM")
  if (!timeStr.includes(':')) {
    timeStr = timeStr.replace(/(\d+)\s*(am|pm)/i, '$1:00 $2');
  }

  const targetMins = parseTimeToMinutes(timeStr);
  if (targetMins === null) {
    return `I couldn't parse the time "${match[2]}". Please use a format like "4:00 PM".`;
  }

  const todayStr = getTodayDate(todayDateObj);
  // Find task in tasks table
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE date = ? AND completed = 0
  `).all(todayStr);

  const matchedTask = tasks.find(t => t.name.toLowerCase().includes(taskQuery.toLowerCase()));
  if (!matchedTask) {
    return `I couldn't find an incomplete task matching "${taskQuery}" for today.`;
  }

  // Check conflicts with timetable (fixed class/work commitments)
  const dayName = todayDateObj.toLocaleDateString('en-US', { weekday: 'long' });
  const timetableBlocks = db.prepare(`
    SELECT subject, start_time, end_time FROM timetable WHERE day_of_week = ?
  `).all(dayName);

  for (const block of timetableBlocks) {
    const bStart = parseTimeToMinutes(block.start_time);
    const bEnd = parseTimeToMinutes(block.end_time);
    const taskEnd = targetMins + (matchedTask.duration_min || 30);
    if (bStart !== null && bEnd !== null) {
      if (Math.max(targetMins, bStart) < Math.min(taskEnd, bEnd)) {
        return `Cannot reschedule "${matchedTask.name}" to ${timeStr}: conflicts with your ${block.subject} (${block.start_time} - ${block.end_time}).`;
      }
    }
  }

  // Update task
  const formattedTime = minutesToTimeString(targetMins);
  db.prepare(`
    UPDATE tasks
    SET time_slot = ?, fixed_start = ?
    WHERE id = ?
  `).run(formattedTime, formattedTime, matchedTask.id);

  // Sync Day Plan
  const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
  if (planRow && planRow.plan_json) {
    try {
      const plan = JSON.parse(planRow.plan_json);
      for (const item of plan) {
        if (item.task_id === matchedTask.id || item.task.toLowerCase().includes(taskQuery.toLowerCase())) {
          item.time = formattedTime;
        }
      }
      db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
    } catch (_) {}
  }

  const cleanTime = formattedTime.replace(/:00\s*/, ' ');
  return `Moved ${matchedTask.name} to ${formattedTime}.`;
}

/**
 * Handle Priority Change:
 * "Make my SEVA demo presentation high priority", "Set database study to high priority"
 */
function handlePriorityChange(msg, todayDateObj) {
  const prioPattern = /\b(?:make|set|change|prioritize)\s+(?:my\s+)?(.+?)\s+(?:to\s+)?(high|medium|low)\s*(?:priority)?\b/i;
  const match = msg.match(prioPattern);
  if (!match) {
    // Also handle "Prioritize my SEVA demo presentation"
    const prioritizePattern = /\bprioritize\s+(?:my\s+)?(.+?)(?:\.|$)/i;
    const pMatch = msg.match(prioritizePattern);
    if (!pMatch) return null;
    return executePriorityChange(pMatch[1].trim(), 'high', todayDateObj);
  }

  return executePriorityChange(match[1].trim(), match[2].toLowerCase(), todayDateObj);
}

function executePriorityChange(query, newPrio, todayDateObj) {
  const todayStr = getTodayDate(todayDateObj);
  const tasks = db.prepare(`SELECT * FROM tasks WHERE date = ? AND completed = 0`).all(todayStr);

  const cleanQuery = query.toLowerCase().replace(/\b(?:presentation|session|task)\b/gi, '').trim();
  const matchedTask = tasks.find(t => t.name.toLowerCase().includes(cleanQuery));

  if (matchedTask) {
    db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPrio, matchedTask.id);
    // If linked to goal, update goal priority too
    if (matchedTask.goal_id) {
      db.prepare('UPDATE goals SET priority = ? WHERE id = ?').run(newPrio, matchedTask.goal_id);
    }
    // Update Day Plan
    const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
    if (planRow && planRow.plan_json) {
      try {
        const plan = JSON.parse(planRow.plan_json);
        for (const item of plan) {
          if (item.task_id === matchedTask.id) item.priority = newPrio;
        }
        db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
      } catch (_) {}
    }
    return `Updated "${matchedTask.name}" to ${newPrio} priority.`;
  }

  // Check goals
  const activeGoals = db.prepare("SELECT * FROM goals WHERE status = 'active'").all();
  const matchedGoal = activeGoals.find(g => g.title.toLowerCase().includes(cleanQuery));
  if (matchedGoal) {
    db.prepare('UPDATE goals SET priority = ? WHERE id = ?').run(newPrio, matchedGoal.id);
    return `Updated goal "${matchedGoal.title}" to ${newPrio} priority.`;
  }

  return `I couldn't find a task or goal matching "${query}" to update priority.`;
}

/**
 * Handle Task Completion:
 * "I've finished my database study session", "Completed task X", "Done with Spring Boot task"
 */
function handleTaskCompletion(msg, todayDateObj) {
  if (/\b(?:i\s+will|i'll|i\s+plan\s+to|going\s+to)\b/i.test(msg)) return null;

  const taskCompPattern = /\b(?:i've\s+|i\s+have\s+|i\s+)?(?:finished|completed|done\s+with)\s+(?:my\s+)?(.+?)\s*(?:study\s+session|session|task)?(?:\.|$)/i;
  const match = msg.match(taskCompPattern);
  if (!match) return null;

  const rawQuery = match[1].trim().toLowerCase();
  if (rawQuery.includes('dsa problem') || rawQuery.includes('spring boot step')) return null; // handled by count/step

  const todayStr = getTodayDate(todayDateObj);
  const tasks = db.prepare(`SELECT * FROM tasks WHERE date <= ? AND completed = 0`).all(todayStr);

  const matchedTask = tasks.find(t => t.name.toLowerCase().includes(rawQuery));
  if (!matchedTask) return null;

  // Mark task completed
  db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(matchedTask.id);

  // Sync Day Plan
  const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
  if (planRow && planRow.plan_json) {
    try {
      const plan = JSON.parse(planRow.plan_json);
      for (const item of plan) {
        if (item.task_id === matchedTask.id) item.completed = 1;
      }
      db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
    } catch (_) {}
  }

  return `Completed "${matchedTask.name}". Your schedule has been updated.`;
}

/**
 * Handle Availability & Window Replanning:
 * "I have only one hour available today", "I have only 1 hour left today"
 */
function handleAvailabilityUpdate(msg, todayDateObj, nowDate) {
  const availPattern = /\bi\s+have\s+only\s+(\d+(?:\.\d+)?|[a-z]+)\s*(?:more\s+)?(hours?|hrs?|minutes?|mins?)(?:\s+available|\s+left)?(?:\s+today)?\b/i;
  const match = msg.match(availPattern);
  if (!match) return null;

  const rawAmount = match[1];
  const num = parseNumber(rawAmount);
  if (num === null) return null;

  const unit = match[2].toLowerCase();
  const budgetMins = unit.startsWith('h') ? Math.round(num * 60) : Math.round(num);

  const todayStr = getTodayDate(todayDateObj);
  const currentNow = nowDate || new Date();
  const nowMins = currentNow.getHours() * 60 + currentNow.getMinutes();
  const endMins = nowMins + budgetMins;

  // Persist to daily_settings
  db.prepare(`
    INSERT INTO daily_settings (date, window_end_minutes, available_minutes)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET window_end_minutes = ?, available_minutes = ?
  `).run(todayStr, endMins, budgetMins, endMins, budgetMins);

  // Trigger replan
  try {
    replan('User window updated', currentNow);
  } catch (_) {}

  return `I'll replan today's remaining schedule within ${num} ${unit.startsWith('h') ? 'hour' : 'minute'}${num === 1 ? '' : 's'}.`;
}

/**
 * Handle Habit Acknowledgment:
 * "I didn't run today", "Skipped running today"
 */
function handleHabitNotice(msg, todayDateObj) {
  const habitPattern = /\b(?:i\s+)?(?:didn't|did\s+not|skipped|couldn't)\s+(run|jog|workout|exercise)\s+(?:today)?\b/i;
  const match = msg.match(habitPattern);
  if (!match) return null;

  const activity = match[1].toLowerCase();
  return `Noted that you didn't ${activity} today. I won't schedule it for today. We can pick it up tomorrow!`;
}

/**
 * Handle Important Emails Query:
 * "Show me only important emails", "What are my important emails?"
 */
function handleEmailQuery(msg) {
  if (!/\b(?:show\s+me|what\s+are|check|get)\s+(?:only\s+)?(?:my\s+)?important\s+emails?\b/i.test(msg)) {
    return null;
  }

  const emails = db.prepare(`
    SELECT id, subject, sender, summary, priority, is_personal, importance_category, matched_identity
    FROM emails
    WHERE (is_personal = 1 OR priority = 'high' OR relevance_score >= 1.5) AND dismissed = 0
    ORDER BY is_personal DESC, relevance_score DESC, id DESC
    LIMIT 5
  `).all();

  if (emails.length === 0) {
    return `You have no unreviewed high-priority or personally relevant emails right now.`;
  }

  const list = emails.map((e, idx) => {
    const badge = e.is_personal ? '🚨 Personal: ' : '';
    return `${idx + 1}. ${badge}"${e.subject}" — ${e.summary || 'Requires review.'}`;
  }).join('\n');

  return `Here are your important emails:\n${list}`;
}

/**
 * Handle Task Addition:
 * "I want a 45-minute DSA session today", "Add a 30 min task for Database"
 */
function handleAddTask(msg, todayDateObj) {
  const addTaskPattern = /\b(?:i\s+want\s+a|add\s+(?:a\s+)?|schedule\s+(?:a\s+)?)\s*(\d+)\s*(?:-|–|\s+)?(min|minutes?|hours?|hrs?)\s+(.+?)(?:\s+session|\s+task)?(?:\s+today)?(?:\.|$)/i;
  const match = msg.match(addTaskPattern);
  if (!match) return null;

  const rawDuration = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const duration = unit.startsWith('h') ? rawDuration * 60 : rawDuration;
  const taskName = match[3].trim();
  const todayStr = getTodayDate(todayDateObj);

  // Link to goal if possible
  const { match: goal } = findMatchingGoal(taskName);

  const res = db.prepare(`
    INSERT INTO tasks (name, priority, source, completed, date, duration_min, goal_id)
    VALUES (?, 'medium', 'manual', 0, ?, ?, ?)
  `).run(taskName, todayStr, duration, goal ? goal.id : null);

  const newTaskId = res.lastInsertRowid;

  // Add to Day Plan if window is set
  const planRow = db.prepare('SELECT id, plan_json FROM day_plans WHERE date = ?').get(todayStr);
  if (planRow && planRow.plan_json) {
    try {
      const plan = JSON.parse(planRow.plan_json);
      plan.push({
        task_id: newTaskId,
        task: taskName,
        priority: 'medium',
        duration,
        time: 'flexible',
        completed: 0,
        source: 'manual'
      });
      db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), planRow.id);
    } catch (_) {}
  }

  return `Added "${taskName}" (${duration} min) to your tasks and Day Plan for today.`;
}

/**
 * Handle "Do Not Generate Day Plan":
 * "not generate day plan", "do not generate day plan", "don't generate the plan", "no need to generate day plan"
 */
function handleDoNotGenerate(msg) {
  const lower = (msg || '').trim().toLowerCase();
  const re = /\b(?:do\s+not|don't|not|stop|no\s+need\s+to)\s+(?:generate|replan|create|make|regenerate|change)\s+(?:the\s+)?(?:day\s+)?plan\b/i;
  if (!re.test(lower)) return null;

  // Clear any pending check-in/removal session so user is not prompted further
  const { clearPending } = require('./chatCommands');
  clearPending();

  return "Okay, I won't generate or change the plan.";
}

/**
 * Handle "Show me the plan":
 * "show me today's plan", "show tomorrow's plan", "what is my plan for today", "show day plan"
 */
function handleShowPlan(msg, todayDateObj) {
  const lower = (msg || '').trim().toLowerCase();
  const re = /\b(?:show\s+(?:me\s+)?|what\s+(?:is|are)\s+(?:my\s+)?|get\s+|view\s+)(?:the\s+)?(?:today(?:'s)?|tomorrow(?:'s)?|day)?\s*plan\b/i;
  if (!re.test(lower)) return null;

  // Don't trigger on "create plan", "make plan", or "don't generate"
  if (/\b(?:create|make|generate|replan|set|don't|do\s+not|not)\b/i.test(lower)) return null;

  const { getTomorrowDate, getTodayDate } = require('../utils/dateUtils');
  const isTomorrow = /\b(?:tomorrow|tmrw|tommorow)\b/i.test(lower);
  const targetDateStr = isTomorrow ? getTomorrowDate(todayDateObj) : getTodayDate(todayDateObj);
  const label = isTomorrow ? 'tomorrow' : 'today';

  const planRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(targetDateStr);
  if (!planRow || !planRow.plan_json) {
    return `No plan generated yet for ${label}.`;
  }

  let planItems = [];
  try {
    planItems = JSON.parse(planRow.plan_json);
  } catch (_) {
    return `Stored plan for ${label} is malformed.`;
  }

  if (!Array.isArray(planItems) || planItems.length === 0) {
    return `No tasks scheduled yet for ${label}.`;
  }

  const itemsList = planItems
    .map(p => `${p.time ? p.time + ': ' : ''}${p.task}`)
    .join(', ');

  return `Plan for ${label}: ${itemsList}.`;
}

/**
 * Handle Conversational Plan Updates & Explicit Restrictions:
 * "Like as we decided of LeetCode and German only, so create plan on that."
 * "Tomorrow I have to prepare for my German exam only and 2 LeetCode questions"
 * "I have six hours tomorrow for German exam preparation and only two LeetCode questions"
 * "6 hr and tmrw i have to prepare for my german exam only"
 * "tommorow i have to prepare for my german exam only and 2 leetcode question only"
 */
function handleConversationalPlan(msg, todayDateObj, nowDate) {
  const lower = (msg || '').trim().toLowerCase();

  const hasTomorrow = /\b(?:tomorrow|tmrw|tommorow)\b/i.test(lower);
  const hasToday = /\b(?:today|today's|for\s+today)\b/i.test(lower);
  const mentionsPlan = /\b(?:plan|day\s+plan|schedule)\b/i.test(lower);
  const mentionsDecided = /\b(?:decided\s+of|as\s+we\s+decided)\b/i.test(lower);

  // Guard against completed work statements:
  if (/\b(?:i\s+completed|i\s+solved|i\s+finished|i've\s+completed|i've\s+finished|done\s+with)\b/i.test(msg) &&
      !hasTomorrow && !hasToday && !mentionsPlan && !mentionsDecided) {
    return null;
  }

  // Guard against future conversational intentions without explicit restriction instructions
  if (/\b(?:i\s+will|i'll|i\s+plan\s+to|i'm\s+planning\s+to)\b/i.test(lower) && !/\b(?:only|just|restrict|plan|create)\b/i.test(lower)) {
    return null;
  }

  const { getPendingState, clearPending } = require('./chatCommands');
  const pendingState = getPendingState();
  const hasPendingCheckin = Boolean(pendingState && pendingState.type === 'checkin');

  // 2. Restriction flag
  const isRestricted = /\b(?:only|just|exclusively|nothing\s+else)\b/i.test(lower);
  const hasExamSignal = /\b(?:exam|prepare|preparation|german)\b/i.test(lower);

  // Conversational Plan must be an explicit plan/schedule request, decision, restriction, or exam prep block
  if (!mentionsPlan && !mentionsDecided && !isRestricted && !hasExamSignal) {
    return null;
  }

  // Must have plan indicators or tasks
  const hasTaskSignals = /\b(?:prepare|exam|german|leetcode|questions?|dsa|problems?|hours?|hrs?|only|schedule|study)\b/i.test(lower);
  if (!hasTaskSignals && !mentionsPlan && !mentionsDecided) return null;

  // Resolve target date:
  // If explicitly mentions tomorrow -> tomorrow
  // Else if explicitly mentions today -> today
  // Else if in pending check-in session for tomorrow (and not "create plan on that") -> pendingState.tomorrowDate
  // Else -> today! (Because the user is looking at today's Day Plan screen)
  const { getTomorrowDate, getTomorrowDayOfWeek, getTodayDate } = require('../utils/dateUtils');
  let targetDateStr;
  let targetWeekday;
  let targetLabel;

  if (hasTomorrow) {
    targetDateStr = getTomorrowDate(todayDateObj);
    targetWeekday = getTomorrowDayOfWeek(todayDateObj);
    targetLabel = 'tomorrow';
  } else if (hasToday) {
    targetDateStr = getTodayDate(todayDateObj);
    targetWeekday = todayDateObj.toLocaleDateString('en-US', { weekday: 'long' });
    targetLabel = 'today';
  } else if (hasPendingCheckin && pendingState.tomorrowDate && !mentionsPlan && !mentionsDecided) {
    targetDateStr = pendingState.tomorrowDate;
    targetWeekday = pendingState.tomorrowWeekday;
    targetLabel = 'tomorrow';
  } else {
    // Default to TODAY!
    targetDateStr = getTodayDate(todayDateObj);
    targetWeekday = todayDateObj.toLocaleDateString('en-US', { weekday: 'long' });
    targetLabel = 'today';
  }

  // 1. Budget parsing
  let budgetMinutes = null;
  const mBudget = lower.match(/(?:i\s+have\s+|about\s+|around\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (mBudget) {
    const rawVal = mBudget[1];
    const num = parseNumber(rawVal) !== null ? parseNumber(rawVal) : parseFloat(rawVal);
    const unit = mBudget[2].toLowerCase();
    budgetMinutes = unit.startsWith('h') ? Math.round(num * 60) : Math.round(num);
  } else if (hasPendingCheckin && pendingState.budgetMinutes) {
    budgetMinutes = pendingState.budgetMinutes;
  } else {
    const existingSet = db.prepare('SELECT available_minutes FROM daily_settings WHERE date = ?').get(targetDateStr);
    if (existingSet && existingSet.available_minutes) {
      budgetMinutes = existingSet.available_minutes;
    } else {
      budgetMinutes = 360; // 6 hours default
    }
  }

  // 3. Extract user-requested tasks
  const requestedTasks = [];
  const taskSummaries = [];

  // German exam prep
  if (/german/i.test(lower) || /prepare\s+for\s+(?:my\s+)?german/i.test(lower)) {
    requestedTasks.push({
      type: 'german',
      name: 'German exam preparation',
      priority: 'high',
      source: 'custom'
    });
    taskSummaries.push('German exam preparation');
  }

  // LeetCode / DSA questions
  const mLeet = lower.match(/(?:(\d+|one|two|three|four|five)\s+)?leetcode\s*(?:questions?|problems?|\d+)?/i) ||
                lower.match(/(?:(\d+|one|two|three|four|five)\s+)?dsa\s*(?:questions?|problems?)?/i);
  if (mLeet || (/leetcode/i.test(lower) && /german/i.test(lower))) {
    let count = 2;
    if (mLeet && mLeet[1]) {
      count = parseNumber(mLeet[1]) || parseInt(mLeet[1], 10) || 2;
    }
    const leetGoal = db.prepare("SELECT * FROM goals WHERE status = 'active' AND (title LIKE '%LeetCode%' OR title LIKE '%DSA%') LIMIT 1").get();
    requestedTasks.push({
      type: 'leetcode',
      count,
      name: `LeetCode 320: solve ${count} problems`,
      priority: 'high',
      source: 'goal',
      goal_id: leetGoal ? leetGoal.id : null,
      duration_min: Math.min(count * 45, 90)
    });
    taskSummaries.push(`${count} LeetCode questions`);
  }

  if (requestedTasks.length === 0) return null;

  // 4. Calculate task durations
  let otherMins = 0;
  for (const t of requestedTasks) {
    if (t.type !== 'german') {
      otherMins += t.duration_min || 90;
    }
  }
  for (const t of requestedTasks) {
    if (t.type === 'german') {
      t.duration_min = Math.max(60, budgetMinutes - otherMins - 15);
    }
  }

  // 5. Fetch timetable commitments for targetWeekday (fixed blocks)
  const timetableBlocks = db.prepare(`
    SELECT subject, start_time, end_time FROM timetable WHERE day_of_week = ? ORDER BY start_time ASC
  `).all(targetWeekday);

  // 6. Slot tasks around timetable
  const planItems = [];
  let currentMin = 9 * 60; // 9:00 AM

  for (const t of requestedTasks) {
    for (const b of timetableBlocks) {
      const bStart = parseTimeToMinutes(b.start_time);
      const bEnd = parseTimeToMinutes(b.end_time);
      if (bStart !== null && bEnd !== null) {
        if (currentMin >= bStart && currentMin < bEnd) {
          currentMin = bEnd + 15;
        } else if (currentMin < bStart && currentMin + t.duration_min > bStart) {
          currentMin = bEnd + 15;
        }
      }
    }

    const slotStartStr = minutesToTimeString(currentMin);
    currentMin += t.duration_min + 15;

    planItems.push({
      task: t.name,
      priority: t.priority,
      duration: t.duration_min,
      time: slotStartStr,
      completed: 0,
      source: t.source,
      goal_id: t.goal_id || null
    });
  }

  // Also include the fixed timetable classes in planItems for complete timeline visibility
  for (const b of timetableBlocks) {
    const bStart = parseTimeToMinutes(b.start_time);
    const bEnd = parseTimeToMinutes(b.end_time);
    planItems.push({
      task: b.subject,
      startMinutes: bStart,
      duration: (bEnd - bStart),
      source: 'fixed',
      kind: 'class',
      priority: 'medium',
      time: b.start_time,
      completed: 0
    });
  }

  // Sort planItems chronologically
  planItems.sort((a, b) => {
    const aMins = parseTimeToMinutes(a.time) || 0;
    const bMins = parseTimeToMinutes(b.time) || 0;
    return aMins - bMins;
  });

  // 7. Atomic transaction
  const tx = db.transaction(() => {
    // A. Update daily_settings for targetDateStr
    db.prepare(`
      INSERT INTO daily_settings (date, available_minutes, window_end_minutes)
      VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET available_minutes = ?, window_end_minutes = ?
    `).run(targetDateStr, budgetMinutes, 22 * 60, budgetMinutes, 22 * 60);

    // B. If restricted, remove unrequested incomplete tasks for targetDateStr
    if (isRestricted) {
      db.prepare(`
        DELETE FROM tasks
        WHERE date = ? AND completed = 0
      `).run(targetDateStr);
    }

    // C. Insert tasks
    for (const item of planItems) {
      if (item.source !== 'fixed') {
        const res = db.prepare(`
          INSERT INTO tasks (name, priority, source, completed, date, duration_min, time_slot, goal_id)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?)
        `).run(item.task, item.priority, item.source, targetDateStr, item.duration, item.time, item.goal_id);
        item.task_id = res.lastInsertRowid;
      }
    }

    // D. Update day_plans
    const existingPlan = db.prepare('SELECT id FROM day_plans WHERE date = ?').get(targetDateStr);
    if (existingPlan) {
      db.prepare('UPDATE day_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(planItems), existingPlan.id);
    } else {
      db.prepare('INSERT INTO day_plans (date, plan_json) VALUES (?, ?)').run(targetDateStr, JSON.stringify(planItems));
    }
  });

  tx();

  // Clear check-in session so the user is not locked
  clearPending();

  const taskText = taskSummaries.join(' and ');
  if (targetLabel === 'tomorrow') {
    return `Got it — ${taskText} tomorrow.`;
  } else {
    return `Got it — ${taskText} today.`;
  }
}

/**
 * Master Action Engine execution router
 * Returns a string reply if an action was handled, or null to fall through.
 */
function processNaturalLanguageAction(message, todayDateObj = new Date(), nowDate = new Date()) {
  const msg = message.trim();

  // 0. Do Not Generate Day Plan ("not generate day plan", "do not generate the day plan", "don't create day plan")
  const doNotGenReply = handleDoNotGenerate(msg);
  if (doNotGenReply !== null) return doNotGenReply;

  // 0.1 Show Day Plan ("show me today's plan", "what is my plan for today", "show tomorrow's plan")
  const showPlanReply = handleShowPlan(msg, todayDateObj);
  if (showPlanReply !== null) return showPlanReply;

  // 1. Named Goal Step Completion ("Today i have completed bfs topic of tree")
  const namedStepReply = handleNamedStepCompletion(msg, todayDateObj);
  if (namedStepReply !== null) return namedStepReply;

  // 2. Milestone Steps by number ("I finished the next two Spring Boot steps")
  const stepsReply = handleMilestoneSteps(msg, todayDateObj);
  if (stepsReply !== null) return stepsReply;

  // 3. Goal Progress Logging ("I completed two DSA problems", "I solved two LeetCode problems")
  const countReply = handleCountProgress(msg, todayDateObj);
  if (countReply !== null) return countReply;

  // 4. Progress Correction ("Correction: I solved only 1 DSA problem")
  const corrReply = handleGoalCorrection(msg, todayDateObj);
  if (corrReply !== null) return corrReply;

  // 4.5. Add Task ("I want a 45-minute DSA session today")
  const addReply = handleAddTask(msg, todayDateObj);
  if (addReply !== null) return addReply;

  // 5. Conversational Plan Updates & Restrictions ("Tomorrow I have to prepare for my German exam only and 2 LeetCode questions")
  const planReply = handleConversationalPlan(msg, todayDateObj, nowDate);
  if (planReply !== null) return planReply;

  // 6. Availability / Window updates ("I have only 1 hour available today")
  const availReply = handleAvailabilityUpdate(msg, todayDateObj, nowDate);
  if (availReply !== null) return availReply;

  // 7. Task Rescheduling ("Move database study session to 4 PM")
  const reschedReply = handleTaskReschedule(msg, todayDateObj);
  if (reschedReply !== null) return reschedReply;

  // 8. Priority Change ("Make my SEVA demo presentation high priority")
  const prioReply = handlePriorityChange(msg, todayDateObj);
  if (prioReply !== null) return prioReply;

  // 10. Habit notice ("I didn't run today")
  const habitReply = handleHabitNotice(msg, todayDateObj);
  if (habitReply !== null) return habitReply;

  // 11. Task completion ("I've finished my database study session")
  const taskCompReply = handleTaskCompletion(msg, todayDateObj);
  if (taskCompReply !== null) return taskCompReply;

  // 12. Important emails query ("Show me only important emails")
  const emailReply = handleEmailQuery(msg);
  if (emailReply !== null) return emailReply;

  return null;
}

module.exports = {
  processNaturalLanguageAction,
  findMatchingGoal,
  handleNamedStepCompletion,
  handleConversationalPlan,
  handleDoNotGenerate,
  handleShowPlan,
  handleCountProgress,
  handleMilestoneSteps,
  handleTaskReschedule,
  handlePriorityChange,
  handleAvailabilityUpdate,
  handleGoalCorrection,
  handleEmailQuery,
  handleAddTask
};
