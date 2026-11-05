/**
 * backend/services/groqProvider.js
 *
 * Dedicated Groq Provider Adapter for SEVA.
 * Model: openai/gpt-oss-120b (Primary Provider)
 *
 * Features:
 * - Server-side authentication with startup resilience (never crashes on missing key)
 * - Sequential tool-call support (parallel_tool_calls: false)
 * - Safe JSON parsing for arguments with malformed-syntax recovery
 * - Timeout enforcement via AbortController to prevent dangling background execution
 * - Circuit breaker with rate-limit and quota classification
 * - Latency and token usage instrumentation
 */

let Groq = null;
try {
  Groq = require('groq-sdk');
} catch (e) {
  // If groq-sdk is missing, fallback gracefully
  Groq = null;
}

const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const DEFAULT_GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GROQ_TIMEOUT_MS, 10) || 45000; // 45s bounded timeout for 120B reasoning model

// ─────────────────────────────────────────────────────────────
// STATE & CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────────
let groqClient = null;
let isGroqConfigured = false;
let initWarningLogged = false;

let circuitBreakerUntil = 0;
let circuitBreakerReason = null;

function initGroqClient() {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  const baseURL = (process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim();

  if (!apiKey) {
    isGroqConfigured = false;
    groqClient = null;
    if (!initWarningLogged) {
      console.warn('⚠️ Groq provider: GROQ_API_KEY is not configured. Groq will be bypassed, falling back to secondary providers.');
      initWarningLogged = true;
    }
    return null;
  }

  if (!Groq) {
    isGroqConfigured = false;
    groqClient = null;
    if (!initWarningLogged) {
      console.warn('⚠️ Groq provider: groq-sdk package is not available.');
      initWarningLogged = true;
    }
    return null;
  }

  try {
    // groq-sdk automatically appends /openai/v1 to baseURL.
    // If baseURL has /openai/v1, strip it to prevent duplicate /openai/v1/openai/v1 404 paths
    const cleanBaseURL = baseURL ? baseURL.replace(/\/openai\/v1\/?$/i, '').trim() : undefined;

    groqClient = new Groq({
      apiKey,
      baseURL: cleanBaseURL || undefined
    });
    isGroqConfigured = true;
    return groqClient;
  } catch (err) {
    isGroqConfigured = false;
    groqClient = null;
    console.warn('⚠️ Groq provider initialization error:', err.message);
    return null;
  }
}

// Initial attempt at module load (safe, does not throw)
initGroqClient();

function isGroqAvailable() {
  if (!isGroqConfigured || !groqClient) {
    // Attempt re-init in case env was loaded later
    initGroqClient();
  }
  if (!isGroqConfigured || !groqClient) return false;

  const cb = getGroqCircuitBreakerState();
  return !cb.active;
}

function getGroqModel() {
  return process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
}

function getGroqCircuitBreakerState() {
  const now = Date.now();
  if (now < circuitBreakerUntil) {
    return {
      active: true,
      remainingMs: circuitBreakerUntil - now,
      reason: circuitBreakerReason
    };
  }
  return { active: false, remainingMs: 0, reason: null };
}

function tripGroqCircuitBreaker(durationMs, reason) {
  circuitBreakerUntil = Date.now() + Math.max(1000, durationMs);
  circuitBreakerReason = reason;
  console.warn(`⚡ Groq Circuit Breaker TRIPPED for ${Math.round(durationMs / 1000)}s: ${reason}`);
}

function resetGroqCircuitBreaker() {
  circuitBreakerUntil = 0;
  circuitBreakerReason = null;
}

/**
 * Resilient JSON argument parser that attempts recovery from unescaped strings,
 * missing braces, or model markdown wrappers.
 */
function safeParseJson(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;

  const trimmed = String(rawArgs).trim();
  try {
    return JSON.parse(trimmed);
  } catch (err1) {
    // Attempt recovery between first '{' and last '}'
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.substring(start, end + 1));
      } catch (_) {}
    }
    return {
      _parse_error: true,
      raw: rawArgs,
      error_message: err1.message
    };
  }
}

/**
 * Parse Groq / OpenAI API errors into structured classification.
 */
