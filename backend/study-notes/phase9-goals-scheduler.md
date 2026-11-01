# Phase 9 — Goals, Scheduler & Nightly Check-In

**Status:** In progress — Steps 0–5 complete, Steps 6–10 building.

---

## Step 0 — Schema (COMPLETE)

### Concept
Add 5 new tables and 6 nullable/default columns on `tasks` to support goals, progress tracking, scheduling windows, and user preferences. All changes are additive and guarded — no existing data is altered.

### Design Decisions
- **Guarded ALTER TABLE** (`db.js` reads `PRAGMA table_info` before every `ALTER TABLE`): SQLite has no `ADD COLUMN IF NOT EXISTS`, and `db.js` runs on every server boot. Without this guard, the second boot would throw and crash. Proved: Boot 1 adds columns; Boot 2 prints nothing.
- **`preferences.id CHECK(id=1)` + `INSERT OR IGNORE`**: Enforces single-row semantics without a trigger or application-level lock.
- **`daily_settings.window_end_minutes` stores ABSOLUTE minutes since midnight**: when the user says "I have 4 hours" for TODAY, code converts `now + 4 hours` immediately to absolute minutes. `available_minutes` keeps the raw input for reference and is reused as the check-in budget for tomorrow.
- **`parseTimeToMinutes()` moved to `utils/dateUtils.js`**: all services import from one place; `timetable.js` now imports from there instead of defining its own copy. Sorting test: 9:00 AM → 540 < 1:00 PM → 780. ✅
- **Regex decisions**:
  - `per_week`: `/(\d+)\s*days?\s*(?:per\s*week|\/week)|(\d+)\/week/i` — "5 days" bare does NOT match.
  - `target_count`: `/(\d+)\s*(?:problems?|questions?)/i`
  - Step-splitting: commas into 2–5 items; trailing `done|complete|completed|connected` stripped from last item only.

### Step-splitting results for the 6 sample goals
| Goal | Steps |
|---|---|
| Spring Boot Basics | Controllers / Services / Repositories |
| PostgreSQL + Spring Boot | *(no split — 1 item; step-less milestone)* |
| LeetCode 320 | *(count goal — no steps)* |
| Trees topic | BFS / DFS / traversals complete |
| Shell Scripting Lab | *(no split — step-less milestone)* |
| Daily run | *(frequency goal — no steps)* |

### Files Changed
- `backend/database/db.js` — rewritten with 5 new tables + guarded ALTER columns
- `backend/utils/dateUtils.js` — added `parseTimeToMinutes`, `minutesToTimeString`, `getTomorrowDayOfWeek`, `getWeekMondayDate`, `getWeekSundayDate`, `daysBetween`
- `backend/routes/timetable.js` — imports `parseTimeToMinutes` from utils; local copy removed

### Tests Run
```
Boot 1: 6 "📐 Added column" lines for tasks.goal_id, due_date, fixed_start, fixed_end, duration_min, is_urgent
Boot 2: zero "📐 Added" lines — guard prevents duplicate ALTER TABLE
PRAGMA table_info(tasks): 14 columns ✅
PRAGMA table_info(preferences): user_name, neglect_days present ✅
.tables: 12 tables including goals, goal_progress_log, goal_steps, daily_settings, preferences ✅
parseTimeToMinutes("9:00 AM") = 540 < parseTimeToMinutes("1:00 PM") = 780 ✅
```

---

## Steps 1–4 — Goal Import, Progress Tracking, Daily Window & Pure Scheduler (COMPLETE)

