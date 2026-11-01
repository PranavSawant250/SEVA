# Phase 4 — Planning Engine

## Overview
Phase 4 builds SEVA's core intelligence — the system that takes emails, tasks, and
your fixed class schedule and produces a realistic hour-by-hour day plan using phi3.5.

---

## Key Concepts Learned

### 1. Single Source of Truth for Tasks
Instead of having generateDayPlan() query both `emails` AND `tasks` tables, we funnel
everything through the `tasks` table first:

```
Email arrives → AI analyses it (Phase 3) → User accepts it (Step 0) → tasks table row inserted
Manual task added → tasks table row inserted
generateDayPlan() queries ONLY tasks table
```

This keeps the planner simple and avoids complex joins.

### 2. Accept/Dismiss Pattern (Step 0)
- `accepted = 0` → unreviewed email
- `accepted = 1` → approved, task row created in `tasks` (source = 'email')
- `accepted = 2` → dismissed (soft delete, stays in DB for audit)

The accept endpoint uses a **SQLite transaction** — both the `UPDATE emails` and the
`INSERT INTO tasks` happen atomically. Either both succeed or both are rolled back.

```js
const acceptAndInsert = db.transaction(() => {
  db.prepare('UPDATE emails SET accepted = 1 WHERE id = ?').run(emailId);
  const result = db.prepare('INSERT INTO tasks ...').run(...);
  return result.lastInsertRowid;
});
```

### 3. Array vs Object JSON Extraction (Critical)
Phase 3's `extractJsonString()` extracted `{...}` objects.
Phase 4's AI response is a `[...]` array — completely different brackets.
**Never reuse the object extractor for array responses.**

```js
// Object extractor (aiService.js — Phase 3)
function extractObjectJsonString(raw) {
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  return raw.substring(first, last + 1);
}

// Array extractor (plannerService.js — Phase 4)  ← NEW
function extractArrayJsonString(raw) {
  const first = raw.indexOf('[');
  const last  = raw.lastIndexOf(']');
  return raw.substring(first, last + 1);
}
```

### 4. Per-Item Validation (Defense in Depth)
Even after JSON.parse succeeds, the model can return:
- Items with no `task` field (useless — drop the item)
- Invalid priority strings — coerce to 'medium'
- Negative or NaN duration — default to 30 minutes
- Null/missing time — set to null (unscheduled is fine)

```js
function validatePlanItem(item) {
  if (!item.task || !item.task.trim()) return null;  // DROP
  const priority = ALLOWED_PRIORITIES.includes(rawPriority) ? rawPriority : 'medium';
  const duration = (isNaN(d) || d <= 0) ? 30 : d;
  ...
}
```

### 5. INSERT vs UPDATE for day_plans
`generateDayPlan()` and `replan()` both call `savePlanToDb()`:
- If a row for today already exists → `UPDATE plan_json + generated_at`
- If no row exists → `INSERT`
- `replan()` always updates (never inserts a second row for the same day)

### 6. remainingHours is Server-Computed
The `replan()` endpoint does NOT accept `remainingHours` from the client.
It computes it server-side: `(endOfDay - now) / 3600000`
This prevents clients from sending garbage values.

### 7. Fallback Plan (Never Crash)
If Ollama fails or returns unparseable output:
- Sort tasks by `time_slot` (nulls last)
- Wrap each in the `{time, task, priority, duration, source}` shape
- Log a clear warning that the fallback was used

---

## Files Created/Modified in Phase 4

| File | Change |
|------|--------|
| `backend/routes/gmail.js` | Added `POST /api/emails/accept/:id` and `/dismiss/:id` |
| `backend/routes/tasks.js` | Replaced all stubs with real SQLite queries |
| `backend/routes/plan.js` | Replaced stubs with real planner calls |
| `backend/services/plannerService.js` | Full implementation of `generateDayPlan()` and `replan()` |
| `backend/scripts/test-planner.js` | Standalone test script for 3 scenarios |

---

## API Endpoints Added

| Method | URL | What it does |
|--------|-----|-------------|
| POST | `/api/emails/accept/:id` | Accepts email, creates task row |
| POST | `/api/emails/dismiss/:id` | Dismisses email (accepted = 2) |
| GET  | `/api/plan/generate` | AI generates + saves today's plan |
| GET  | `/api/plan/today` | Returns saved plan from DB (no AI call) |
| POST | `/api/plan/replan` | Replans remaining day around surprise event |
| GET  | `/api/tasks` | Returns today's tasks from SQLite |
| POST | `/api/tasks` | Adds manual task (normalizes date:"today") |
| PATCH| `/api/tasks/:id/complete` | Marks task completed |
| DELETE| `/api/tasks/:id` | Deletes task |

---

## Test Commands

