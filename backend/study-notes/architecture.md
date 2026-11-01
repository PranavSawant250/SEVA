# SEVA — Personal Life Orchestrator: Master Architecture & Technical Specification

> **Project Name**: SEVA — Personal Life Orchestrator  
> **Project Type**: Mini Project II (TY-IT) — Walchand College of Engineering, Sangli  
> **Current Project Status**: Phase 1 (Complete) | Phase 2 (Complete) | Phase 3 (Complete) | Phase 4 (Complete) | Phase 5 (Complete) | Phase 6 (Complete — Timetable prereq) | Phase 7 (Complete — Frontend UI) | Phase 9 (Complete — Goals & Scheduler) | Phase 10 (Complete — Intelligent Assistant & Personalization)  
> **Single Source of Truth**: This document contains the complete technical specification, folder structure, database schema, system architecture, API routes, build progress, and setup instructions for the SEVA project.

---

## 1. Project Overview

### What is SEVA?
SEVA (Personal Life Orchestrator) is an intelligent, privacy-first, local-only personal assistant designed to automatically aggregate emails, class timetables, and personal tasks into an optimized, dynamic, hour-by-hour daily schedule. It runs completely on the user's local machine, leveraging a locally hosted Large Language Model (Microsoft Phi-3.5 via Ollama) and an embedded SQLite database (`seva.db`) to ensure 100% of user data remains private and never leaves the machine.

### The Problem It Solves
Students and professionals juggle multiple disconnected platforms every single day — Gmail for announcements, college timetables for fixed classes, and separate task apps for assignments. Manually coordinating these sources causes missed deadlines, cognitive overload, and scheduling conflicts. Furthermore, existing commercial assistants send sensitive email data to external cloud servers. SEVA solves this by unifying all scheduling sources into a single intelligent local brain while preserving absolute data privacy.

### Core Philosophy: Privacy-First, Local-First
* **Zero Cloud Dependency**: No external AI servers, no cloud database clusters, and no remote data storage.
* **Local Inference**: All email understanding and day plan generation are powered by a local AI model (`phi3.5`).
* **Complete Data Ownership**: All state is stored in a single local file (`backend/seva.db`). Deleting the file deletes all application state cleanly.

### Who It Is For
Students, academic researchers, and privacy-conscious professionals who want automated daily planning, deadline tracking, and conversational replanning without exposing their personal communications to cloud services.

### What Makes SEVA Different
Unlike generic calendar apps or cloud AI services (like ChatGPT or Google Assistant), SEVA combines automatic email ingestion, local AI classification, fixed schedule mapping, dynamic real-time replanning, and end-of-day performance analytics into an offline-first desktop web application.

---

## 2. Complete Tech Stack

| Layer | Technology | Purpose & Selection Rationale |
| :--- | :--- | :--- |
| **Backend Runtime** | Node.js (v18+) | Fast, asynchronous JavaScript runtime environment for server operations. |
| **Web Server** | Express.js | Lightweight, unopinionated framework to structure RESTful API endpoints and middleware. |
| **Database** | SQLite (`better-sqlite3`) | Embedded, zero-config relational database stored as a single local file (`seva.db`) for high-speed synchronous local access. |
| **Local AI Engine** | Ollama (`phi3.5`) | Local LLM runner executing Microsoft Phi-3.5 (3.8B) for 100% private email understanding and day plan generation. |
| **Integration** | Google Gmail API | Official REST client for fetching user emails using read-only OAuth 2.0 authorization. |
| **Authentication** | Google OAuth 2.0 | Secure token-based OAuth authorization framework (`gmail.readonly` scope only). |
| **Scheduler** | `node-cron` | Lightweight background job scheduler executing automated 30-minute email sync & AI processing tasks. |
| **Frontend** | React.js + Tailwind CSS *(Phase 4/5)* | Responsive, modern Single Page Application (SPA) dashboard UI running on `localhost:3000`. |

---

## 3. Complete Folder Structure