### Concept & Design Decisions
- **Step 1 (`POST /api/goals/import` & `services/chatCommands.js`)**: Deterministic JSON validation (max 30 goals, non-empty title/category, valid `YYYY-MM-DD`, priority `high|medium|low`), deterministic `goal_type` inference (`frequency`, `count`, `milestone`), transaction-wrapped upsert by case-insensitive active title, and chat command router executed before any AI call.
- **Step 2 (`GET /api/goals`, `/log`, `/steps/:stepId`, `PATCH /api/goals/:id`)**: Computes progress (`manual`, `count`, `frequency` Mon–Sun, `milestone_steps`, `no_progress_data`, `completed`), `expected_progress` (100% when deadline has arrived/passed), `behind_by`, `is_overdue`, `days_since_activity`, and `last_logged_today`.
- **Step 3 (`/api/settings/today`, `/api/settings/preferences`)**: Stores absolute `window_end_minutes` (`now + N` when user states duration for today) so replanning never slides the end of the day. No fixed wake or sleep time.
- **Step 4 (`services/schedulerService.js`)**: Pure shared brain (`allocateFlexibleWork`, `buildDaySchedule`, `buildDayOutline`) with 0 `new Date`/`Date.now`/database imports:
  - Layer order: Fixed → Urgent Academic → Forced → Habits → Neglect Floor (`FLOOR_MINS = 30`, `MAX_FLOOR_PER_DAY = 2`, `DEFAULT_NEGLECT_DAYS = 3` documented as configurable policy assumptions) → Score-ranked Goal Work (with `MAX_GOAL_SHARE = 0.5`, `MAX_BLOCK_MINS = 120`, and `aging = 1 + 0.1 * min(dsa, 10)`) → Flexible Tasks.
  - Unified segment buffer accounting via `segMetrics(seg, bufferMinutes)` so `largest free gap X min (Y usable after buffers)` is consistent across empty and populated segments with `leftFlex`/`rightFlex`.
  - Neglect floor sessions are reported separately in `floorSessions` (not in `shrunk`).

---

## Step 5 — Wire Into Generate and Replan (COMPLETE)

### Concept
Connect the pure scheduler (`schedulerService.js`) to `GET /api/plan/generate`, `POST /api/plan/replan`, `PATCH /api/tasks/:id/complete`, and `DayPlan.jsx`, while keeping the legacy AI planner reachable behind `PLANNER_ENGINE=scheduler|ai` (default `scheduler`).

### Design Decisions & Real-Data Findings
1. **Real Data First (`buildScheduleFromDb` against `seva.db`)**:
   - Running against the real `seva.db` uncovered two mismatches between `getAllGoals()` and fixtures:
     - `getAllGoals()` did not return `last_logged_today` (needed by Layer 4 habit check `if (habit.last_logged_today) continue`). Fixed in `computeGoalProgress()` by checking `goal_progress_log` for `(goal_id, todayDateStr)`.
     - Overdue goals imported after their deadline had `totalDays <= 0`, causing `expected_progress` and `behind_by` to evaluate to `0` instead of `100`. Fixed in `computeGoalProgress()` so any goal with `daysBetween(todayDateStr, goal.deadline) <= 0` has `expected_progress = 100`.
2. **Flexible `time_slot` Parsing**:
   - `parseTimeToMinutes()` in `utils/dateUtils.js` now accepts `"9AM"`, `"9 AM"`, `"9:00 AM"`, and `"3:30 PM"`. Unparseable values (`"banana"`) return `null` without throwing, ignore the bad preference, and place the block in the first free gap (`placeEarliest: true`).
3. **One Task Row Per `(goal_id, date)` (`persistGoalTasksForPlan`)**:
   - Goal-derived and habit-derived blocks are persisted in `tasks` (`source = 'goal'`, `goal_id`, `date = today`), reusing any existing row for `(goal_id, date)`. Calling `GET /api/plan/generate` 3 times produces `row_count = 1` per scheduled goal.
4. **Reversible Progress on Task Check/Uncheck (`PATCH /api/tasks/:id/complete`)**:
   - Guarded against same-state calls (`wasCompleted === willBeCompleted` returns `unchanged: true`, preventing double-counting).
   - Logs provenance in `goal_progress_log.note` (`task:<id>`, `task:<id>:step:<stepId>`, `worked:task:<id>`) so unchecking (`1 → 0`) reverses the exact count increment, unticks the exact step, or deletes the exact `'worked'` / frequency log.

### Files Changed
- `backend/utils/dateUtils.js`
- `backend/services/goalsService.js`
- `backend/services/schedulerService.js`
- `backend/services/plannerService.js`
- `backend/routes/plan.js`
- `backend/routes/tasks.js`
- `backend/routes/settings.js`
- `seva-frontend/src/screens/DayPlan.jsx`
- `backend/scripts/test-scheduler.js`
- `backend/scripts/test-step5.js`


---

## Step 6 — Carry Forward Until Done or Removed; Removal via Chat