function parseGroqError(err) {
  const status = err.status || err.statusCode || (err.response ? err.response.status : null);
  const rawMsg = (err.message || '').toLowerCase();

  const isTimeout = err.name === 'AbortError' || rawMsg.includes('timeout') || rawMsg.includes('aborted');
  const isDailyQuotaExhausted = rawMsg.includes('daily limit') || rawMsg.includes('quota exceeded') || rawMsg.includes('per day');
  const isRateLimit = status === 429 || rawMsg.includes('429') || rawMsg.includes('rate limit');
  const isServerError = (status >= 500 && status < 600) || rawMsg.includes('500') || rawMsg.includes('502') || rawMsg.includes('503') || rawMsg.includes('504');
  const isAuthError = status === 401 || status === 403 || rawMsg.includes('unauthorized') || rawMsg.includes('invalid api key');

  let retryAfterSeconds = null;
  if (err.headers && typeof err.headers.get === 'function') {
    const ra = err.headers.get('retry-after');
    if (ra) retryAfterSeconds = parseFloat(ra);
  }

  return {
    status,
    isTimeout,
    isRateLimit,
    isDailyQuotaExhausted,
    isServerError,
    isAuthError,
    retryAfterSeconds,
    message: err.message
  };
}

/**
 * Execute chat completion call to Groq with:
 * - Strict timeout enforcement via AbortController
 * - parallel_tool_calls: false (GPT OSS 120B requirement)
 * - Circuit breaker check and update
 * - Latency and token usage tracking
 *
 * @param {Array} messages - OpenAI-style messages array
 * @param {Array} tools - OpenAI-style tools definitions
 * @param {object} options - { temperature, timeoutMs, externalSignal, model }
 */
async function callGroqChatCompletion(messages, tools, options = {}) {
  if (!isGroqAvailable()) {
    const cb = getGroqCircuitBreakerState();
    const reason = cb.active ? `Circuit breaker active (${cb.reason})` : 'Groq provider not configured';
    const err = new Error(reason);
    err.status = cb.active ? 429 : 503;
    err.groqUnavailable = true;
    throw err;
  }

  const model = options.model || getGroqModel();
  const temperature = options.temperature !== undefined ? options.temperature : 0.1;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Set up bounded timeout controller
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    controller.abort(new Error(`Groq request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  // Link optional external signal
  if (options.externalSignal) {
    options.externalSignal.addEventListener('abort', () => controller.abort());
  }

  const startTime = Date.now();

  try {
    const payload = {
      model,
      messages,
      temperature,
      parallel_tool_calls: false
    };

    if (tools && Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = options.tool_choice || 'auto';
    }

    const response = await groqClient.chat.completions.create(payload, {
      signal: controller.signal
    });

    clearTimeout(timeoutTimer);
    const latencyMs = Date.now() - startTime;

    const choice = response.choices && response.choices[0];
    if (!choice) {
      throw new Error('Groq returned empty choices in completion response');
    }

    return {
      success: true,
      message: choice.message,
      finish_reason: choice.finish_reason,
      usage: response.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      latencyMs,
      model: response.model || model
    };

  } catch (err) {
    clearTimeout(timeoutTimer);
    const latencyMs = Date.now() - startTime;
    const parsed = parseGroqError(err);
    parsed.latencyMs = latencyMs;
    if (err.error) {
      console.warn('⚠️ Groq API Error details:', JSON.stringify(err.error));
    }

    // Trip circuit breaker on daily quota or severe repeat errors
    if (parsed.isDailyQuotaExhausted) {
      tripGroqCircuitBreaker(3600 * 1000, 'Daily quota exhausted');
    } else if (parsed.isAuthError) {
      tripGroqCircuitBreaker(3600 * 1000, 'Authentication error: invalid GROQ_API_KEY');
    } else if (parsed.isRateLimit) {
      const waitMs = parsed.retryAfterSeconds ? parsed.retryAfterSeconds * 1000 : 30000;
      tripGroqCircuitBreaker(waitMs, 'Groq Rate Limit (429)');
    }

    throw err;
  }
}

module.exports = {
  isGroqAvailable,
  getGroqModel,
  initGroqClient,
  callGroqChatCompletion,
  safeParseJson,
  parseGroqError,
  getGroqCircuitBreakerState,
  tripGroqCircuitBreaker,
  resetGroqCircuitBreaker,
  DEFAULT_GROQ_MODEL
};