```text
SEVA/
├── backend/
│   ├── server.js                   # Express server entry point, middleware & 30-min cron scheduler
│   ├── package.json                # Project manifest, dependencies, and npm scripts
│   ├── .env                        # Environment variables (PORT, Google OAuth Client credentials)
│   ├── .gitignore                  # Git ignore rules for node_modules, .env, seva.db, and credentials
│   ├── seva.db                     # Local SQLite database file storing all 13 tables (gitignored)
│   ├── database/
│   │   └── db.js                   # SQLite database initialization, table creation & column migrations
│   ├── routes/
│   │   ├── gmail.js                # Auth routes (/api/auth) + email CRUD, feedback & review endpoints
│   │   ├── plan.js                 # Day plan routes: generate, today, replan (/api/plan)
│   │   ├── tasks.js                # Task CRUD with bidirectional toggle (/api/tasks)
│   │   ├── chat.js                 # Conversational AI chat with natural action execution (/api/chat)
│   │   ├── goals.js                # Monthly goals CRUD, import, progress logging & reminders (/api/goals)
│   │   ├── timetable.js            # College class timetable CRUD (/api/timetable)
│   │   ├── settings.js             # Daily window settings and user preferences (/api/settings)
│   │   ├── nightly.js              # Nightly check-in planning tomorrow (/api/nightly)
│   │   └── summary.js              # Night summary analytics (/api/summary)
│   ├── services/
│   │   ├── gmailService.js         # OAuth2 client setup, token storage, and Gmail API fetching logic
│   │   ├── aiService.js            # Ollama (Phi-3.5) integration, JSON mode, validation & DB analysis
│   │   ├── actionEngine.js         # Deterministic NLP action parser & atomic state updates (Phase 10 ✅)
│   │   ├── emailClassifier.js      # Student identity matching, PRN/attendance parsing & ranking (Phase 10 ✅)
│   │   ├── chatCommands.js         # Router intercepting natural actions before AI fallback
│   │   ├── goalsService.js         # Goal metrics, progress computations & audit logs
│   │   ├── schedulerService.js     # Pure deterministic 5-layer scheduler with neglect floor
│   │   ├── plannerService.js       # generateDayPlan() + replan() with array extraction & validation
│   │   ├── nightlyService.js       # Check-in outline and rescue session orchestrator
│   │   └── summaryService.js       # Night summary generation service
│   ├── credentials/
│   │   ├── client_secret.json      # Downloaded Google OAuth 2.0 web client JSON (gitignored)
│   │   ├── token.json              # Saved OAuth refresh and access tokens (gitignored)
│   │   └── .gitkeep                # Keeps directory structure in git repo
│   ├── scripts/
│   │   ├── test-ollama.js          # Standalone test script for basic Ollama connectivity
│   │   ├── test-analyze.js         # Standalone 5-sample email test script for AI model comparison
│   │   ├── inspect-classroom-raw.js# Debug script inspecting raw MIME email payloads from Gmail API
│   │   ├── test-clean-extraction.js# Test script verifying URL/boilerplate stripping on email body
│   │   ├── test-planner.js         # Standalone 3-scenario planner test script
│   │   ├── test-scheduler.js       # Scheduler unit & edge-case test suite
│   │   ├── test-step5.js           # Plan generation & goal persistence test suite
│   │   ├── test-step7.js           # Nightly check-in test suite
│   │   ├── test-step10.js          # Cross-phase regression test suite
│   │   └── test-intelligent-assistant.js # Complete Phase 10 test suite (34/34 passing) (Phase 10 ✅)
│   └── study-notes/
│       ├── architecture.md         # Master Architecture & Technical Specification (This File)
│       ├── phase1-foundation.md    # Phase 1 Study Notes & Technical Q&A
│       ├── phase2-gmail.md         # Phase 2 Study Notes & Technical Q&A
│       ├── phase3-ai.md            # Phase 3 Study Notes & Technical Q&A
│       ├── phase4-planning.md      # Phase 4 Study Notes: planning engine, array extraction, fallback logic
│       ├── phase5-chat-summary.md  # Phase 5 Study Notes: chat and summary endpoints
│       ├── phase7-frontend-report.md # Phase 7 Frontend Report: screen inventory & verification
│       ├── phase9-goals-scheduler.md # Phase 9 Study Notes: monthly goals, deterministic scheduler & nightly check-in
│       ├── intelligent-assistant-and-personalization.md # Phase 10 Comprehensive Study Notes (Phase 10 ✅)
│       └── ai-provider-hybrid-strategy.md # Dual AI Provider Strategy (Local Ollama vs Claude API)
├── seva-frontend/                  # React SPA frontend (Phase 7 & Phase 10 ✅)
│   ├── src/
│   │   ├── api/
│   │   │   └── client.js           # Axios instance (baseURL: localhost:3001/api)
│   │   ├── components/
│   │   │   └── AddTaskModal.jsx    # Shared task creation modal (used by Dashboard + DayPlan)
│   │   ├── layouts/
│   │   │   └── Shell.jsx           # Sidebar nav (Moon/Email/Calendar/Chat/Summary icons) + Outlet
│   │   ├── screens/
│   │   │   ├── Login.jsx           # OAuth flow + first-time timetable wizard (sessionStorage guard)
│   │   │   ├── Dashboard.jsx       # Stats, Top 3 Priorities, Generate Plan, Add Task
│   │   │   ├── EmailInsights.jsx   # Context-aware controls (Reviewed/Dismiss Alert/Feedback), filter bar
│   │   │   ├── DayPlan.jsx         # Timeline, completion checkboxes, replan form
│   │   │   ├── Goals.jsx           # Monthly goals manager (count, habit, milestone step progress)
│   │   │   ├── Chat.jsx            # Conversational AI (action-oriented natural execution)
│   │   │   └── NightSummary.jsx    # SEVA message centerpiece, streak, task lists, date picker
│   │   ├── utils/
│   │   │   └── themeUtils.js       # getPriorityBadgeClass, getEventTypeBadgeClass helpers
│   │   ├── App.jsx                 # Router config: /login, /dashboard, /emails, /dayplan, /goals, /chat, /nightsummary
│   │   └── index.css               # Tailwind base + custom utilities (font-heading, etc.)
│   ├── tailwind.config.js          # Custom tokens: navy/black/cyan palette, Space Grotesk + Inter fonts
│   └── package.json
├── .gitignore                      # Root git ignore file
└── README.md                       # High-level project README
```

