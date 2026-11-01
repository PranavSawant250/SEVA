# SEVA — Live Demo Presentation Script & Panel Guide

**Total Duration:** ~6 Minutes  
**Target Audience:** Final Year Project Panel / Internal Guide  
**Presenter Strategy:** Talk through system architecture and design principles during AI generation waiting windows (15–20s) so there is zero dead air.

---

## Demo Timeline Overview

| Phase | Section | Screen / Feature | Duration |
|---|---|---|---|
| 1 | Architecture & Concept | Slides / Introduction | 0:45 |
| 2 | Email Insights | Email Insights (`/emails`) | 1:15 |
| 3 | AI Day Plan Generation | Dashboard & Day Plan (`/plan`) | 1:30 |
| 4 | Interactive Execution & Re-planning | Day Plan (`/plan`) | 1:00 |
| 5 | Chat & Night Summary Reflection | Chat (`/chat`) & Summary (`/summary`) | 1:00 |

---

## ⚡ Pre-Demo Checklist (Run ~2 minutes before panel starts)

> **Critical:** phi3.5 loads a KV cache on first inference. Without pre-warming, the first chat/plan call can take 10–120s depending on how long the model has been idle. These steps eliminate that spike entirely.

```bash
# 1. Start Ollama (if not running)
ollama serve

# 2. Pre-warm phi3.5 — sends one throwaway inference to load KV cache
ollama run phi3.5 "hi"
# Expected: fast reply in 2-5s. Model is now resident in memory.

# 3. Start backend (if not running)
cd C:\SEVA\backend && node server.js

# 4. Start frontend (if not running)
cd C:\SEVA\seva-frontend && npm start

# 5. Open browser to http://localhost:3000 — verify Dashboard loads
# 6. Re-authenticate Google if Email Insights shows red error banner
```

> **Why this works:** `keep_alive: '30m'` is now set on every `ollama.chat()` call in SEVA — the model stays loaded for 30 minutes after the last call. After pre-warming, all subsequent demo interactions use a warm model.

---

## Step-by-Step Demo Script

### Act 1: Introduction & System Architecture (0:45)
* **Action**: Start on the SEVA Dashboard screen.
* **Presenter Script**:
  > "Good morning/afternoon, respected panel members. Today I am presenting **SEVA** — a privacy-first Personal Life Orchestrator. 
  > Students and professionals struggle with fragmented schedules across emails, classes, and task lists. SEVA bridges this gap by unifying Gmail email classification, recurring timetables, local AI schedule generation, and dynamic day replanning — running 100% locally on user hardware using Node.js, SQLite with WAL mode, and local LLM inference via Ollama."

---

### Act 2: Gmail Intelligence & Step 0 Email Acceptance (1:15)
* **Action**: Click on **Email Insights** in the navigation bar.
* **Presenter Script**:
  > "Let's begin with Email Intelligence. SEVA connects securely to Gmail via Google OAuth 2.0. Rather than automatically dumping every email into your task list, SEVA uses AI to analyze incoming messages and classify them by priority and actionability."
* **Action**: Point out an email item (e.g. *"IIT Madras Course Registration"* or *"Lab Report Submission"*).
* **Presenter Script**:
  > "Notice how SEVA extracted the summary and assigned a 'high' priority. As a user, I have full control: I can dismiss non-actionable emails or click **Accept**. When I click Accept, SEVA executes an atomic SQLite transaction — updating the email status and inserting a corresponding row directly into the master `tasks` table."
* **Action**: Click **Accept** on the target email. Show the green success toast.

---

### Act 3: Timetable Integration & AI Day Plan Generation (1:30)
* **Action**: Click on **Day Plan** in the navigation bar.
* **Presenter Script**:
  > "Now let's look at SEVA's core intelligence: AI Day Plan Generation. SEVA combines three data sources: fixed recurring class timetables, manual tasks, and accepted email tasks."