- **Goal vs Standalone Carry-Forward (`backend/services/summaryService.js`)**:
  - `generateNightSummary(todayDateObj, opts)` filters `carryForwardTasks` to non-goal tasks (`goal_id == null`) with `high` or `medium` priority.
  - Goal tasks (`goal_id != null`) are never copied forward as `'carry_forward'` rows because active goals recompute fresh daily tasks on the next day's plan based on remaining work.
  - Extended duplicate guard skips inserting into tomorrow if any incomplete task (`completed = 0`) for tomorrow already matches `LOWER(TRIM(name))` or `goal_id`, regardless of `source`.
  - Computes deterministic `behind_pace_goals` (no AI) for both `GET /api/summary/generate` and `GET /api/summary/history`, rendered on `NightSummary.jsx`.
- **Two-Step Removal via Chat (`backend/services/chatCommands.js`)**:
  - Supports `"remove goal <text>"`, `"delete goal <text>"`, and `"remove task <text>"` with a 2-minute confirmation window (`yes/y/ok/okay/haan/ha` and `no/n/nahi/nahin`).
  - Expired confirmations return a deterministic message (`"Confirmation for ... expired. Nothing was removed."`) instead of falling through to AI.
  - Starting a new session (e.g. `"plan tomorrow"`) cancels any active removal confirmation and notifies the user.
  - Goal removal sets `status = 'removed'` and deletes only incomplete (`completed = 0`) tasks dated `>= today`, preserving completed tasks and `goal_progress_log`.


---

## Step 7 — Reminders by Importance (In-App Only)

- **`GET /api/goals/reminders` (`backend/services/goalsService.js`, `backend/routes/goals.js`)**:
  - 100% deterministic (zero AI calls).
  - Rules:
    - `progress_source === 'no_progress_data'` skips behind-pace rules (`behind_by`) and includes `'info'` reminder: `"No steps defined. Say 'steps for <goal>: a; b; c' or set progress manually."`
    - `deadline` within 3 days (`days_left <= 3`) with `progress < 100`, or `is_overdue` → `'urgent'`
    - `priority === 'high'` and `behind_by >= 10` → `'urgent'`
    - `priority === 'medium'` and `behind_by >= 20` → `'warning'`
    - `days_since_activity >= neglect_days` → `'warning'` (`"No progress in N days"`)
    - `priority === 'low'` and `behind_by >= 30` → `'info'`
  - Sorted `urgent` → `warning` → `info`, then `high` → `medium` → `low`, capped at 6 items.
- **Dashboard (`seva-frontend/src/screens/Dashboard.jsx`)**:
  - Fetches `/goals/reminders` and `/settings/today` in parallel with existing Dashboard calls.
  - Renders Today's Window Control (`"Free till 9 PM"`, `"Free till 11 PM"`, `"+2h"`, `"Done for today"`) and the In-App Reminders Banner (stating explicitly that reminders appear in-app when SEVA is open; no push notifications).


---

## Step 8 — Chat Knows the Goals

- **`chatWithSeva()` (`backend/services/aiService.js`)**:
  - Injects into the system prompt (never trimmed by the safety valve; only oldest `chat_history` messages are trimmed):
    - Active goals with real `progress`, `expected_progress`, `behind_by`, `days_left`, and `is_overdue` (one compact line each)
    - Today's window (`getTodayWindow`) and today's saved plan
    - Tasks already planned for tomorrow (`WHERE date = tomorrow AND completed = 0`)
    - Strict grounding instruction: `"Only state goal progress numbers that appear in the context above. If the user asks about a goal that is NOT listed under Active Goals above, state clearly that no such goal exists."`
  - Verified with 4 prompts (`"how am I doing on my goals?"`, `"what should I focus on today?"`, `"how is my Rust goal going?"`, `"what did we plan for tomorrow?"`).

---

## Step 9 — Goals Screen

