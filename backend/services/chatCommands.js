/**
 * backend/services/chatCommands.js
 *
 * Deterministic command router for routes/chat.js.
 * Called BEFORE any AI call. Returns a reply string if the message was
 * handled, or null to fall through to the AI.
 *
 * Precedence (highest first):
 *  1. active pending state (removal confirmation OR check-in session)
 *  2. goal JSON import (message contains JSON with a "goals" array)
 *  3. window commands ("free till", "I have N hours", "done for today")
 *  4. "call me <name>"
 *  5. "steps for <goal title>: a; b; c"
 *  6. removal commands ("remove goal", "delete goal", "remove task")
 *  7. "plan tomorrow" trigger (Step 10 — stub for now, filled in later)
 *  8. return null → AI handles it
 *
 * Every command stores both its reply AND the user message in chat_history
 * via the calling route (this function only returns the reply text).
 *
 * Rule 9: NEVER hardcode a person's name. Use preferences.user_name.
 * Rule 8: All date logic accepts an injected todayDate (Date object).
 */

const db = require('../database/db');
const { importGoals, setGoalSteps } = require('./goalsService');
const { getTodayDate, parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');

// ─────────────────────────────────────────────────────────────
// SERVER-MEMORY PENDING STATE (single user; resets on restart)
// One slot for either a pending removal confirmation OR a check-in session.
// Starting a new session of either type cancels the other.
// ─────────────────────────────────────────────────────────────
let pendingState = null;  // { type: 'removal'|'checkin', ...data, expiresAt }
const REMOVAL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function clearPending() { pendingState = null; }

function isPendingExpired() {
  return pendingState && Date.now() > pendingState.expiresAt;
}

// Expose for nightly check-in (Step 10) to set/read its session
function setPendingState(state) { pendingState = state; }
function getPendingState() {
  if (pendingState && isPendingExpired()) {
    pendingState = null;
    return null;
  }
  return pendingState;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function getUserName() {
  const prefs = db.prepare('SELECT user_name FROM preferences WHERE id = 1').get();
  return prefs && prefs.user_name ? prefs.user_name : null;
}

function namePrefix() {
  const name = getUserName();
  return name ? `${name}, ` : '';
}

// YES/NO vocabulary (Hinglish included)
const YES_WORDS = new Set(['yes', 'y', 'ok', 'okay', 'haan', 'ha']);
const NO_WORDS  = new Set(['no', 'n', 'nahi', 'nahin']);

function isYes(text) { return YES_WORDS.has(text.trim().toLowerCase()); }
function isNo(text)  { return NO_WORDS.has(text.trim().toLowerCase()); }

// ─────────────────────────────────────────────────────────────
// 1. PENDING STATE HANDLER
// ─────────────────────────────────────────────────────────────
function handlePendingState(message, todayDate) {
  const state = getPendingState();
  if (!state) return null;

  const msg = message.trim();

  if (state.type === 'removal') {
    if (isYes(msg)) {
      // Execute the removal
      const result = executeRemoval(state);
      clearPending();
      return result;
    } else if (isNo(msg)) {
      clearPending();
      return `OK, keeping "${state.targetTitle}". Nothing was changed.`;
    } else {
      // Not a yes/no — let other handlers try; but re-confirm if no other match
      return null; // fall through — caller will retry other handlers
    }
  }

  if (state.type === 'checkin') {
    // Check-in session is handled by nightlyService (Step 10)
    // Stub: will be replaced
    return null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// REMOVAL EXECUTION (called when user confirms)
// ─────────────────────────────────────────────────────────────
function executeRemoval(state) {
  const todayStr = state.todayStr;

  if (state.removalType === 'goal') {
    // Soft-remove the goal
    db.prepare("UPDATE goals SET status='removed' WHERE id=?").run(state.targetId);
    // Delete INCOMPLETE tasks dated today or later
    db.prepare(`
      DELETE FROM tasks WHERE goal_id = ? AND completed = 0
      AND date >= ?
    `).run(state.targetId, todayStr);
    return `✓ Goal "${state.targetTitle}" removed. Completed tasks and progress history are preserved. You can restore it from the Goals screen.`;
  }

  if (state.removalType === 'task') {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(state.targetId);
    return `✓ Task "${state.targetTitle}" removed.`;
  }

  return '⚠️ Could not execute removal — unknown type.';
}

// ─────────────────────────────────────────────────────────────
// 2. GOAL JSON IMPORT HANDLER
// Detects if message contains a JSON object with a "goals" array.
// ─────────────────────────────────────────────────────────────
function handleGoalJsonImport(message, todayDate) {
  const trimmed = message.trim();
  // Quick heuristic: contains '{' and '"goals"'
  if (!trimmed.includes('{') || !trimmed.toLowerCase().includes('"goals"')) return null;

  // Try to extract and parse the JSON
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // Only trigger the error if it really looked like a goals payload
    if (trimmed.includes('"goals"')) {
      return `I found JSON but couldn't read it: ${e.message}`;
    }
    return null;
  }

  if (!parsed || !Array.isArray(parsed.goals)) return null;

  // It IS a goals import
  const todayStr = getTodayDate(todayDate);
  try {
    const result = importGoals(parsed, todayStr);
    let reply = `✓ Goals imported for ${result.month || 'this month'}: ${result.created} created, ${result.updated} updated.`;
    if (result.overdue.length > 0) {
      reply += `\n⚠️ Overdue (deadline already passed): ${result.overdue.join(', ')}.`;
    }
    return reply;
  } catch (err) {
    if (err.statusCode) {
      const detail = err.details ? `\n  • ${err.details.join('\n  • ')}` : '';
      return `Could not import goals: ${err.error}${detail}`;
    }
    return `Could not import goals: ${err.message || String(err)}`;
  }
}

// ─────────────────────────────────────────────────────────────
// 3. WINDOW COMMANDS
// Deterministic regexes, no AI.
// Stored in daily_settings; when "I have N" is for TODAY, absolute end
// is computed immediately so replanning never slides the endpoint.
// ─────────────────────────────────────────────────────────────

// "free till 9 PM" / "free until 10:30 pm"
const RE_FREE_TILL = /\bfree\s+(?:till|until)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i;
// "I have 4 hours" / "I have 90 minutes"
const RE_HAVE_TIME = /\bi\s+have\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i;
// "done for today"
const RE_DONE_TODAY = /\bdone\s+for\s+(?:today|the\s+day)\b/i;

function handleWindowCommands(message, todayDate, now) {
  const nowDate = now || new Date();
  const todayStr = getTodayDate(todayDate);

  // "done for today"
  if (RE_DONE_TODAY.test(message)) {
    db.prepare(`
      INSERT INTO daily_settings (date, done_for_day) VALUES (?, 1)
      ON CONFLICT(date) DO UPDATE SET done_for_day = 1
    `).run(todayStr);
    return `✓ Marked as done for today. The scheduler won't add anything more.`;
  }

  // "free till / until <time>"
  const mTill = message.match(RE_FREE_TILL);
  if (mTill) {
    let timeStr = mTill[1].trim();
    // Normalize: if no colon (e.g. "9 PM"), add ":00"
    if (!timeStr.includes(':')) {
      timeStr = timeStr.replace(/(\d+)\s*(AM|PM)/i, '$1:00 $2');
    }
    const endMins = parseTimeToMinutes(timeStr);
    if (endMins === null) {
      return `I couldn't parse that time ("${mTill[1]}"). Try something like "free till 9:00 PM".`;
    }
    db.prepare(`
      INSERT INTO daily_settings (date, window_end_minutes) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET window_end_minutes = ?
    `).run(todayStr, endMins, endMins);
    return `✓ Window set: now until ${minutesToTimeString(endMins)} today.`;
  }

  // "I have N hours/minutes"
  const mHave = message.match(RE_HAVE_TIME);
  if (mHave) {
    const amount = parseFloat(mHave[1]);
    const unit = mHave[2].toLowerCase();
    let budgetMins;
    if (unit.startsWith('h')) {
      budgetMins = Math.round(amount * 60);
    } else {
      budgetMins = Math.round(amount);
    }
    if (budgetMins < 1 || budgetMins > 960) {
      return `That time budget (${budgetMins} min) seems out of range. Try something between 15 minutes and 16 hours.`;
    }
    const nowMins = nowDate.getHours() * 60 + nowDate.getMinutes();
    const endMins = nowMins + budgetMins;
    db.prepare(`
      INSERT INTO daily_settings (date, window_end_minutes, available_minutes) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET window_end_minutes = ?, available_minutes = ?
    `).run(todayStr, endMins, budgetMins, endMins, budgetMins);
    return `✓ Window set: now until ${minutesToTimeString(endMins)} (${budgetMins} minutes from now).`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 4. "call me <name>"
// ─────────────────────────────────────────────────────────────
const RE_CALL_ME = /^\s*call\s+me\s+(.+?)\s*$/i;

function handleCallMe(message) {
  const m = message.match(RE_CALL_ME);
  if (!m) return null;
  const rawName = m[1].trim();
  if (!/^[A-Za-z\s.]{1,40}$/.test(rawName)) {
    return `That name doesn't look right. Names can be 1–40 characters: letters, spaces, and dots only.`;
  }
  db.prepare('UPDATE preferences SET user_name = ? WHERE id = 1').run(rawName);
  return `Got it! I'll call you ${rawName} from now on.`;
}

// ─────────────────────────────────────────────────────────────
// 5. "steps for <goal title>: a; b; c"
// ─────────────────────────────────────────────────────────────
const RE_STEPS_FOR = /^\s*steps?\s+for\s+(.+?)\s*:\s*(.+)\s*$/i;

function handleStepsFor(message) {
  const m = message.match(RE_STEPS_FOR);
  if (!m) return null;

  const titleQuery = m[1].trim();
  const stepsPart = m[2].trim();

  // Find matching active milestone goals
  const activeGoals = db.prepare(
    "SELECT id, title, goal_type FROM goals WHERE status = 'active'"
  ).all();

  // Exact match first (case-insensitive)
  let matched = activeGoals.filter(g => g.title.toLowerCase() === titleQuery.toLowerCase());
  if (matched.length === 0) {
    // Unique substring match
    matched = activeGoals.filter(g => g.title.toLowerCase().includes(titleQuery.toLowerCase()));
  }

  if (matched.length === 0) {
    const titles = activeGoals.map(g => `"${g.title}"`).join(', ');
    return `No active goal matches "${titleQuery}". Active goals: ${titles || 'none'}.`;
  }
  if (matched.length > 1) {
    const titles = matched.map(g => `"${g.title}"`).join(', ');
    return `"${titleQuery}" matches multiple goals: ${titles}. Please be more specific.`;
  }

  const goal = matched[0];
  if (goal.goal_type !== 'milestone') {
    return `"${goal.title}" is a ${goal.goal_type} goal, not a milestone. Steps only apply to milestone goals.`;
  }

  // Parse steps: split on semicolons, or commas if no semicolons
  const rawSteps = stepsPart.includes(';')
    ? stepsPart.split(';')
    : stepsPart.split(',');
  const steps = rawSteps.map(s => s.trim()).filter(Boolean);

  if (steps.length === 0) return `No steps found after the colon. Try: "steps for ${goal.title}: step 1; step 2"`;
  if (steps.length > 10) return `Maximum 10 steps allowed (you provided ${steps.length}).`;
  const tooLong = steps.filter(s => s.length > 100);
  if (tooLong.length > 0) return `Some steps are too long (max 100 chars each): "${tooLong[0].substring(0, 60)}..."`;

  setGoalSteps(goal.id, steps);
  return `✓ Steps set for "${goal.title}":\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\nTicked steps were kept.`;
}

// ─────────────────────────────────────────────────────────────
// 6. REMOVAL COMMANDS
// "remove goal <text>", "delete goal <text>", "remove task <text>"
// ─────────────────────────────────────────────────────────────
const RE_REMOVE_GOAL = /^\s*(?:remove|delete)\s+goal\s+(.+?)\s*$/i;
const RE_REMOVE_TASK = /^\s*remove\s+task\s+(.+?)\s*$/i;

function handleRemovalCommand(message, todayDate) {
  const todayStr = getTodayDate(todayDate);

  const mGoal = message.match(RE_REMOVE_GOAL);
  if (mGoal) {
    return initiateRemoval('goal', mGoal[1].trim(), todayStr);
  }

  const mTask = message.match(RE_REMOVE_TASK);
  if (mTask) {
    return initiateRemoval('task', mTask[1].trim(), todayStr);
  }

  return null;
}

function initiateRemoval(type, query, todayStr) {
  let candidates;
  if (type === 'goal') {
    candidates = db.prepare("SELECT id, title FROM goals WHERE status = 'active'").all();
  } else {
    candidates = db.prepare(
      "SELECT id, name as title FROM tasks WHERE completed = 0 AND date >= ?"
    ).all(todayStr);
  }

  // Exact match first
  let matched = candidates.filter(c => c.title.toLowerCase() === query.toLowerCase());
  if (matched.length === 0) {
    matched = candidates.filter(c => c.title.toLowerCase().includes(query.toLowerCase()));
  }

  if (matched.length === 0) {
    const list = candidates.map(c => `"${c.title}"`).join(', ');
    const label = type === 'goal' ? 'active goals' : 'incomplete tasks';
    return `No ${label} match "${query}". ${label.charAt(0).toUpperCase() + label.slice(1)}: ${list || 'none'}.`;
  }
  if (matched.length > 1) {
    const titles = matched.map(c => `"${c.title}"`).join(', ');
    return `"${query}" matches multiple ${type}s: ${titles}. Please be more specific.`;
  }

  const target = matched[0];
  // Set pending confirmation
  pendingState = {
    type: 'removal',
    removalType: type,
    targetId: target.id,
    targetTitle: target.title,
    todayStr,
    expiresAt: Date.now() + REMOVAL_TIMEOUT_MS
  };

  return `Remove ${type} "${target.title}"? Reply yes to confirm (or no to cancel). This expires in 2 minutes.`;
}

// ─────────────────────────────────────────────────────────────
// 7. "plan tomorrow" trigger (STUB — Step 10 fills this in)
// ─────────────────────────────────────────────────────────────
const RE_PLAN_TOMORROW = /\b(?:plan(?:\s+(?:my|for))?\s+tomorrow|tomorrow(?:'s)?\s+plan|raw\s+plan\s+for\s+tomorrow)\b/i;

function handlePlanTomorrow(message, todayDate) {
  if (!RE_PLAN_TOMORROW.test(message)) return null;
  // Step 10 will replace this stub
  return `The nightly check-in (Step 10) is coming — not yet wired up.`;
}

// ─────────────────────────────────────────────────────────────
// MAIN ROUTER — called from routes/chat.js BEFORE the AI call
// Returns reply string if handled, null to pass to AI.
// todayDate is a Date object (injected for testability).
// now is the current Date (injected for window calc); defaults to new Date().
// ─────────────────────────────────────────────────────────────
function routeCommand(message, todayDate, now) {
  const nowDate = now || new Date();
  const todayDt = todayDate || new Date();

  // 1. Pending state (removal confirmation or check-in reply)
  const pendingReply = handlePendingState(message, todayDt);
  if (pendingReply !== null) return pendingReply;

  // 2. Goal JSON import
  const importReply = handleGoalJsonImport(message, todayDt);
  if (importReply !== null) return importReply;

  // 3. Window commands
  const windowReply = handleWindowCommands(message, todayDt, nowDate);
  if (windowReply !== null) return windowReply;

  // 4. "call me <name>"
  const callMeReply = handleCallMe(message);
  if (callMeReply !== null) return callMeReply;

  // 5. "steps for <goal>: ..."
  const stepsReply = handleStepsFor(message);
  if (stepsReply !== null) return stepsReply;

  // 6. Removal commands
  const removalReply = handleRemovalCommand(message, todayDt);
  if (removalReply !== null) return removalReply;

  // 7. "plan tomorrow"
  const planReply = handlePlanTomorrow(message, todayDt);
  if (planReply !== null) return planReply;

  // 8. Fall through to AI
  return null;
}

module.exports = {
  routeCommand,
  getPendingState,
  setPendingState,
  clearPending,
  RE_PLAN_TOMORROW,
  RE_FREE_TILL,
  RE_HAVE_TIME,
  RE_DONE_TODAY,
  isYes,
  isNo,
  getUserName,
  namePrefix
};
