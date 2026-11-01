# Phase 10 — Intelligent Natural Language Tool-Calling Chat & Agentic Execution

**Status:** Complete — Test Suite A (18/18), Test Suite B (62/62), and Concurrency Fencing Audits Fully Verified.

---

## 1. Architectural Overview & Context

### Why We Replaced Regex Command Interpretation
Prior to Phase 10, SEVA's chat relied on rigid deterministic regexes (`services/chatCommands.js`) alongside a conversational Ollama model (`phi3.5`). This architecture suffered from fundamental limitations:
- **Brittleness:** Free-form, natural phrasing (e.g. *"Tomorrow I have to do OS lab, high priority"*, *"Finished 2 LeetCode problems just now"*) failed regex matching and went unhandled.
- **Split Brain:** The assistant often gave pleasant conversational replies promising an action was done, while the underlying execution layer never actually created the task or logged progress.
- **Ambiguity & Hallucination:** Models could hallucinate action outcomes or attempt to invent database IDs.

### The Agentic Solution: Tool Calling with Deterministic Execution
Phase 10 introduces a strict separation between **Interpretation** and **Execution**:
1. **Interpretation Layer (Gemini `gemini-3.5-flash-lite`):**
   - Receives: user message, last ~10 turns, injected `today` date, time, and compact tool execution results.
   - Does: natural language understanding, entity extraction, temporal resolution, and tool selection.
   - **Never:** sees SQL queries, raw table structures, or direct database connections.
2. **Execution Layer (Deterministic Services in Node.js / SQLite):**
   - Every write or read passes through validated functions in `services/chatTools.js`.
   - Validates ranges, checks deadlines, resolves dates, and enforces transactional integrity.
   - Replies to the user are composed **strictly from verified tool results**.

```
┌────────────────────────────────────────────────────────┐
│                   SEVA Chat System                     │
│                                                        │
│  User Message: "Finished 2 LeetCode problems today"    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Interpretation Layer                     │
│               (Gemini Function Calling)                │
│                                                        │
│  Selects Tool: log_goal_progress                       │
│  Args: { goal_identifier: "LeetCode", amount: 2 }      │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Deterministic Execution Layer            │
│                 (services/chatTools.js)                │
│                                                        │
│  1. Match active goal by case-insensitive title        │
│  2. Insert audit row in goal_progress_log              │
│  3. Calculate net progress & update current_count      │
│  4. Return: { success: true, new_progress: 24 }        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Final Verifiable Response                │
│  "Logged 2 for LeetCode. Current progress: 24/50."     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Deterministic Tool Registry (`services/chatTools.js`)

All tools define a strict JSON Schema adhering to the Google GenAI Function Declaration specifications:

| Tool Name | Mutating? | Description & Key Parameters |
|---|---|---|
| `get_today_plan` | No | Retrieves scheduled Day Plan items for today or tomorrow. |
| `get_tasks` | No | Lists tasks filtered by date (`today`, `tomorrow`, `all`) and status (`active`, `completed`). |
| `get_goals` | No | Lists active goals, progress percentages, expected progress, and days remaining. |
| `add_task` | Yes | Schedules a task with priority (`high`, `medium`, `low`), duration (15–480 min), optional fixed start time, and optional goal link. |
| `update_task` | Yes | Modifies time, priority, duration, or date of an existing task. |
| `complete_task` | Yes | Marks a task completed and updates day plan checkmarks. |
| `uncomplete_task` | Yes | Reverts a completed task back to active. |
| `log_goal_progress` | Yes | Logs positive progress amount towards a count or frequency goal. |
| `correct_goal_progress` | Yes | Corrects a recent log error by finding the prior entry within 24 hours and writing an internal compensating row. |
| `request_removal` | Yes | Initiates a pending removal state. Does **not** delete immediately. |
| `replan_day` | Yes | Triggers the scheduler to rebuild flexible slots around fixed commitments. |
| `ask_user` | No | Formulates a clarifying question when user request is ambiguous. |

---

## 3. Core Architectural Safety Invariants

### Invariant 1: Removal Safety Gate (Two-Step Confirmation)
- The model's tool list **does not contain** a `confirm_removal` tool.
- When the user asks to delete a goal or task, the model calls `request_removal`, which sets an in-memory/session pending state (`pending_removal`).
- Even if the user says *"Delete DSA practice and confirm"* in one single prompt, SEVA **refuses** to delete immediately. It asks for explicit confirmation.
- The next user message is intercepted by the deterministic router in `services/chatCommands.js`:
  - `"yes"` / `"haan"` $\rightarrow$ executes soft deletion (`status = 'removed'`).
  - `"no"` / `"cancel"` / unrelated command $\rightarrow$ clears pending state without deletion.

### Invariant 2: Compensating Rows & Immutable Goal Audit Trail
- SEVA never edits or deletes existing rows in `goal_progress_log`.
- When a user corrects progress (*"Actually only one problem, not two"*):
  1. The system ignores any model-provided `previous_amount`.
  2. It deterministically queries the most recent uncorrected positive entry for that goal in the last 24 hours ($A_{\text{prior}}$).
  3. Delta is computed: $\Delta = A_{\text{correct}} - A_{\text{prior}}$.
  4. A compensating row with $\Delta$ is inserted referencing `chat_message_id`.
  5. Negative amounts are strictly restricted to internal compensating rows; user-supplied inputs must remain positive-only.
- **Negative-Row Activity Audit:** All downstream queries (`days_since_activity`, frequency days this week, floor sessions, Night Summary) calculate **net progress per day**:
  $$\text{Net Day Amount} = \sum \text{amount}$$
  A day with $\text{Net Day Amount} \le 0$ does **not** count towards activity streaks or frequency days.

### Invariant 3: Quoted Speech & Attribution Engine
To prevent false task creation when the user quotes third parties:
- Direct commands (*"Add task: Finish two steps tonight"*) $\rightarrow$ Creates task.
- Reported/Quoted speech (*"Professor said: 'Finish two steps of the assignment tonight'"*, *"My friend told me to read chapter 4"*) $\rightarrow$ The LLM recognizes reported speech and provides a conversational summary without triggering `add_task`.

---

## 4. Session-Scoped Idempotency, Fencing & Crash Consistency

To handle double-clicks, network retries, and worker crashes without corrupting state or executing duplicate actions:

### A. The Corrected Composite Schema
```sql
-- Request Envelope Table
CREATE TABLE IF NOT EXISTS idempotency_requests (
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  response_json TEXT NULL,
  lease_owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, client_request_id)
);

