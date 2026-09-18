const ollama = require('ollama').default || require('ollama');
const db = require('../database/db');

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

module.exports = {
  PREFERRED_MODEL,
  analyzeEmail,
  processUnanalyzedEmails
};
