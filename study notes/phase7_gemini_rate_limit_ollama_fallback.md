# Phase 7 — Gemini Rate Limits & Immediate Local Fallback Architecture

## 1. Executive Summary & Root Cause Diagnosis

SEVA Chat was encountering repeated user-facing errors:
> *"Action processing is temporarily unavailable because the AI service is rate-limited. Your request was not saved. Please wait a moment and tap to retry."*

### Captured Diagnostic Evidence:
Direct REST inspection using `@google/genai` and isolated diagnostics captured the exact Google Cloud API error response:

```json
{
  "name": "ApiError",
  "status": 429,
  "statusText": "RESOURCE_EXHAUSTED",
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details...",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "description": "Generate content requests per day limit exceeded on Free Tier.",
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "quotaDimensions": { "location": "global", "model": "gemini-3.5-flash-lite" },
            "quotaValue": "500"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "5106s"
      }
    ]
  }
}
```

### Exact Cause Breakdown:
1. **Quota Type:** **Requests Per Day (RPD)** exhausted (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit: 500 requests/day). This was **not** a transient per-minute rate limit (RPM).
2. **Retry Delay (`retryDelay`):** `5106s` (~85 minutes / 1h 25m).
3. **The 18–19s Freeze:** In `backend/services/chatAgent.js`, `callGeminiWithBackoff()` executed 3 retries (attempts 1, 2, 3) backing off for 2000ms + jitter, 4000ms + jitter, and 8000ms + jitter (~18.5s total wait). Attempt 2 switched to `gemini-3.8-flash`, which failed immediately because both models belong to the same project and share the project-level daily quota.
4. **Action Hard-Block:** In `chatAgent.js`, when a 429 error was caught, `if (isRateLimit && hasActionIntent(userMessage))` immediately aborted execution and returned the hard failure message instead of falling back to the local deterministic or Ollama engine.

---

## 2. Implemented Architecture & Solutions

### A. Intelligent In-Memory Circuit Breaker
- **Zero Futile Retries on Daily Quota:** `parseGeminiError()` inspects `violations`, `quotaId`, and `retryDelay`. If daily quota exhaustion (`GenerateRequestsPerDay`) or `retryDelay > 60s` is detected, `tripGeminiCircuitBreaker()` records `geminiCircuitBreakerUntil = Date.now() + cooldownMs`.
- **Immediate Failover (<1ms):** Subsequent requests bypass Gemini immediately without outbound network calls, routing directly to the local pipeline.
- **Short Throttle Handling:** Transient 429 errors with short `retryDelay` (<= 5s) perform at most 1 short wait, capping max wait time to ~4s instead of 18–19s.
- **No Cross-Model Retries:** Avoids futile retries on fallback models when project-level quota is exhausted.

### B. Seamless Fallback Pipeline
- Removed the hard-block on actionable messages.
- When Gemini is unavailable:
  1. **Deterministic Action Engine:** Handles goal progress logging, task addition, step completion, rescheduling, availability updates, and replanning.
  2. **Deterministic Command Router:** Handles structured quick commands, check-ins, and removals with confirmation safeguards.
  3. **Local Ollama (`phi3.5`):** Handles general questions, schedule inquiries, and conversational status queries with full database grounding.
- **Strict Guardrails:** Local fallback never executes raw SQL, never hallucinates nonexistent data, and maintains session-scoped idempotency.

### C. Chat UI & UX Improvements (`seva-frontend/src/screens/Chat.jsx`)
- **Immediate Loading State:** `isSending` disables input and submit button instantly; shows animated "SEVA is thinking..." bubble.
- **Provider Badges:** Displays provider badge on assistant responses (`Cloud (Gemini)`, `Local (Ollama)`, `Local (Deterministic)`).
- **Actionable Retry:** Failed requests show a clear "Failed — Tap to retry" button that preserves the deterministic `client_request_id`.

---

## 3. Test Suite Verification (10 Scenarios)

All 10 scenarios passed in an isolated temporary SQLite database (`backend/scripts/test-rate-limit-suite.js`):

| # | Test Scenario | Expected Behavior | Actual Result | Status |
|---|---------------|-------------------|---------------|--------|
| 1 | Gemini Normal Operation | Mock Gemini cloud response | Received cloud text in 1ms | ✅ PASSED |
| 2 | Gemini 429 Short Throttle | Single retry, bounded latency | Exactly 2 attempts, bounded wait, aborted safely | ✅ PASSED |
| 3 | Gemini 429 Explicit Retry-After | Respect explicit delay | Respected 1s delay, then controlled failover | ✅ PASSED |
| 4 | Gemini Daily Quota Exhausted | Immediate Circuit Breaker, 0 retries | Tripped circuit breaker on attempt 1, 0 extra retries | ✅ PASSED |
| 5 | Ollama Fallback Simple Question | Conversational response | Returned `Local (Ollama)` response | ✅ PASSED |
| 6 | Ollama Fallback Read-Only Status | Informational answer, 0 mutations | Read-only reply, 0 database mutations | ✅ PASSED |
| 7 | Fallback Supported Mutation | Progress logged via action engine | Active LeetCode count 3 → 6, exact confirmation | ✅ PASSED |
| 8 | Ambiguous Mutation Request | Clarification asked, 0 mutations | Asked "Do you mean 4 PM today?", 0 mutations | ✅ PASSED |
| 9 | Duplicate Submissions Fallback | Idempotency preserved | 2nd submission returned cached response, 0 dup rows | ✅ PASSED |
| 10 | Recovery After Rate Limit | Circuit breaker reset, cloud resumes | Cloud operations resumed upon recovery | ✅ PASSED |

**Final Verification Result:** 10/10 Scenarios Passed.
**Live Database Integrity:** SHA-256 table hashes verified 100% identical and unchanged.