---

## 4. System Architecture & Data Flow

SEVA operates on a **three-layer local architecture**. All computation, inference, and persistence happen on `localhost`.

### ASCII System Architecture Diagram

```text
  +-------------------------------------------------------------------------+
  |                             USER MACHINE                                |
  |                                                                         |
  |  +--------------------+         +------------------------------------+  |
  |  |   React Frontend   | <-----> |     Node.js + Express Backend      |  |
  |  |  (localhost:3000)  |  REST   |          (localhost:3001)          |  |
  |  +--------------------+   API   +------------------------------------+  |
  |                                   |                 |                 |  |
  |                                   | SQLite          | HTTP REST       |  |
  |                                   v Driver          v Client          |  |
  |                         +-------------------+  +-------------------+  |  |
  |                         | Local Database    |  | Local AI Engine   |  |  |
  |                         | SQLite (seva.db)  |  | Ollama (Phi-3.5)  |  |  |
  |                         +-------------------+  +-------------------+  |  |
  +-------------------------------------------------------------------------+  |
                                      ^                                        |
                                      | HTTPS (OAuth 2.0 / Read-Only)          |
                                      v                                        |
  +-------------------------------------------------------------------------+  |
  |                       GOOGLE GMAIL API (READ-ONLY)                      |  |
  +-------------------------------------------------------------------------+  
```

### Complete End-to-End Data Flow:
1. **OAuth Authentication**: User initiates login at `/api/auth/gmail`. Google returns an authorization code via `/api/auth/callback`, which is exchanged for an access token and a `refresh_token` stored in `credentials/token.json`.
2. **Automated Ingestion**: `node-cron` (or `/api/emails/fetch`) triggers every 30 minutes. `gmailService.js` queries Gmail API (`newer_than:1d`) for new messages.
3. **Text Cleaning**: Raw HTML/MIME bodies are stripped of redirect URLs, tracking parameters, and navigation boilerplate using regex in `getBodyPreview()`.
4. **SQLite Insertion**: Clean emails are inserted into the `emails` table using `INSERT OR IGNORE` with `gmail_message_id TEXT UNIQUE`. Newly inserted rows start with `event_type = NULL`.
5. **AI Classification**: `processUnanalyzedEmails()` queries all rows with `event_type IS NULL`. Each email preview is passed to local `phi3.5` via Ollama using `format: 'json'`.
6. **Resilience & Validation**: The returned JSON passes through validation guards (braces extraction, placeholder echo check, case normalization, and synonym mapping) before updating `event_type`, `priority`, and `summary` in `seva.db`.
7. **Planning & UI Ingestion**: Phase 4/5 engines read stored email events and tasks from `seva.db` to render the interactive dashboard and conversational chat.

---

## 5. Database Schema (SQLite: `backend/seva.db`)

All state is persisted across 6 relational tables inside `backend/seva.db`.

```text
+-----------------------+       +-----------------------+       +-----------------------+
|        emails         |       |         tasks         |       |       day_plans       |
+-----------------------+       +-----------------------+       +-----------------------+
| id (PK)               |       | id (PK)               |       | id (PK)               |
| gmail_message_id (UQ) |       | name                  |       | date                  |
| subject               |       | priority              |       | plan_json             |
| sender                |       | time_slot             |       | generated_at          |
| body_preview          |       | source                |       | completed_count       |
| event_type            |       | completed             |       | missed_count          |
| priority              |       | date                  |       +-----------------------+
| summary               |       | carry_forward         |
| date                  |       +-----------------------+
| accepted              |
+-----------------------+

+-----------------------+       +-----------------------+       +-----------------------+
|     chat_history      |       |     night_summary     |       |       timetable       |
+-----------------------+       +-----------------------+       +-----------------------+
| id (PK)               |       | id (PK)               |       | id (PK)               |
| date                  |       | date                  |       | day_of_week           |
| role                  |       | completed_tasks       |       | subject               |
| message               |       | missed_tasks          |       | start_time            |
| timestamp             |       | carry_forward         |       | end_time              |
+-----------------------+       | seva_message          |       +-----------------------+
                                | streak                |
                                +-----------------------+
```

