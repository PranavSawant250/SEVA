# SEVA Project — Known Limitations & Design Trade-offs

This document tracks known limitations, architectural trade-offs, and deliberate design decisions made across the SEVA implementation.

---

## 1. Auth Status & Returning User Detection Proxy

### Observation
- The SEVA backend currently does not provide an explicit `/api/auth/status` endpoint to check token validity or current session health.
- `GET /api/timetable` count (`count > 0`) is used as a lightweight proxy on the frontend to distinguish returning users from first-time setup users.

### Reality & Impact
- If a user's Google OAuth refresh token (`credentials/token.json`) naturally expires or is revoked by Google while their timetable entries still exist in SQLite:
  - The frontend will present the **Returning User View** ("Welcome Back") because `timetable.count > 0`.
  - When the user clicks **"Continue with Google"** / **"Re-authenticate Google"**, it triggers the standard Google OAuth redirect flow, re-exchanging authorization code for fresh tokens.
  - The backend callback saves the new token to `credentials/token.json` and redirects seamlessly back to `/dashboard`.

### Conclusion
- Functionally, both "active session" and "expired token needing re-auth" resolve cleanly through the exact same user button press.
- Creating a separate session engine was intentionally omitted to maintain a lightweight, local-first mini project footprint.

---

## 2. Replan Engine vs. Task Column Sync (`day_plans.plan_json` vs `tasks.time_slot`)

### Observation
- When `replan()` is triggered (e.g., via surprise chat event), it recalculates and updates `day_plans.plan_json`.
- It does not mutate `tasks.time_slot` directly in the `tasks` table.

### Impact
- Chat and Day Plan views display the updated schedule from `day_plans.plan_json`.
- The Night Summary reads directly from `tasks` table columns.

---

## 3. Phase 9 — Goals, Deterministic Scheduler & Nightly Check-In Trade-offs

1. **In-memory check-in & removal sessions reset on server restart**: Active two-step removal (`pendingRemoval`) and Nightly Check-In (`activeSession`) state is held in Node.js memory with a 10-minute TTL (`SESSION_TTL_MS`), not persisted in SQLite. Restarting the backend mid-flow resets the pending state cleanly.
2. **Command grammar is keyword/regex based (not free-form NLU)**: All chat commands (`add/remove/done/move`, `"I have N hours"`, `"plan tomorrow"`, and check-in replies) are parsed via a deterministic regex/keyword grammar (`GRAMMAR` table) with English + Hinglish synonyms so the LLM never decides state mutations. Unrecognized phrasings return a clear retry hint rather than guessing.
3. **Duration estimation uses heuristic defaults unless user specifies `duration_min`**: Unless overridden per goal (`daily_min_minutes` / `daily_max_minutes`) or per task (`duration_min`), the scheduler uses configurable policy defaults (`45m` high-priority goal, `60m` urgent task, `30m` neglect floor / habit / flexible task).
4. **Milestone goals without `goal_steps` require manual progress or `Mark complete`**: Finishing a daily work session on a step-less milestone goal logs a `worked` entry in `goal_progress_log` (resetting its neglect counter) without guessing a percentage increase; percentage updates come from ticking steps, setting `manual_progress`, or clicking `Mark complete`.
5. **Reminders are in-app only**: Goal reminders (`GET /api/goals/reminders`) render inside the Dashboard banner when the app is open; there are no OS push notifications or background email/SMS alerts.
6. **`phi3.5` writes only `plan_note` and Night Summary prose (with template fallback)**: All scheduling, time allocation, step tracking, and check-in logic is 100% deterministic in code. If Ollama times out or returns invalid text, SEVA falls back immediately to a deterministic template note.