```bash
# In backend folder:
node scripts/test-planner.js

# Postman / browser:
GET  http://localhost:3001/api/tasks
POST http://localhost:3001/api/tasks          { "name":"Study","priority":"high","date":"today" }
POST http://localhost:3001/api/emails/accept/3
GET  http://localhost:3001/api/plan/generate
GET  http://localhost:3001/api/plan/today
POST http://localhost:3001/api/plan/replan    { "surpriseEvent":"Meeting at 3PM" }
PATCH http://localhost:3001/api/tasks/1/complete
```

---

## Known Issues Found & Fixed (Viva Q&A Material)

### 1. Date & Timezone Mismatch Bug (UTC vs. Local Time)
* **Problem**: `new Date().toISOString().split('T')[0]` was used across all date calculations. `.toISOString()` outputs dates in UTC time. For servers running in IST (`+05:30`), any call between 12:00 AM IST and 05:30 AM IST computed yesterday's date (e.g., `2026-09-19` instead of `2026-09-20`). This caused day plan queries and task lookups to operate on the wrong calendar day for 5.5 hours every night.
* **Solution**: Created a centralized utility `backend/utils/dateUtils.js` exporting `getTodayDate()` that formats `YYYY-MM-DD` using local server time (`getFullYear()`, `getMonth()`, `getDate()`). Updated all routes (`plan.js`, `tasks.js`, `gmail.js`) and services (`plannerService.js`, `gmailService.js`).

### 2. AI Task Hallucination & Whitelist Safeguards
* **Problem**: During `replan()`, local Ollama (`phi3.5`) hallucinated fabricated non-existent tasks (e.g., `"Data Structures Study"`, `"Relaxation"`, `"Learn New Technologies"`).
* **Attempt 1 (Task Whitelist)**: Added an `allowedTaskNames` whitelist in `validatePlanItem()` filtering AI tasks against `incompleteTasks`. This dropped generic hallucinations, but also accidentally dropped the `surpriseEvent` slot itself (e.g., `"Surprise Viva"`), because the one-off surprise event string is not stored in the `tasks` table.
* **Attempt 2 (Fuzzy Token Matching Flaw)**: Attempted keyword matching to pass the surprise event. This opened a flaw where fabricated tasks sharing a keyword (e.g., `"DBMS Study Session"` sharing `"DBMS"`) slipped through.
* **Final Solution**:
  1. **Strict Exact Whitelist**: Restored 100% strict exact/trimmed whitelist matching in `validatePlanItem()` for all AI-generated items against `incompleteTasks.map(t => t.name)`. Zero hallucinated tasks or keyword leniencies allowed.
  2. **Server-Side Guaranteed Injection**: In `replan()`, the server extracts the time from `surpriseEvent` (e.g., `"2 PM"`) and injects a guaranteed slot `{ time: "2 PM", task: surpriseEvent, priority: "high", duration: 60, source: "surprise_event" }` directly into the final plan array. The AI is strictly restricted to scheduling real incomplete tasks around the surprise event.

### 3. Duplicate Task Scheduling in Day Plan Generation
* **Problem**: `parseAndValidatePlanArray()` whitelisted tasks against real tasks in SQLite, but did not track which task names had already been scheduled in the current plan. When local Ollama (`phi3.5`) generated a plan, it often repeated the same task 2–3 times (e.g., `"Review Database lecture notes"` at 9 AM, 1:45 PM, and 5 PM). Furthermore, `buildFallbackPlan()` also generated duplicate slots when carry-forward tasks with the same name existed on past dates.
* **Solution**: Introduced a `seenTaskNames` `Set` in both `parseAndValidatePlanArray()` and `buildFallbackPlan()` in `plannerService.js`. Subsequent occurrences of any task name already present in the current plan are dropped and logged with a warning, guaranteeing every real task appears exactly once per plan.

### 4. Date-Scoped Task Matching & Checkbox Completion Sync (`DayPlan.jsx` & `tasks.js`)
* **Problem**: `findMatchingTask()` in `DayPlan.jsx` matched plan items against the global task list using task name substring matching without date filtering. When tasks carried forward across multiple dates shared identical names, `Array.find()` matched the oldest task row (e.g. from `2026-09-29`) instead of today's task. Checking off a task on today's Day Plan updated an old completed row while leaving today's task uncompleted in the database.
* **Solution**: Updated `findMatchingTask()` in `DayPlan.jsx` to scope candidate task lookup to `todayDate` first before matching by name. Additionally, updated `PATCH /api/tasks/:id/complete` in `routes/tasks.js` to stamp the completed task's date to today (`getTodayDate()`) if it was an active carry-forward task from a prior date, ensuring `generateNightSummary()` accurately captures today's completed tasks.