### Table 1: `emails`
Stores fetched Gmail messages and AI-generated classification metadata.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Internal database row ID.
* `gmail_message_id`: `TEXT UNIQUE` — Unique Gmail hexadecimal ID (`msg.id`) used for 100% accurate deduplication.
* `subject`: `TEXT` — Email subject line.
* `sender`: `TEXT` — Sender email and display name.
* `body_preview`: `TEXT` — Plain-text snippet (~400 chars) stripped of URLs and HTML chrome.
* `event_type`: `TEXT` — AI category (`meeting`, `deadline`, `opportunity`, `general`).
* `priority`: `TEXT` — AI urgency (`high`, `medium`, `low`).
* `summary`: `TEXT` — AI generated one-line concise summary.
* `date`: `TEXT` — Email date string (`YYYY-MM-DD`).
* `accepted`: `INTEGER DEFAULT 0` — Action state (`0 = pending`, `1 = accepted into day plan`, `2 = dismissed`).

### Table 2: `tasks`
Stores user manually created tasks and tasks accepted from emails.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Unique task ID.
* `name`: `TEXT` — Task description.
* `priority`: `TEXT` — Urgency (`high`, `medium`, `low`).
* `time_slot`: `TEXT` — Scheduled time (e.g. `'9:00 AM'`).
* `source`: `TEXT` — Task origin (`'email'` or `'manual'`).
* `completed`: `INTEGER DEFAULT 0` — Status (`0 = pending`, `1 = done`).
* `date`: `TEXT` — Scheduled date (`YYYY-MM-DD`).
* `carry_forward`: `INTEGER DEFAULT 0` — Flag (`1` if carried over from yesterday).

### Table 3: `day_plans`
Stores AI-generated hour-by-hour schedules.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Unique plan ID.
* `date`: `TEXT` — Target plan date (`YYYY-MM-DD`).
* `plan_json`: `TEXT` — Complete schedule stored as JSON string.
* `generated_at`: `DATETIME` — Timestamp when plan was generated.
* `completed_count`: `INTEGER DEFAULT 0` — Count of tasks completed.
* `missed_count`: `INTEGER DEFAULT 0` — Count of tasks missed.

### Table 4: `chat_history`
Stores permanent conversation history with SEVA.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Unique message ID.
* `date`: `TEXT` — Log date (`YYYY-MM-DD`).
* `role`: `TEXT` — Message author (`'user'` or `'assistant'`).
* `message`: `TEXT` — Message content.
* `timestamp`: `DATETIME DEFAULT CURRENT_TIMESTAMP` — System creation timestamp.

### Table 5: `night_summary`
Stores end-of-day daily review analytics and productivity streak counters.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Unique summary ID.
* `date`: `TEXT` — Review date (`YYYY-MM-DD`).
* `completed_tasks`: `TEXT` — JSON/Text list of completed tasks.
* `missed_tasks`: `TEXT` — JSON/Text list of missed tasks.
* `carry_forward`: `TEXT` — JSON/Text list of tasks moved to tomorrow.
* `seva_message`: `TEXT` — AI encouraging end-of-day summary message.
* `streak`: `INTEGER DEFAULT 0` — Consecutive productivity streak days count.

### Table 6: `timetable`
Stores fixed recurring weekly class/work timetable schedule.
* `id`: `INTEGER PRIMARY KEY AUTOINCREMENT` — Unique timetable entry ID.
* `day_of_week`: `TEXT` — Day name (`'Monday'`, `'Tuesday'`, etc.).
* `subject`: `TEXT` — Class or subject title.
* `start_time`: `TEXT` — Start time string (`'10:15 AM'`).
* `end_time`: `TEXT` — End time string (`'11:15 AM'`).

---

## 6. API Endpoints Reference