* **Action**: Click **Generate Day Plan**. *(AI generation takes ~15–20 seconds)*
* **Presenter Talking Point (During AI Wait - Zero Dead Air)**:
  > "While Ollama's `phi3.5` model compiles our schedule in the background, I'd like to highlight our 3-tier safety engine. Local SLMs can occasionally hallucinate tasks or output duplicate slots. SEVA enforces strict prompt whitelisting, a `Set`-based deduplication layer, and a deterministic fallback module. Even if JSON extraction fails, SEVA orders tasks by time slot without crashing."
* **Action**: Point to the rendered hour-by-hour day plan as it appears on screen.

---

### Act 4: Interactive Task Execution & Dynamic Replanning (1:00)
* **Action**: Click the completion checkbox on a plan task item (e.g., *"Review Database lecture notes"*).
* **Presenter Script**:
  > "As I go through my day, I can check off completed tasks. Notice the instant strikethrough. Behind the scenes, SEVA performs date-scoped task matching, ensuring today's task row is marked complete in SQLite without modifying historical logs."
* **Action**: Type `"Surprise Lab Exam at 2 PM"` into the Replan input field and click **Replan Day**.
* **Presenter Script**:
  > "Life is unpredictable. If an unexpected event occurs — like a surprise lab exam at 2 PM — I simply type it into the replan box. SEVA extracts the time slot, injects a guaranteed high-priority slot at 2 PM, and dynamically reorders remaining tasks around it."

---

### Act 5: Conversational Assistant & Night Summary Reflection (1:00)
* **Action**: Navigate to **Chat** screen. Type: *"What tasks do I have remaining today?"*
* **Presenter Script**:
  > "Users can also interact with SEVA conversationally. The chat assistant is injected with today's live schedule and active tasks, providing immediate, context-aware answers."
* **Action**: Navigate to **Night Summary** screen.
* **Presenter Script**:
  > "Finally, at the end of the day, SEVA generates a Night Summary. It segregates completed versus missed tasks, computes your productivity streak, and automatically carries forward high/medium priority missed tasks to tomorrow so nothing falls through the cracks."

---

### Act 6: Monthly Goals, Deterministic 5-Layer Scheduler & Nightly Check-In (1:30)
* **Action**: Navigate to **Goals** (`/goals`). Show the 6 imported October goals grouped by category (`Technical`, `DSA`, `Academic`, `Personal`) with auto/manual progress bars, step checklists, and pace markers.
* **Presenter Script**:
  > "In Phase 9, SEVA bridges monthly goals and daily execution. Notice that the AI never decides times or task allocations: our pure deterministic 5-layer scheduler allocates fixed commitments first, then urgent deadlines, forced items, daily habits, and a 30-minute neglect floor so goals like PostgreSQL + Spring Boot are never starved by earlier deadlines."
* **Action**: Navigate to **Chat** (`/chat`) and click **"Plan tomorrow"** (or type `"plan tomorrow"`), reply `"4 hours"`, then reply `"1 and 2, also add Submit project report 45m"`.
* **Presenter Script**:
  > "At night, the deterministic Nightly Check-In builds a rough outline for tomorrow around tomorrow's timetable, surfaces squeezed-out or neglected goals by number, and locks selected goals into Layer 3 forced slots for tomorrow."

---

## Emergency Troubleshooting & Panel Q&A Cheat Sheet

| Situation / Question | Recommended Answer / Recovery Action |
|---|---|
| **Ollama response takes > 25 seconds** | Explain local LLM CPU/GPU inference trade-off: *"Because SEVA runs 100% locally for user data privacy rather than sending data to external APIs, inference speed depends on local hardware."* |
| **Google OAuth token expired error** | Click the **Re-authenticate Google** button on Email Insights screen, authorize in popup browser tab. |
| **Panel asks: "Why not use Cloud GPT-4?"** | *"SEVA prioritizes 100% data privacy and offline capability. Personal emails and daily schedules contain sensitive personal data that users should not be forced to send to third-party cloud APIs."* |
| **Panel asks: "What happens if Ollama returns malformed output?"** | Explain 3-tier defense: *"SEVA catches parsing errors, logs a warning, and seamlessly switches to the deterministic fallback plan without interrupting the user experience."* |
| **Panel asks: "How are carry-forward tasks handled?"** | *"Only high and medium priority missed tasks are carried forward to prevent low-priority task accumulation over time."* |
