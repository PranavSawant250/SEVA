const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const { getTodayDate, getTomorrowDate, minutesToTimeString } = require('../utils/dateUtils');
const { getAllGoals } = require('./goalsService');


// Preferred model configuration (Standardized on phi3.5 after 5/5 precision test)
const PREFERRED_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';

// Allowed enum values for validation (all lowercase)
const ALLOWED_EVENT_TYPES = ['meeting', 'deadline', 'opportunity', 'general'];
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];

// Synonyms map to handle model off-spec variations
const EVENT_TYPE_SYNONYMS = {
  'assignment': 'deadline',
  'submission': 'deadline',
  'due': 'deadline',
  'due date': 'deadline',
  'exam': 'deadline',
  'quiz': 'deadline',
  'homework': 'deadline',
  'sync': 'meeting',
  'call': 'meeting',
  'interview': 'meeting',
  'appointment': 'meeting',
  'standup': 'meeting',
  'internship': 'opportunity',
  'job': 'opportunity',
  'hiring': 'opportunity',
  'contest': 'opportunity',
  'hackathon': 'opportunity',
  'scholarship': 'opportunity'
};

// Prompt placeholder strings to guard against model echo hallucinations
const PROMPT_PLACEHOLDERS = [
  'extracted time',
  'extracted time/date',
  'date string or null',
  'one-line summary',
  'under 15 words',
  'concise and under',
  'time/date string'
];

/**
 * Check if a string contains prompt placeholder text echoed by model
 */
function containsPlaceholderEcho(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return PROMPT_PLACEHOLDERS.some(ph => lower.includes(ph));
}

/**
 * Clean raw text from Ollama by extracting content between the first '{' and last '}'
 */
function extractJsonString(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return rawText.substring(firstBrace, lastBrace + 1);
  }

  return null;
}

/**
 * Normalize event_type using case normalization and synonym mapping
 */
function normalizeEventType(rawType) {
  if (!rawType || typeof rawType !== 'string') return 'general';
  const clean = rawType.toLowerCase().trim();

  if (ALLOWED_EVENT_TYPES.includes(clean)) {
    return clean;
  }

  if (EVENT_TYPE_SYNONYMS[clean]) {
    return EVENT_TYPE_SYNONYMS[clean];
  }

  return 'general';
}

/**
 * Normalize priority using case normalization
 */
function normalizePriority(rawPriority) {
  if (!rawPriority || typeof rawPriority !== 'string') return 'medium';
  const clean = rawPriority.toLowerCase().trim();

  if (ALLOWED_PRIORITIES.includes(clean)) {
    return clean;
  }

  return 'medium';
}

/**
 * Analyzes an email object (subject, sender, body_preview) using local Ollama model
 * @param {Object} emailContent { subject, sender, body_preview }
 * @param {String} modelOverride Optional model parameter ('tinyllama', 'phi3.5')
 * Returns validated JSON object: { event_type, priority, time, summary }
 */
