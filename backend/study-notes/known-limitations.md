# SEVA — Known System Limitations & Panel Q&A Guide

This document consolidates every architectural boundary, trade-off, and known limitation in SEVA across all 8 development phases. Use this as a cheat sheet for panel/guide questions during presentation.

---

## 1. Chat & Conversational Context Boundaries
* **Limitation**: Chat context is scoped to the **current day** (`chat_history` table queried for `date = today`).
* **Rationale**: Feeding historical multi-day chat logs into Ollama prompt contexts exceeds token limits and increases inference latency on local hardware. Current day context (today's tasks, timetable, today's plan, today's chat history) provides maximum relevance while keeping local LLM (`phi3.5`) response time under 10–15 seconds.

---

## 2. Night Summary & Task Carry-Forward Rules
* **Limitation**: Only `high` and `medium` priority missed tasks are automatically carried forward to tomorrow (`date = tomorrow`, `source = 'carry_forward'`). `low` priority missed tasks are not auto-forwarded.
* **Rationale**: Automatically carrying forward low-priority tasks causes "task list bloat" over time, overwhelming the user and causing AI plan generation degradation. Low-priority tasks remain in SQLite for manual review.

---

## 3. Completion Date Stamping on Carry-Forward Tasks
* **Limitation**: When a user completes a carry-forward task (originally created on an earlier date, e.g. `2026-09-30`) on today's Day Plan (`2026-10-02`), `PATCH /api/tasks/:id/complete` updates its `date` field to today's date (`2026-10-02`).
* **Rationale**: `generateNightSummary()` calculates productivity by querying `WHERE date = today AND completed = 1`. If the date remained `2026-09-30`, completing the task today would not contribute to today's completed count or streak calculation. Stamping the completion date aligns UI state with daily summary analytics.

---

## 4. Frontend Task Matching (Fuzzy Substring Match)
* **Limitation**: `DayPlan.jsx` matches hour-by-hour AI plan item names against the SQLite `tasks` table using case-insensitive substring matching (`findMatchingTask`).
* **Rationale**: The LLM may slightly alter task phrasing (e.g., returning `"Review DB notes"` for task `"Review Database lecture notes"`). Date-scoping the candidate tasks to today (`date = todayDate`) combined with name substring matching provides seamless matching without requiring hardcoded ID passing in prompt outputs.

---

## 5. Gmail Synchronization Architecture (Polling vs. Webhooks)
* **Limitation**: Gmail sync relies on scheduled background polling (every 30 minutes via `cron`/`setInterval`) or manual trigger in the Email Insights UI, rather than real-time Google Cloud Pub/Sub webhooks.
* **Rationale**: Webhooks require a publicly accessible HTTPS endpoint (e.g. ngrok/Cloudflare Tunnel) and Google Cloud GCP project setup. Polling keeps SEVA 100% self-contained locally with zero external network dependency beyond standard Gmail REST API.

---

## 6. LLM Structured Output Parsing & Deterministic Fallback
* **Limitation**: Local small language models (`phi3.5`) occasionally fail JSON format compliance, returning markdown wrappers or extra commentary.
* **Rationale**: SEVA implements a 3-tier defense:
  1. Strict Bracket Extraction (`extractArrayJsonString` / `extractObjectJsonString`)
  2. Per-item Schema Validation & Deduplication (`seenTaskNames` `Set`)
  3. Deterministic Fallback (`buildFallbackPlan`) that orders tasks by time slot without crashing if AI output is unparseable.

---

## 7. Database Scope & Single-User Architecture
* **Limitation**: `seva.db` (SQLite) is single-tenant without multi-user auth tables.
* **Rationale**: SEVA is engineered as a privacy-first, local-first personal assistant. SQLite with WAL mode (`journal_mode = WAL`) provides maximum speed, simplicity, zero-config setup, and complete data privacy on the user's personal machine.

---

## 8. Phase 9 — Goals, Deterministic Scheduler & Nightly Check-In Trade-offs
* **In-memory check-in & removal sessions**: Active two-step removal (`pendingRemoval`) and Nightly Check-In (`activeSession`) state is stored in server memory with a 10-minute TTL and resets on backend restart.
* **Keyword/regex command grammar**: Chat commands and check-in replies use a central deterministic `GRAMMAR` regex table (English + Hinglish) rather than free-form LLM NLU so `phi3.5` never controls state or times.
* **Heuristic duration defaults**: Unless `duration_min` or goal min/max minutes are specified, the scheduler uses policy defaults (`45m` high-priority goal, `60m` urgent task, `30m` neglect floor / habit / flexible task).
* **Step-less milestone goals**: Completing a daily session logs `'worked'` in `goal_progress_log` (clearing neglect), while progress percentage updates via step checkboxes, `manual_progress`, or `Mark complete`.
* **In-app-only reminders**: Goal reminders (`GET /api/goals/reminders`) are surfaced in the Dashboard banner when the app is open (no OS push notifications).
* **AI prose role with template fallback**: `phi3.5` only authors the 1–2 sentence `plan_note` and Night Summary message, with an instant deterministic fallback if Ollama fails.