| Method | Endpoint Path | Description | Response Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Base health check & database status | `{ status, message, database, gmailAuthStatus }` |
| `GET` | `/api/auth/gmail` | Initiates Google OAuth 2.0 login flow | Redirects to Google Consent Screen |
| `GET` | `/api/auth/callback` | OAuth callback endpoint handling auth code exchange | Saves `token.json` & redirects |
| `GET` | `/api/emails/fetch` | Triggers Gmail email fetch AND automatic AI analysis | `{ success, insertedCount, analyzedCount, message }` |
| `GET` | `/api/emails/analyze` | Manually triggers AI analysis on all `NULL` rows | `{ success, analyzedCount, message }` |
| `GET` | `/api/emails/today` | Read-only endpoint returning all emails sorted newest first | `{ success, count, emails: [...] }` |
| `POST` | `/api/emails/accept/:id` | Accepts email — sets accepted=1, inserts task row (source='email') | `{ success, message, task: { id, name, priority, ... } }` |
| `POST` | `/api/emails/dismiss/:id` | Dismisses email — sets accepted=2, no task created | `{ success, message }` |
| `GET` | `/api/plan/generate` | AI generates hour-by-hour day plan, saves to day_plans | `{ success, date, count, plan: [...] }` |
| `GET` | `/api/plan/today` | Returns saved plan from day_plans (no AI call) | `{ success, date, generated_at, count, plan: [...] }` |
| `POST` | `/api/plan/replan` | Replans remaining day around surprise event | `{ success, date, surpriseEvent, count, plan: [...] }` |
| `GET` | `/api/tasks` | Gets all tasks where date = today, sorted by priority | `{ success, date, count, tasks: [...] }` |
| `POST` | `/api/tasks` | Adds manual task; normalizes date:'today' to real date | `{ success, message, task: { id, name, priority, ... } }` |
| `PATCH` | `/api/tasks/:id/complete` | Marks task completed (completed=1); returns 404 if not found | `{ success, message, task: { id, name, completed } }` |
| `DELETE` | `/api/tasks/:id` | Permanently deletes task row; returns 404 if not found | `{ success, message, deleted: { id, name } }` |
| `POST` | `/api/chat/message` | Sends user message to SEVA AI *(Phase 5)* | `{ message }` |
| `GET` | `/api/chat/history` | Gets full conversation history *(Phase 5)* | `{ success, history: [...] }` |
| `GET` | `/api/summary/generate` | Generates night summary *(Phase 5)* | `{ message }` |
| `GET` | `/api/summary/history` | Gets past night summaries *(Phase 5)* | `{ success, history: [...] }` |
| `POST` | `/api/timetable` | Replaces weekly timetable (Setup) | `{ success, count }` |
| `GET` | `/api/timetable` | Gets saved weekly timetable | `{ success, count, timetable: [...] }` |

---

## 7. Phase-by-Phase Build Progress

### ✅ Phase 1: Foundation (Complete)
* **Built**: Project folder structure, Express server (`server.js` on port `3001`), SQLite setup (`database/db.js`), `.env` template, `.gitignore`, and all 6 database tables created.
* **Status**: Fully functional and verified.

### ✅ Phase 2: Gmail Connection (Complete)
* **Built**: Google Cloud Console project (`SEVA`), OAuth 2.0 Web Client credentials, `gmailService.js` with offline token persistence (`credentials/token.json`), `routes/gmail.js` (`/api/auth/gmail`, `/api/auth/callback`, `/api/emails/fetch`), URL-stripping body preview extraction, and `node-cron` 30-minute background fetch job.
* **Status**: Fully functional and verified. Real emails fetched into SQLite `emails` table.

### ✅ Phase 3: AI Integration — Email Intelligence (Complete)
* **Built**: Local Ollama integration (`phi3.5`), `aiService.js` with structured JSON decoding (`format: 'json'`), strip-braces recovery (`extractJsonString`), placeholder echo detection (`containsPlaceholderEcho`), case normalization and synonym mapping (`normalizeEventType`), sequential DB update function (`processUnanalyzedEmails`), `/api/emails/analyze` route, and 5-sample benchmark test script (`test-analyze.js`).
* **Status**: Fully functional and verified. 100% precision on email classification (5/5 score).

### ✅ Phase 4: Planning Engine — Day Plan Generator (Complete)
* **Built**: `generateDayPlan()` — fetches today's tasks + timetable, calls phi3.5 with `format:'json'`, array-specific JSON extraction (`extractArrayJsonString`), per-item validation (priority whitelist, drop empty tasks, duration default), graceful fallback plan. `replan()` — server-computes remaining hours, replans incomplete tasks around a surprise event. `POST /api/emails/accept/:id` — atomic DB transaction converts accepted email to task row. Full task CRUD with real SQLite (`GET`, `POST` with date normalization, `PATCH /complete`, `DELETE`). `test-planner.js` — 3-scenario standalone test script.
* **Status**: Fully functional and verified.

### ✅ Phase 5: Conversational Chat & Night Summary (Complete)
* **Built**: `chatWithSeva()` — conversational AI with today's plan as context, stored in `chat_history` table. `generateNightSummary()` — end-of-day review, carry-forward of missed tasks, productivity streak update.
* **Status**: Fully functional and verified.

### ⏳ Phase 6: Backend API Polish (Planned)
* **Planned**: Complete error handling across all routes, Postman collection, API documentation.