- **`seva-frontend/src/screens/Goals.jsx`**, **`seva-frontend/src/App.js`**, **`seva-frontend/src/layouts/Shell.jsx`**:
  - Added `"Goals"` (`Target` icon, after Dashboard) to sidebar navigation and `/goals` route.
  - Supports loading, error, and empty states, plus a `"Paste Goals JSON"` box (`POST /api/goals/import`).
  - Groups goal cards by `category`, showing `title`, `priority` badge, progress bar labeled `Auto` / `Manual`, expected-vs-actual marker, `days_left` or `OVERDUE`, count (`current/target`), frequency (`days_this_week/per_week`), and milestone step checklist with interactive tick boxes (`PATCH /api/goals/:id/steps/:stepId`).
  - Quick actions: `+1 Problem` (count), `Done today` (frequency), manual override with `Clear override` (`manual_progress: null`), `Mark complete`, and `Show removed` toggle with `Restore` button.

---

## Step 10 — Nightly Check-In ("plan tomorrow") & Honest Limitations

- **`backend/services/nightlyService.js`**, **`backend/routes/nightly.js`**, **`backend/services/chatCommands.js`**, **`seva-frontend/src/screens/Chat.jsx`**:
  - Implemented 100% deterministic Nightly Check-In conversation flow (`ASKING_HOURS` → `CONFIRMING_ADDITIONS` → committed) with 10-minute session TTL (`SESSION_TTL_MS = 10 * 60 * 1000`).
  - Central `GRAMMAR` constants table at top of `nightlyService.js` supports English + Hinglish triggers, budget phrases (`"4 hours"`, `"90 minutes"`, `"2.5 hrs"`, `"3h 30m"`, `"4"`, `"none"`), confirmation phrases (`"1 and 2"`, `"all"`, `"skip"`, `"also add ..."`), and `cancel`/`abort`/`stop` at any stage.
  - Stage 1 (`startNightlyCheckIn`) records no mutations until Stage 2; Stage 1 reply saves tomorrow's `available_minutes` in `daily_settings`, runs `buildDayOutline` (`enableFloor: false`) around tomorrow's timetable, urgent tasks, forced items, and habits, and lists up to 6 numbered suggestions sorted by `overdue` → `squeezed out` → `no progress in N days` → `behind pace` → `incomplete task from today`.
  - Stage 2 (`CONFIRMING_ADDITIONS`) executes inside `db.transaction()`: creates/updates tomorrow's goal tasks (`carry_forward = 1`, routed to Layer 3 `forced` on tomorrow's schedule), carries forward selected incomplete tasks (updating existing row's `date = tomorrowDate, carry_forward = 1` instead of duplicating), and inserts `"also add ..."` manual tasks with optional time and duration extraction.
  - Added `POST /api/nightly/start`, `POST /api/nightly/reply`, `GET /api/nightly/state`, `POST /api/nightly/cancel`, and `"Plan tomorrow"` quick button in `Chat.jsx`.

---

## Final Hardening & Verification (Items 1–10)

- **Test Isolation (`SEVA_DB_PATH`)**: Added `process.env.SEVA_DB_PATH` support in `backend/database/db.js` (defaulting to `backend/seva.db`). Every test script copies `seva.db` to an OS temp file on startup and deletes the temp `.db`/`.db-wal`/`.db-shm` files on exit so live `seva.db` rows are never mutated by tests.
- **Fit Check & Single-Calculation Gap Stats**: `assignOn` and `B2` in `schedulerService.js` compute `maxAvail` and `maxRaw` from the single `segMetrics` call on the best segment and give all budget-deferred blocks a second chance on the clock when `usable gap >= N`.
- **High-Priority Manual/Email Tasks Layer (`LAYER 4a`)**: High-priority flexible tasks (`priority === 'high'`) are scheduled after habits and before score-ranked goal work, while `medium`/`low` flexible tasks remain in Layer 6 after goal work.
- **Shared `computeDaysSinceActivity`**: Centralized in `utils/dateUtils.js` (`days since last log, else since created_date`, never `999`) and shared across `goalsService.js`, `schedulerService.js` (scoring + neglect floor), and `getGoalReminders`.
- **Idempotent Task Completion & Partial-Unit Rule (`routes/tasks.js`)**: `PATCH /api/tasks/:id/complete` is strictly idempotent across repeated `{completed: 1}` and `{completed: 0}` calls, restores `status = 'active'` when unchecking a completed goal, and logs `'worked'` without ticking steps if a milestone block is shorter than one full 60-min unit.
- **One Reminder Per Goal (Strongest Level Only)**: `getGoalReminders` emits at most one entry per goal using only its strongest triggered severity level (`urgent` > `warning` > `info`).
