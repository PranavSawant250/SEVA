const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');


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

/**
 * chatWithSeva(userMessage, currentInsertedMsgId = null)
 *
 * Conversational chat helper with SEVA AI.
 * Context-aware: ingests today's day plan, pending tasks, and recent 10 chat messages.
 *
 * @param {string} userMessage User prompt text
 * @param {number|null} currentInsertedMsgId Optional ID of user message just inserted into chat_history to exclude from history fetch
 * @returns {string} SEVA's response text (plain text)
 */
async function chatWithSeva(userMessage, currentInsertedMsgId = null) {
  const today = getTodayDate();

  try {
    // 1. Fetch recent chat history for today (up to last 10 turns, excluding current turn if provided)
    let historyRows;
    if (currentInsertedMsgId) {
      historyRows = db.prepare(`
        SELECT role, message
        FROM (
          SELECT id, role, message
          FROM chat_history
          WHERE date = ? AND id != ?
          ORDER BY id DESC
          LIMIT 10
        )
        ORDER BY id ASC
      `).all(today, currentInsertedMsgId);
    } else {
      historyRows = db.prepare(`
        SELECT role, message
        FROM (
          SELECT id, role, message
          FROM chat_history
          WHERE date = ?
          ORDER BY id DESC
          LIMIT 10
        )
        ORDER BY id ASC
      `).all(today);
    }

    // 2. Fetch today's plan from day_plans
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

    // 3. Fetch today's pending tasks (incomplete)
    const pendingTasks = db.prepare(`
      SELECT name, priority, time_slot
      FROM tasks
      WHERE date = ? AND completed = 0
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    `).all(today);

    const pendingTasksContext = pendingTasks.length > 0
      ? pendingTasks.map(t => `"${t.name}" (${t.priority}${t.time_slot ? `, ${t.time_slot}` : ''})`).join(', ')
      : 'None (all tasks completed or no tasks scheduled)';

    // 4. Construct System Prompt
    const systemPrompt = `You are SEVA, a warm, intelligent, and helpful personal planning assistant.

Today's Date: ${today}
Today's Current Plan: ${planContext}
Pending Incomplete Tasks: ${pendingTasksContext}

Instructions:
- Respond naturally and conversationally.
- Keep responses concise (2-4 sentences) unless the user explicitly requests details.
- You may mix Hindi and English (Hinglish) naturally if the user does.
- Strictly ground your responses in the context provided above. Do NOT invent meetings, deadlines, or plan slots that do not exist.
- If asked about information not present in context, state honestly that you do not have that information.`;

    // 5. Format message payload for Ollama chat
    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...historyRows.map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.message })),
      { role: 'user', content: userMessage }
    ];

    console.log(`🤖 Calling Ollama chatWithSeva() with model "${PREFERRED_MODEL}"...`);
    const response = await ollama.chat({
      model: PREFERRED_MODEL,
      messages: formattedMessages
    });

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