### ⏳ Phase 7: Frontend — React Dashboard (Planned)
* **Pre-requisite (Complete)**: Added `/api/timetable` endpoints to support first-time user setup before building the frontend.
* **Planned**: 6 React screens — Dashboard, Email triage, Plan view, Tasks, Chat, Night summary.

### ⏳ Phase 8: Polish & Demo Readiness (Planned)
* **Planned**: Bug fixes, final testing, demo video, and presentation preparation.

---

## 8. Key Concepts Used

### 1. OAuth 2.0 Authorization Code Flow
OAuth 2.0 allows SEVA to obtain authorization to read user emails without receiving or storing user passwords. SEVA requests the read-only scope `https://www.googleapis.com/auth/gmail.readonly`. Google issues an access token for short-term API calls and a refresh token saved to `credentials/token.json` for background re-authentication.

### 2. Embedded SQLite Database & `better-sqlite3`
SQLite is a zero-configuration database that stores all data inside `backend/seva.db`. Using `better-sqlite3`, queries execute synchronously directly on local disk, eliminating asynchronous promise overhead and providing fast database operations.

### 3. Structured JSON Generation & Validation Guards
Local language models can produce unexpected text formatting. SEVA enforces JSON output at the Ollama decoding layer using `format: 'json'`. Additionally, `aiService.js` validates outputs using substring brace extraction, prompt-echo detection, case normalization, and synonym mapping (`'assignment'` $\rightarrow$ `'deadline'`).

### 4. Background Scheduling via `node-cron`
`node-cron` registers a timer on the Node.js V8 Event Loop executing `*/30 * * * *` (every 30 minutes). It checks if `token.json` exists, fetches new Gmail messages, and runs Phi-3.5 AI analysis asynchronously without blocking the server.

---

## 9. How to Run the Project (Step-by-Step)

### Prerequisites:
* **Node.js**: v18 or higher installed.
* **Ollama**: Installed on Windows with `phi3.5` model pulled (`ollama pull phi3.5`).

### Step 1: Open Project Directory
```bash
cd c:\SEVA\backend
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Verify Environment Setup
Ensure `c:\SEVA\backend\.env` contains:
```env
PORT=3001
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/callback
```
Ensure `c:\SEVA\backend\credentials\client_secret.json` exists.

### Step 4: Start the Backend Server
```bash
node server.js
```

### Step 5: Test & Verify Endpoints in Browser
1. **Health Check**: Open [http://localhost:3001/](http://localhost:3001/)
2. **Google OAuth Login**: Open [http://localhost:3001/api/auth/gmail](http://localhost:3001/api/auth/gmail) and complete sign-in.
3. **Fetch & Analyze Emails**: Open [http://localhost:3001/api/emails/fetch](http://localhost:3001/api/emails/fetch)
4. **View Stored Intelligence**: Open [http://localhost:3001/api/emails/today](http://localhost:3001/api/emails/today)

---

## 11. Known Issues Found & Fixed (Viva Q&A Material)

### 1. Date & Timezone Mismatch Bug (UTC vs. Local Time)
* **Problem**: `new Date().toISOString().split('T')[0]` was previously used for date formatting. Because `.toISOString()` returns UTC time, server queries executed between 12:00 AM IST and 05:30 AM IST (in `+05:30`) evaluated to yesterday's date (e.g., `2026-09-19` instead of `2026-09-20`). This caused day plan generation, task lookups, and Night Summary carry-forward operations to fail or misalign on day boundaries.
* **Solution**: Implemented a centralized helper module `backend/utils/dateUtils.js` exporting `getTodayDate()` that formats `YYYY-MM-DD` using local server time (`getFullYear()`, `getMonth()`, `getDate()`). Standardized all route and service date calculations across the backend codebase.

### 2. AI Task Hallucination & Whitelist Safeguards
* **Problem**: During replanning (`POST /api/plan/replan`), Ollama (`phi3.5`) hallucinated non-existent tasks (e.g., `"Data Structures Study"`, `"Relaxation"`, `"Learn New Technologies"`).
* **Attempt 1 (Task Whitelist)**: Added an `allowedTaskNames` whitelist in `validatePlanItem()` filtering AI items against `incompleteTasks`. While generic hallucinations were dropped, it also dropped the user's `surpriseEvent` slot (e.g., `"Surprise Viva"`), since one-off surprise events are not persisted in the `tasks` table.
* **Attempt 2 (Fuzzy Token Matching Flaw)**: Attempted keyword token matching to pass the surprise event. This opened a security flaw where fabricated tasks sharing a keyword (such as `"DBMS Study Session"` sharing `"DBMS"`) slipped through.
* **Final Solution**:
  1. **Strict Whitelist Matching**: Enforced 100% strict exact/trimmed whitelist matching in `validatePlanItem()` for all AI-generated items against `incompleteTasks.map(t => t.name)`. Zero hallucinated tasks or fuzzy matches allowed.
  2. **Server-Side Guaranteed Injection**: In `replan()`, the server extracts the time from `surpriseEvent` (e.g., `"2 PM"`) and injects a guaranteed slot `{ time: "2 PM", task: surpriseEvent, priority: "high", duration: 60, source: "surprise_event" }` directly into the final plan array. The AI is responsible *only* for scheduling the real incomplete tasks around the surprise event.

---

## 12. Phase 7 — Frontend UI (React SPA)

> See detailed report: `study-notes/phase7-frontend-report.md`

### Tech Stack

| Layer | Technology | Details |
|-------|-----------|--------|
| SPA Framework | React 18 (Vite) | `seva-frontend/` — runs on `localhost:3000` |
| Styling | Tailwind CSS v3 | Custom navy/black/cyan palette, `Space Grotesk` heading font, `Inter` body font |
| Routing | `react-router-dom` v6 | `BrowserRouter`, `Outlet`, `useNavigate`, `useLocation` |
| HTTP Client | Axios | `api/client.js` — `baseURL: http://localhost:3001/api` |
| Icons | `lucide-react` | Consistent icon system across all screens |