async function analyzeEmail(emailContent, modelOverride = null) {
  const modelToUse = modelOverride || PREFERRED_MODEL;
  const subject = emailContent.subject || 'No Subject';
  const sender = emailContent.sender || 'Unknown Sender';
  const bodyPreview = emailContent.body_preview || '';

  // Construct safe default response in case parsing, validation, or AI fails
  const safeDefault = {
    event_type: 'general',
    priority: 'medium',
    time: null,
    summary: subject.substring(0, 60)
  };

  const systemPrompt = `You are an AI email analyzer. Analyze the provided email and output ONLY a valid JSON object. Do not include markdown formatting or extra text.

Required JSON Structure:
{
  "event_type": "meeting" | "deadline" | "opportunity" | "general",
  "priority": "high" | "medium" | "low",
  "time": "extracted time string or null",
  "summary": "short summary under 15 words"
}

Rules:
- event_type must be strictly one of: "meeting", "deadline", "opportunity", or "general".
- priority must be strictly one of: "high", "medium", or "low".
- time: extract specific date/time mentioned in text, otherwise set to null.
- summary: must summarize the actual email content concisely. Do not output placeholder text.`;

  const userPrompt = `Subject: ${subject}
From: ${sender}
Body Preview: ${bodyPreview}`;

  try {
    const response = await ollama.chat({
      model: modelToUse,
      format: 'json', // Forces Ollama structured JSON decoding mode
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const rawResponse = response.message ? response.message.content : '';
    const cleanedJsonStr = extractJsonString(rawResponse) || rawResponse;

    let parsed = null;
    try {
      parsed = JSON.parse(cleanedJsonStr);
    } catch (parseErr) {
      console.warn(`⚠️ [${modelToUse}] JSON.parse failed. Raw response:`, rawResponse);
      return safeDefault;
    }

    if (!parsed || typeof parsed !== 'object') {
      return safeDefault;
    }

    // Validation Guard 1: Detect prompt template-echo hallucinations
    if (containsPlaceholderEcho(parsed.summary) || containsPlaceholderEcho(parsed.time)) {
      console.warn(`⚠️ [${modelToUse}] Detected prompt placeholder echo in model response. Falling back to default.`);
      return safeDefault;
    }

    // Validation Guard 2: Case-normalized and synonym-mapped enum validation
    const event_type = normalizeEventType(parsed.event_type);
    const priority = normalizePriority(parsed.priority);
    
    // Validation Guard 3: Sanitize time and summary
    let time = (typeof parsed.time === 'string' && parsed.time.trim()) ? parsed.time.trim() : null;
    if (time && (time.toLowerCase() === 'null' || containsPlaceholderEcho(time))) {
      time = null;
    }

    let summary = (typeof parsed.summary === 'string' && parsed.summary.trim()) 
      ? parsed.summary.trim().substring(0, 100) 
      : subject.substring(0, 60);

    if (containsPlaceholderEcho(summary)) {
      summary = subject.substring(0, 60);
    }

    return {
      event_type,
      priority,
      time,
      summary
    };
  } catch (err) {
    console.error(`❌ Error invoking Ollama analyzeEmail() with model ${modelToUse}:`, err.message);
    return safeDefault;
  }
}

/**
 * Process all emails in SQLite table where event_type IS NULL
 */
async function processUnanalyzedEmails() {
  const unanalyzed = db.prepare('SELECT id, subject, sender, body_preview FROM emails WHERE event_type IS NULL').all();

  if (unanalyzed.length === 0) {
    console.log('ℹ️ No unanalyzed emails found in database.');
    return 0;
  }

  console.log(`🤖 Starting AI analysis for ${unanalyzed.length} unanalyzed email(s) using model ${PREFERRED_MODEL}...`);

  const updateStmt = db.prepare(`
    UPDATE emails 
    SET event_type = ?, priority = ?, summary = ?
    WHERE id = ?
  `);

  let count = 0;

  for (const email of unanalyzed) {
    console.log(`🔍 [${count + 1}/${unanalyzed.length}] Analyzing Email ID ${email.id}: "${email.subject.substring(0, 40)}..."`);

    const result = await analyzeEmail(email);

    updateStmt.run(result.event_type, result.priority, result.summary, email.id);
    count++;

    console.log(`   └─ Analyzed! Type: ${result.event_type} | Priority: ${result.priority} | Summary: "${result.summary}"`);
  }

  console.log(`✅ Finished AI analysis for ${count} email(s).`);
  return count;
}

// ─────────────────────────────────────────────────────────────
// Context window safety valve for chatWithSeva()
//
// ollama show phi3.5 reports architecture context_length = 131,072 tokens.
// However: without explicit num_ctx, Ollama pre-allocates the FULL 131k KV cache
// on cold load — that was the root cause of the 118.6s cold-start spike.
//
// We now set num_ctx = 8192 tokens explicitly in ollama.chat() options.
// This caps KV cache to a practical working window: 8192 tokens * 4 chars ≈ 32,768 chars.
// Safe trim threshold = 70% of that = ~22,937 chars.
//
// At current data volume (~3,500 chars), the trim valve will NEVER fire.
// It activates gracefully months from now if history grows large.
// Trimming: oldest chat_history messages only. System prompt, night summaries
// and static context are NEVER trimmed — they are measured into staticChars.
// ─────────────────────────────────────────────────────────────
const CHAT_NUM_CTX = 8192;                                      // explicit KV cache window (tokens)
const CHAT_SAFE_THRESHOLD = Math.floor(CHAT_NUM_CTX * 4 * 0.70); // ~22,937 chars

/**
 * chatWithSeva(userMessage, currentInsertedMsgId = null)
 *
 * Conversational chat helper with SEVA AI.
 * Full historical context: ALL past chat messages (all dates, no LIMIT),
 * plus last 10 night summaries as compact long-term digest.
 * Safety valve: if assembled prompt exceeds 75% of phi3.5's 131k-token context window,
 * oldest chat_history messages are trimmed first until it fits.
 *
 * @param {string} userMessage User prompt text
 * @param {number|null} currentInsertedMsgId Optional ID of user message just inserted into chat_history to exclude from history fetch
 * @returns {string} SEVA's response text (plain text)
 */
async function chatWithSeva(userMessage, currentInsertedMsgId = null, todayDateObj = new Date()) {
  const today = getTodayDate(todayDateObj);
  const tomorrow = getTomorrowDate(todayDateObj);

  try {
    // ── 1. Fetch FULL chat history (all dates, no date filter, no LIMIT) ─────────
    let historyRows;
    if (currentInsertedMsgId) {
      historyRows = db.prepare(`
        SELECT id, role, message
        FROM chat_history
        WHERE id != ?
        ORDER BY id ASC
      `).all(currentInsertedMsgId);
    } else {
      historyRows = db.prepare(`
        SELECT id, role, message
        FROM chat_history
        ORDER BY id ASC
      `).all();
    }

    // Cap any individual legacy history message in memory to 1600 chars (~400 tokens, matching num_predict=400)
    // so pre-safety-valve runaway replies (e.g. 21k chars) don't pollute context or exhaust VRAM
    historyRows = historyRows.map(r => ({
      ...r,
      message: (r.message && r.message.length > 1600)
        ? r.message.substring(0, 1600) + '...'
        : (r.message || '')
    }));

    // ── 2. Fetch last 10 night_summary rows as compact historical digest ──────────
    const summaryRows = db.prepare(`
      SELECT date, completed_tasks, missed_tasks, carry_forward, seva_message, streak
      FROM night_summary
      ORDER BY date DESC
      LIMIT 10
    `).all().reverse(); // Oldest first for chronological narrative

    let summaryContext = '';
    if (summaryRows.length > 0) {
      summaryContext = summaryRows.map(s => {
        let completed = [];
        let missed = [];
        try { completed = JSON.parse(s.completed_tasks || '[]'); } catch (_) {}
        try { missed = JSON.parse(s.missed_tasks || '[]'); } catch (_) {}
        const completedNames = completed.map(t => t.name).join(', ') || 'none';
        const missedNames = missed.map(t => t.name).join(', ') || 'none';
        return `[${s.date}] Streak: ${s.streak} day(s). Completed: ${completedNames}. Missed: ${missedNames}. Note: "${s.seva_message}"`.substring(0, 400);
      }).join('\n');
    }

    // ── 3. Fetch active goals with real progress, behind_by, days_left ───────────
    const activeGoals = getAllGoals(todayDateObj).filter(g => g.status === 'active');
    const goalsContext = activeGoals.length > 0
      ? activeGoals.map(g => {
          const deadlineStatus = g.is_overdue
            ? `OVERDUE (deadline ${g.deadline}, days_left=0)`
            : `days_left=${g.days_left} (deadline ${g.deadline})`;
          const extra = g.goal_type === 'count'
            ? `, ${g.current_count}/${g.target_count} problems done`
            : g.goal_type === 'frequency'
            ? `, ${g.days_this_week || 0}/${g.per_week} days this week`
            : g.progress_source === 'no_progress_data'
            ? `, no steps defined yet`
            : '';
          return `- "${g.title}" [${g.category}, priority=${g.priority}]: progress=${g.progress}%, expected=${g.expected_progress}%, behind_by=${g.behind_by}%, ${deadlineStatus}${extra}`;
        }).join('\n')
      : 'None (no active goals).';

    // ── 4. Fetch today's window and today's saved plan ───────────────────────────
    let windowContext = 'No window set for today.';
    try {
      const { getTodayWindow } = require('../routes/settings');
      const win = getTodayWindow(today);
      if (win) {
        if (win.done_for_day === 1) {
          windowContext = 'Done for today.';
        } else if (win.window_end_minutes !== null) {
          windowContext = `Active until ${minutesToTimeString(win.window_end_minutes)} (${win.source}).`;
        }
      }
    } catch (_) {}

    const planRow = db.prepare(`SELECT plan_json FROM day_plans WHERE date = ?`).get(today);
    let planContext = 'No day plan generated yet for today.';
    if (planRow && planRow.plan_json) {
      try {
        const parsedPlan = JSON.parse(planRow.plan_json);
        if (Array.isArray(parsedPlan) && parsedPlan.length > 0) {
          planContext = parsedPlan
            .map(slot => `[${slot.time || 'flexible'}] ${slot.task} (${slot.priority || 'medium'}, ${slot.duration || 30}m)`)
            .join('; ');
        }
      } catch (e) {
        planContext = planRow.plan_json;
      }
    }

    // ── 5. Fetch today's pending tasks and tomorrow's planned tasks ──────────────
    const pendingTasks = db.prepare(`
      SELECT name, priority, time_slot
      FROM tasks
      WHERE date = ? AND completed = 0
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    `).all(today);

    const pendingTasksContext = pendingTasks.length > 0
      ? pendingTasks.map(t => `"${t.name}" (${t.priority}${t.time_slot ? `, ${t.time_slot}` : ''})`).join(', ')
      : 'None (all tasks completed or no tasks scheduled)';

    const tomorrowTasks = db.prepare(`
      SELECT name, priority, time_slot, duration_min
      FROM tasks
      WHERE date = ? AND completed = 0
      ORDER BY id ASC
    `).all(tomorrow);

    const tomorrowTasksContext = tomorrowTasks.length > 0
      ? tomorrowTasks.map(t => `"${t.name}" (${t.priority}${t.time_slot ? `, ${t.time_slot}` : ''}${t.duration_min ? `, ${t.duration_min}m` : ''})`).join(', ')
      : 'Nothing planned yet for tomorrow.';

    // ── 6. Build system prompt (never trimmed by safety valve) ───────────────────
    const systemPrompt = `You are SEVA, a warm, intelligent, and helpful personal planning assistant.

Today's Date: ${today}
Tomorrow's Date: ${tomorrow}
Today's Window: ${windowContext}
Today's Current Plan: ${planContext}
Pending Incomplete Tasks Today: ${pendingTasksContext}
Tasks Already Planned for Tomorrow (${tomorrow}): ${tomorrowTasksContext}

Active Goals (ONLY these goals exist in the database):
${goalsContext}${
  summaryContext ? `\n\nPast Daily Summaries (chronological digest):\n${summaryContext}` : ''
}

Instructions:
- Respond naturally and conversationally.
- Keep responses concise (2-4 sentences) unless the user explicitly requests details.
- You may mix Hindi and English (Hinglish) naturally if the user does.
- Only state goal progress numbers that appear in the context above.
- If the user asks about a goal that is NOT listed under "Active Goals" above (for example, a Rust goal or any other unlisted goal), state clearly that no such goal exists in your goals list.
- Strictly ground your responses in the context provided above. Do NOT invent meetings, deadlines, tasks, or plan slots that do not exist.
- Never confirm details (times, dates, event names) that the user states unless they match your context exactly. If a user mentions a specific time, date, or detail that does NOT match what's in your provided context, explicitly correct them with the ACTUAL scheduled time or state that no event exists at their stated time.
- If asked about information not present in context, state honestly that you do not have that information.`;

    // ── 6. Safety valve: estimate assembled prompt size, trim oldest msgs if needed ─
    // Estimate: system prompt + history + new user message
    const historyChars = historyRows.reduce((sum, r) => sum + r.message.length, 0);
    const staticChars = systemPrompt.length + userMessage.length + 200; // 200 chars overhead
    const totalEstimatedChars = staticChars + historyChars;

    let trimmedCount = 0;
    let workingHistory = [...historyRows]; // Mutable copy for trimming

    if (totalEstimatedChars > CHAT_SAFE_THRESHOLD) {
      let currentSize = totalEstimatedChars;
      while (workingHistory.length > 0 && currentSize > CHAT_SAFE_THRESHOLD) {
        const removed = workingHistory.shift(); // Remove oldest message
        currentSize -= removed.message.length;
        trimmedCount++;
      }
      console.warn(`⚠️ Chat history exceeds safe context size (${totalEstimatedChars} chars) — trimmed ${trimmedCount} oldest message(s) to fit under ${CHAT_SAFE_THRESHOLD} char threshold.`);
    } else {
      console.log(`   └─ Context size: ${totalEstimatedChars} chars | History: ${historyRows.length} messages | Threshold: ${CHAT_SAFE_THRESHOLD} chars — no trimming needed.`);
    }

    // ── 7. Format message payload for Ollama chat ─────────────────────────────────
    // Place a compact system grounding reminder right before the latest user message
    // so phi3.5 (3.8B) attends strictly to current DB facts even when chat_history has many turns.
    const liveGroundingReminder = [
      `LIVE DATABASE FACTS (ground your answer ONLY in these facts; reply in 2-4 concise sentences, no motivational quotes or Pomodoro tips):`,
      `Today (${today}) Window: ${windowContext}`,
      `Today (${today}) Plan: ${planContext}`,
      `Tomorrow (${tomorrow}) Planned Tasks: ${tomorrowTasksContext}`,
      `Active Goals:\n${goalsContext}`,
      `Rule: Only state goal progress numbers that appear above. If asked about a goal not listed in Active Goals above, state clearly that no such goal exists. When asked about tomorrow (${tomorrow}), report ONLY the Tomorrow Planned Tasks line above (do NOT list today's plan items as tomorrow's).`
    ].join('\n');

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...workingHistory.map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.message })),
      { role: 'system', content: liveGroundingReminder },
      { role: 'user', content: userMessage }
    ];

    console.log(`🤖 Calling Ollama chatWithSeva() with model "${PREFERRED_MODEL}" (${formattedMessages.length} messages in payload)...`);
    let response;
    try {
      response = await ollama.chat({
        model: PREFERRED_MODEL,
        messages: formattedMessages,
        keep_alive: '30m',          // Keep model loaded for 30 min — eliminates cold-start spikes
        options: {
          temperature: 0.3,
          num_ctx: CHAT_NUM_CTX,    // Explicit 8192-token KV cache — prevents full 131k allocation
          num_predict: 400          // Generous output ceiling: ~300 words, prevents runaway replies
        }
      });
    } catch (primaryErr) {
      console.warn(`⚠️ Primary Ollama chat call failed (${primaryErr.message}); retrying with CPU fallback...`);
      response = await ollama.chat({
        model: PREFERRED_MODEL,
        messages: formattedMessages,
        keep_alive: '30m',
        options: {
          temperature: 0.3,
          num_ctx: 4096,
          num_predict: 400,
          num_gpu: 0
        }
      });
    }

    const reply = response.message ? response.message.content.trim() : '';
    return reply || "I'm here to help! What would you like to know about your day?";
  } catch (err) {
    console.error('❌ Error in chatWithSeva():', err.message);
    return "Sorry, I'm having trouble responding right now. Please try again in a moment.";
  }
}

module.exports = {
  PREFERRED_MODEL,
  analyzeEmail,
  processUnanalyzedEmails,
  chatWithSeva
};