-- Granular Action Execution Table
CREATE TABLE IF NOT EXISTS idempotency_actions (
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  action_index INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  result_json TEXT NULL,
  lease_token INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, client_request_id, action_index),
  FOREIGN KEY (session_id, client_request_id) 
    REFERENCES idempotency_requests(session_id, client_request_id) 
    ON DELETE CASCADE
);
```

### B. In-Transaction Fencing Before Mutation
To prevent slow/stale workers from overwriting completed work after a lease takeover:
1. `executeActionWithFencing()` opens a synchronous SQLite transaction (`activeDb.transaction(...)`).
2. Inside the transaction, it validates:
   - `req.status === 'pending'`
   - `req.lease_owner === currentWorker`
   - `req.lease_token === currentWorkerToken`
3. If any check fails, the transaction **aborts before calling `mutationFn()`**.
4. Result: Stale workers have a mutation count of strictly **0**. Only the active leaseholder commits.

### C. Completed-Action Protection (Anti-Reset Race Guard)
When recording actions, the conflict resolution clause protects completed rows:
```sql
INSERT INTO idempotency_actions (...) VALUES (...)
ON CONFLICT(session_id, client_request_id, action_index) DO UPDATE SET
  status = 'completed',
  result_json = excluded.result_json,
  lease_token = excluded.lease_token,
  updated_at = CURRENT_TIMESTAMP
WHERE idempotency_actions.status != 'completed';
```
An incoming worker can never reset an already completed action record back to `pending`.

---

## 5. Device Authentication & Security

Client-supplied arbitrary session strings are untrusted. Instead, device authentication is anchored on the backend:

```sql
CREATE TABLE IF NOT EXISTS user_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_prn TEXT NOT NULL,
  device_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  UNIQUE(user_prn, device_key)
);
```

1. **Token Hashing at Rest:**
   Tokens are stored as `SHA-256(raw_token)`. The plain token is returned to the client once upon enrollment.
2. **First-Device Enrollment:**
   Requires a valid `preferences.user_prn` and `ENROLLMENT_SECRET`. Never automatically bootstrapped without verification.
3. **Derived Session Identity:**
   Every API request supplies `Authorization: Bearer <device_token>`. The backend validates the hash, checks `status = 'active'`, and constructs:
   $$\text{session\_id} = \text{user\_prn} : \text{device\_key}$$
   *(e.g., `246100104:laptop_macbook` vs `246100104:phone_pixel`)*
4. **Revocation:**
   Updating `status = 'revoked'` immediately halts access (`HTTP 401 DEVICE_REVOKED`).

---

## 6. Model Verification & Resilient Cascading Fallback

### Model Pinning:
- **Primary Model:** `gemini-3.5-flash-lite` (Confirmed live, responsive, supports tool calling declarations).
- **Free-Tier Limits:** Documented from Google AI Studio project:
  - `gemini-3.5-flash-lite`: 15 RPM / 1,500 RPD / 1M TPM.
  - `gemini-3.8-flash`: 20 RPD cap on current Free Tier project.

### Resilient Cascading Fallback Flow:
```
Gemini Call (gemini-3.5-flash-lite)
       │
       ├─► HTTP 429 / 503 Rate Limit?
       │        │
       │        ▼
       │   Exponential Backoff + Jitter
       │        │
       │        ▼
       │   Fallback Model (gemini-3.8-flash)
       │        │
       │        ▼ Rate limit persists?
       │
       ▼
Local Offline Fallback (Deterministic Action Engine + Ollama)
       │
       ▼
100% System Availability (Zero Crashes)
```

---

## 7. Verification Evidence & Test Summary

| Test Suite | Scope | Result | Key Proof |
|---|---|---|---|
| **Test Suite A** | 18 Deterministic & Policy Tests | **18/18 PASS** | Removal gate, date resolution, goal types, ranges |
| **Test Suite B** | 62 Live Gemini Tool Calling Tests | **62/62 PASS** | Natural language, multi-turn, quoted speech (B.32) |
| **Idempotency Suite** | 8 Advanced Idempotency Tests | **8/8 PASS** | Resends, crash resumption, reboot persistence |
| **Fencing & Auth Audit** | 10 Security & Concurrency Tests | **10/10 PASS** | Interleaved race, stale-worker fencing, token hashing |

---

## 8. Summary of Key Files

- `backend/services/chatTools.js` — Registry of 12 deterministic tools, schemas, and handlers.
- `backend/services/chatAgent.js` — Core LLM loop, fallback handler, prompt injection, idempotency caches.
- `backend/routes/chat.js` — Express endpoint with device authentication, history assembly, and routing.
- `backend/scripts/test-idempotency-fencing-audit.js` — Interleaved concurrency, fencing token, and device security tests.
- `backend/study-notes/phase10-intelligent-chat-tool-calling.md` — This comprehensive reference documentation.