### Route Map

| URL | Screen | Description |
|-----|--------|-------------|
| `/login` | `Login.jsx` | OAuth flow + first-time timetable wizard |
| `/dashboard` | `Dashboard.jsx` | Greeting, stats, top priorities, generate plan |
| `/emails` | `EmailInsights.jsx` | Pending/Processed email tabs, accept/dismiss |
| `/dayplan` | `DayPlan.jsx` | Timeline, completion checkboxes, replan form |
| `/chat` | `Chat.jsx` | Conversational AI with history |
| `/nightsummary` | `NightSummary.jsx` | SEVA message, streak, task summary, date picker |

### Auth Guard Flow (Login.jsx)

```text
Mount → GET /api/timetable
├── HTTP 401 (no token.json)  → state: 'returning'  → show "Continue with Google" button
├── HTTP 200 + count > 0      → state: 'returning'  → show "Continue with Google" button
└── HTTP 200 + count === 0    → state: 'first_time' → show "Set Up Your Timetable" welcome

Gmail OAuth redirect (GET /api/auth/gmail → Google → GET /api/auth/callback)
└── Backend: awaits token.json write, then res.redirect('http://localhost:3000/dashboard')
└── React: Dashboard useEffect checks GET /api/timetable; if count === 0, redirects to /login?state=timetable

Refresh survival:
└── sessionStorage key 'sevaSetupInProgress': '1' set on OAuth start
└── Login.jsx useEffect checks this key first → jumps directly to setup_timetable state
└── Cleared after successful POST /api/timetable
```

### Backend Changes Made During Phase 7

1. **`gmail.js` OAuth callback**: Changed `res.send(HTML_page)` → `res.redirect('http://localhost:3000/dashboard')` after confirming `handleAuthCallback()` is fully `await`ed before the redirect. Token write order preserved.
2. **`tasks.js` PATCH `/complete`**: Changed from one-direction `completed=1` (with 409 if already done) to bidirectional toggle via `{ completed: 0|1 }` request body.
3. **`tasks.js` error shapes**: Added `success: false` to all 8 error responses for consistency.
4. **`tasks.js` max-length**: Added 300-char validation on task `name`.
5. **`timetable.js` max-length**: Added 200-char validation on timetable `subject`.

### Phase 7 Final Status

✅ All 5 screens built, connected to live backend, API-tested  
✅ Auth guard working (Login → timetable setup → Dashboard guard)  
✅ Backend polish fixes applied (toggle, max-length, error shapes)  
✅ Design language consistent across all screens (dark navy/cyan)  
✅ Loading states, error states, empty states implemented on every screen  
✅ `phase7-frontend-report.md` created with test results and bugs found  

---

## 13. Phase 9 — Month → Goals → Daily Tasks, Deterministic Scheduler & Nightly Check-In

> See detailed study notes: `study-notes/phase9-goals-scheduler.md`

### New SQLite Tables & Columns (`backend/database/db.js`)
- **`goals`**: Monthly goals with `tracking_type` (`count`, `frequency`, `milestone`), `target_count`, `current_count`, `per_week`, `manual_progress`, `daily_min_minutes`, `daily_max_minutes`, `preferred_slot`, and soft-removal (`status = 'active' | 'completed' | 'removed'`).
- **`goal_steps`**:Ordered checklist items extracted from milestone targets or added manually.
- **`goal_progress_log`**: Daily audit log of count increments, habit completions, step completions, and step-less `'worked'` sessions.
- **`daily_settings`**: Per-date `available_minutes`, fixed `window_end_minutes`, `buffer_minutes`, and `plan_note`.
- **`preferences`**: Single-row (`id = 1`) user preferences including `user_name`, `default_available_minutes`, `default_buffer_minutes`, and `neglect_days`.
- **`tasks` additive columns**: `goal_id`, `due_date`, `fixed_start`, `fixed_end`, `duration_min`, `is_urgent`.

