# Phase 5 — Conversational Chat & Night Summary

## Overview
Phase 5 introduces SEVA's interactive conversational layer and end-of-day analytics. The Chat engine uses the context of the user's current day plan and pending tasks to answer queries conversationally. The Night Summary engine performs an end-of-day reflection, calculates productivity streaks, and automatically carries forward missed high/medium priority tasks to tomorrow.

---

## Key Concepts Learned

### 1. Context-Window Trimming for Chat
To prevent unbounded prompt growth, we don't load the entire permanent `chat_history`. We only fetch the last 10 messages from today using a localized `getTodayDate()` query.
Furthermore, we exclude the user's current inserted message from the history fetch to prevent the model from seeing its own upcoming question duplicated.

### 2. Plain Text Generation (No format: 'json')
Unlike Phases 3 and 4 where structured data extraction was required, Phase 5's AI output is free text (conversational responses and `seva_message` summaries). Forcing `format: 'json'` for simple text leads to wrapping/formatting issues. Thus, we omit `format: 'json'` for these endpoints and rely on simple fallback logic.

### 3. Streak Calculation Logic
Streaks are calculated by fetching yesterday's `night_summary` record.
- If it exists and streak > 0, today's streak = yesterday's streak + 1.
- If it doesn't exist, today's streak = 1.
We intentionally use local-timezone date helpers (`getYesterdayDate()`) to ensure reliable day boundary calculations.

### 4. Carry-Forward Decision Rule
Not all missed tasks are carried forward. We enforce a priority-based rule:
- **High/Medium** priority missed tasks are automatically carried forward.
- **Low** priority tasks are dropped.
This prevents the user's schedule from blooming indefinitely with neglected low-priority tasks.

### 5. Idempotent Data Persistence (Duplicate Guard)
Carrying forward tasks requires inserting new rows into the `tasks` table for tomorrow. To prevent duplicate rows if `/api/summary/generate` is called multiple times, we query `tasks` to ensure a carry-forward row for that name and date doesn't already exist.
The `night_summary` table itself uses an `UPDATE` vs `INSERT` UPSERT pattern based on date.

---

## Files Created/Modified in Phase 5

| File | Change |
|------|--------|
| `backend/services/aiService.js` | Added `chatWithSeva()` implementation |
| `backend/services/summaryService.js` | Created engine for `generateNightSummary()` and `generateSevaMessage()` |
| `backend/routes/chat.js` | Added POST `/message` and GET `/history` endpoints |
| `backend/routes/summary.js` | Added GET `/generate` and GET `/history` endpoints |
| `backend/utils/dateUtils.js` | Added `getYesterdayDate()` and `getTomorrowDate()` |
| `backend/server.js` | Mounted `/api/chat` and `/api/summary` routes |

---

## API Endpoints Added

| Method | URL | What it does |
|--------|-----|-------------|
| POST | `/api/chat/message` | Inserts message to DB, gets SEVA's context-aware reply |
| GET  | `/api/chat/history` | Gets chat history for a specific date (defaults to today) |
| GET  | `/api/summary/generate` | Generates night summary, carries forward tasks, computes streak |
| GET  | `/api/summary/history` | Fetches parsed JSON arrays of past night summaries |

---

## Known Limitations

### 1. Read-Only Conversational Chat (No Action Triggering)
Chat is currently read-only. While the user can say "replan my day", SEVA will only respond conversationally. It will not automatically trigger `replan()` or modify the `day_plans` table. Full intent-detection-and-action pipelines are slated for future phases.

### 2. Time Slot Inconsistency in Replanning
When `replan()` executes, it generates a new dynamic schedule saved in `day_plans.plan_json` (e.g., a task moves to 3:30 PM). However, it does not update the original `time_slot` column in the `tasks` table (which might remain at 9:00 AM). Therefore, Chat (which reads `day_plans`) and Night Summary (which reads `tasks`) may reflect different scheduled times. Because relying on AI string-matching to update original DB task IDs is brittle, `tasks.time_slot` acts as the "original intended time," while `day_plans` acts as the "dynamic execution time."

### 3. Date-Filtered Chat Search
Chat history search is currently implemented using date-filtering (`?date=YYYY-MM-DD`). Full-text search across all historical messages is not supported in the backend yet.

---

## Important Interview Questions & Answers

**Q1: How did you manage context window limits in your conversational agent?**
**A1:** Passing entire permanent chat histories to the LLM would rapidly hit token limits and degrade response quality. I implemented a targeted sliding window approach: `chatWithSeva()` only queries the last 10 messages specifically for `today` (using a local-timezone-safe date helper) and injects the current day plan and pending tasks. This keeps the prompt focused, highly relevant, and well under the token limit.

**Q2: How did you ensure data integrity when generating the night summary multiple times?**
**A2:** I used idempotency guards. For the summary record itself, I used an UPSERT pattern: it checks if a record for `today` exists and `UPDATE`s it, otherwise `INSERT`s. For task carry-forward, before inserting a new task row for `tomorrow`, the SQLite transaction strictly checks if a task with the same name, date, and `source = 'carry_forward'` already exists. This guarantees that calling the endpoint twice won't duplicate data.

**Q3: Why doesn't your chatbot automatically execute actions like replanning when a user asks?**
**A3:** Building reliable intent detection mapping natural language to system actions (Function Calling) is complex and brittle with small local models like phi3.5. To maintain system stability, I constrained the chat to be read-only conversational context analysis. Modifying database state (like `replan()`) is kept strictly to deterministic API triggers, though adding a function-calling layer is a planned future enhancement.

**Q4: During the night summary, why don't you just update the date on missed tasks instead of creating new rows?**
**A4:** Updating the date on existing tasks would corrupt the historical record. If I missed a task today, the system needs to preserve the fact that on *this specific date*, it was incomplete (`completed = 0`). By inserting a brand-new row for tomorrow marked with `carry_forward = 1`, the dashboard can accurately display historical analytics while smoothly pushing the workload forward.

**Q5: What happens if the local LLM crashes or returns garbage text during night summary generation?**
**A5:** I architected the AI layer with strict fault tolerance. The `generateSevaMessage()` function catches any network or parsing errors from the local Ollama instance and returns a safe, templated fallback string (e.g., `"You completed X of Y tasks today..."`). The summary generation pipeline and database persistence will never fail just because the AI failed.
