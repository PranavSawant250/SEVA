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