### New Services & Routes
- **`services/goalsService.js` & `routes/goals.js`**: Goal import (`POST /api/goals/import`), computed metrics (`GET /api/goals`), reminders (`GET /api/goals/reminders`), progress logging (`POST /api/goals/:id/progress`), step CRUD, and soft removal/restore.
- **`services/schedulerService.js`**: Pure deterministic 5-layer scheduler (`buildSchedule`, `buildDayOutline`, `scoreGoal`) with neglect floor (`FLOOR_MINS = 30`, `MAX_FLOOR_PER_DAY = 2`) and buffer accounting.
- **`services/nightlyService.js` & `routes/nightly.js`**: Two-stage deterministic Nightly Check-In (`"plan tomorrow"`) that builds tomorrow's outline and lets the user rescue squeezed-out or neglected goals (`carry_forward = 1` → Layer 3 `forced`).
- **`seva-frontend/src/screens/Goals.jsx`**: Full Goals management screen (`/goals`).

---

## 14. Phase 10 — Intelligent Assistant, Goal-Plan Sync & Personalized Email Engine

> See comprehensive study notes: `study-notes/intelligent-assistant-and-personalization.md`

### Overview & Objectives Covered
Phase 10 transformed SEVA from a conversational chatbot that only generated descriptive text into an **action-oriented, familiar personal assistant** that updates system state deterministically, maintains bidirectional goal and schedule synchronization, and understands personal academic context.

### Core Architecture Components Added:
1. **Natural Language Action Engine (`backend/services/actionEngine.js`)**:
   - Parses intent with priority hierarchy: Availability updates → Progress corrections → Count progress → Milestone steps → Task rescheduling → Priority adjustment → Task creation → Task completion → Habit notices → Important email queries.
   - Distinguishes past completed work (*"I completed two DSA problems"*) from future planning (*"I will solve two DSA problems"*).
   - Atomic SQLite transactions updating `goals.current_count`, `goal_progress_log`, `tasks.completed`, and `day_plans.plan_json`.
   - 30-second idempotency deduplication window preventing double-counting on network retries.
   - Conflict-aware schedule moves against fixed timetable lectures.
2. **Personalized Email Classifier (`backend/services/emailClassifier.js`)**:
   - Single source of truth for identity (`user_name`, `user_prn`) in SQLite `preferences`.
   - Strict PRN normalization with lookahead/lookbehind (`(?<![a-zA-Z0-9])246100104(?![a-zA-Z0-9])`) and surrounding phone/transaction exclusion window.
   - Dynamic name permutation (`"Pranav Sawant"`, `"Sawant Pranav"`).
   - Structured table and attachment text parsing isolating student attendance rows.
   - Individual percentage extraction vs threshold discrimination (e.g. `64%` extracted, `"below 75%"` ignored).
   - Discriminates genuine calendar invitations (`isActionableInvitation`) from circulars and defaulter lists.
   - Continuous user feedback weighting via `email_feedback` table.
3. **Database Schema Enhancements (`backend/database/db.js`)**:
   - Guarded column migrations: `preferences.user_prn` (default `'246100104'`), `preferences.user_name` (default `'Pranav Sawant'`).
   - Guarded email columns: `is_personal`, `importance_category`, `relevance_score`, `action_required`, `matched_identity`, `user_feedback`, `reviewed`, `dismissed`.
   - Created `email_feedback` table.
4. **API Endpoints & Guards (`backend/routes/gmail.js`, `backend/routes/settings.js`)**:
   - `GET /api/emails/today?filter=important|defaulter|personal|all`
   - `POST /api/emails/:id/feedback`, `POST /api/emails/:id/review`, `POST /api/emails/:id/dismiss-alert`
   - Guarded `POST /api/emails/accept/:id` against accepting attendance/defaulter notices.
   - `PUT /api/settings/preferences` supporting `user_prn`.
5. **Frontend UI Overhaul (`seva-frontend/src/screens/EmailInsights.jsx`)**:
   - Personally Relevant badge pills with matched identity audit tags.
   - Filter bar: Important (Default), Defaulter Lists, Personal Only, All Emails.
   - Replaced inappropriate "Accept Task" with "Mark Reviewed", "Dismiss Alert", and "View Details".
   - Integrated Thumbs Up/Down feedback buttons.
6. **Automated Integration Testing (`backend/scripts/test-intelligent-assistant.js`)**:
   - 34/34 passing assertions across 5 suites under temporary `SEVA_DB_PATH` isolation.

---
*End of SEVA Master Architecture Specification*

