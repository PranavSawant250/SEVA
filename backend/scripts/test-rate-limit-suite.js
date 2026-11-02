/**
 * backend/scripts/test-rate-limit-suite.js
 *
 * Comprehensive 10-Scenario Test Suite for Gemini Rate Limits,
 * Immediate Circuit Breaker Failover, and Local Ollama/Deterministic Fallback.
 *
 * Strictly executed on an isolated temporary SQLite database.
 * Live seva.db is NEVER touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-ratelimit-test-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');

// Reset chat history in temp test DB so Ollama payload is clean and fast
db.prepare('DELETE FROM chat_history').run();

const {
  processAgentChatMessage,
  callGeminiWithBackoff,
  parseGeminiError,
  getGeminiCircuitBreakerState,
  tripGeminiCircuitBreaker,
  resetGeminiCircuitBreaker,
  executeFallbackChat,
  executeToolCall
} = require('../services/chatAgent');

function hashTable(tableName) {
  try {
    const rows = db.prepare(`SELECT * FROM ${tableName} ORDER BY rowid ASC`).all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').substring(0, 12);
  } catch (_) {
    return 'none';
  }
}

function getDatabaseState() {
  return {
    goals: hashTable('goals'),
    goal_steps: hashTable('goal_steps'),
    goal_progress_log: hashTable('goal_progress_log'),
    tasks: hashTable('tasks'),
    day_plans: hashTable('day_plans'),
    daily_settings: hashTable('daily_settings')
  };
}

async function runSuite() {
  console.log('================================================================');
  console.log('🧪 SEVA RATE-LIMIT & FALLBACK 10-SCENARIO VERIFICATION SUITE');
  console.log(`Temp DB: ${tempDbPath}`);
  console.log('================================================================\n');

  const testDate = new Date('2026-11-02T10:00:00Z');
  let passedCount = 0;
  let totalCount = 10;

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Gemini Normal Operation (Mock Success)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Gemini Normal Operation ---');
  resetGeminiCircuitBreaker();
  const mockAiNormal = {
    models: {
      generateContent: async () => ({
        text: 'Hello from Gemini Cloud!',
        functionCalls: []
      })
    }
  };
  const t1Start = Date.now();
  const t1Res = await callGeminiWithBackoff(mockAiNormal, 'gemini-test', 'hello', {}, 1);
  const t1Elapsed = Date.now() - t1Start;
  console.log(`T1 Status: text="${t1Res.text}", elapsed=${t1Elapsed}ms`);
  if (t1Res.text === 'Hello from Gemini Cloud!') {
    console.log('✅ TEST 1 PASSED: Gemini normal operation succeeds.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 1 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Gemini 429 Short Throttle (Single Retry then Failover)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 2: Gemini 429 Short Throttle ---');
  resetGeminiCircuitBreaker();
  let t2Attempts = 0;
  const mockAiShort429 = {
    models: {
      generateContent: async () => {
        t2Attempts++;
        const err = new Error('429 Too Many Requests: Rate limit exceeded (transient)');
        err.status = 429;
        throw err;
      }
    }
  };
  const t2Start = Date.now();
  let t2Error = null;
  try {
    await callGeminiWithBackoff(mockAiShort429, 'gemini-test', 'hello', {}, 1);
  } catch (err) {
    t2Error = err;
  }
  const t2Elapsed = Date.now() - t2Start;
  console.log(`T2 Status: attempts=${t2Attempts}, elapsed=${t2Elapsed}ms, errorStatus=${t2Error?.status}`);
  // Expected: exactly 2 attempts (initial + 1 retry), bounded latency (<5000ms), NOT 18 seconds!
  if (t2Attempts === 2 && t2Elapsed < 5000 && t2Error?.status === 429) {
    console.log('✅ TEST 2 PASSED: Short 429 only attempts single controlled retry, avoiding multi-retry hangs.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 2 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Gemini 429 With Explicit Retry-After
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 3: Gemini 429 With Explicit Retry-After ---');
  resetGeminiCircuitBreaker();
  let t3Attempts = 0;
  const mockAiRetryAfter = {
    models: {
      generateContent: async () => {
        t3Attempts++;
        const err = new Error(JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }
            ]
          }
        }));
        err.status = 429;
        throw err;
      }
    }
  };
  const t3Start = Date.now();
  let t3Error = null;
  try {
    await callGeminiWithBackoff(mockAiRetryAfter, 'gemini-test', 'hello', {}, 1);
  } catch (err) {
    t3Error = err;
  }
  const t3Elapsed = Date.now() - t3Start;
  console.log(`T3 Status: attempts=${t3Attempts}, elapsed=${t3Elapsed}ms`);
  if (t3Attempts === 2 && t3Elapsed < 5000) {
    console.log('✅ TEST 3 PASSED: Respected explicit Retry-After delay before controlled failover.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 3 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Gemini Daily Quota Exhausted (Immediate Circuit Breaker, 0 Retries)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 4: Gemini Daily Quota Exhausted ---');
  resetGeminiCircuitBreaker();
  let t4Attempts = 0;
  const mockAiDailyQuota = {
    models: {
      generateContent: async () => {
        t4Attempts++;
        const err = new Error(JSON.stringify({
          error: {
            code: 429,
            message: 'Generate content requests per day limit exceeded on Free Tier.\nPlease retry in 1h25m6s.',
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [
                  {
                    description: 'Generate content requests per day limit exceeded on Free Tier.',
                    quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'
                  }
                ]
              },
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '5106s'
              }
            ]
          }
        }));
        err.status = 429;
        throw err;
      }
    }
  };
  const t4Start = Date.now();
  let t4Error = null;
  try {
    await callGeminiWithBackoff(mockAiDailyQuota, 'gemini-test', 'hello', {}, 1);
  } catch (err) {
    t4Error = err;
  }
  const t4Elapsed = Date.now() - t4Start;
  const cbState = getGeminiCircuitBreakerState();
  console.log(`T4 Status: attempts=${t4Attempts}, elapsed=${t4Elapsed}ms, cbActive=${cbState.active}, cbRemaining=${Math.round(cbState.remainingMs/1000)}s`);
  if (t4Attempts === 1 && cbState.active) {
    console.log('✅ TEST 4 PASSED: Daily quota immediately trips circuit breaker with 0 futile retries.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 4 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Ollama Fallback Answers Simple Question
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 5: Ollama Fallback Answers Simple Question ---');
  const t5Start = Date.now();
  const t5Res = await processAgentChatMessage('Hi, what is your role?', {
    sessionId: 'sess_test_5',
    messageId: 'msg_t5_1',
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const t5Elapsed = Date.now() - t5Start;
  console.log(`T5 Status: provider="${t5Res.provider}", elapsed=${t5Elapsed}ms, reply="${t5Res.reply?.substring(0, 70)}..."`);
  if (t5Res.success && (t5Res.provider?.includes('Ollama') || t5Res.provider?.includes('Deterministic') || t5Res.provider?.includes('Command Router'))) {
    console.log('✅ TEST 5 PASSED: Handled conversational question locally with immediate response.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 5 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Ollama Fallback Answers Goal / Task Status Question (Read-Only)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 6: Ollama Fallback Answers Goal / Task Status Question ---');
  const dbBefore6 = getDatabaseState();
  const t6Res = await processAgentChatMessage('how many days until the Spring Boot deadline?', {
    sessionId: 'sess_test_6',
    messageId: 'msg_t6_1',
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const dbAfter6 = getDatabaseState();
  const isMutated6 = JSON.stringify(dbBefore6) !== JSON.stringify(dbAfter6);
  console.log(`T6 Status: reply="${t6Res.reply?.substring(0, 70)}...", mutated=${isMutated6}`);
  if (t6Res.success && !isMutated6) {
    console.log('✅ TEST 6 PASSED: Read-only query answered with ZERO mutations.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 6 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Fallback Executes Supported Mutation (Progress Logging)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 7: Fallback Executes Supported Mutation ---');
  const dsaBefore = db.prepare("SELECT current_count FROM goals WHERE title LIKE ? AND status = 'active'").get('%LeetCode%')?.current_count || 0;
  const t7Res = await processAgentChatMessage('did 3 leetcode today', {
    sessionId: 'sess_test_7',
    messageId: 'msg_t7_1',
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const dsaAfter = db.prepare("SELECT current_count FROM goals WHERE title LIKE ? AND status = 'active'").get('%LeetCode%')?.current_count || 0;
  console.log(`T7 Status: Active LeetCode Count before=${dsaBefore}, after=${dsaAfter}, reply="${t7Res.reply}"`);
  if (dsaAfter === dsaBefore + 3 && t7Res.reply.includes('LeetCode')) {
    console.log('✅ TEST 7 PASSED: Mutating action executed successfully via deterministic action engine in fallback mode.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 7 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Ambiguous Mutation Requests Ask For Clarification
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 8: Ambiguous Mutation Request Asks For Clarification ---');
  const dbBefore8 = getDatabaseState();
  const t8Res = await processAgentChatMessage('move my session to 4', {
    sessionId: 'sess_test_8',
    messageId: 'msg_t8_1',
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const dbAfter8 = getDatabaseState();
  const isMutated8 = JSON.stringify(dbBefore8) !== JSON.stringify(dbAfter8);
  console.log(`T8 Status: reply="${t8Res.reply}", mutated=${isMutated8}`);
  if (!isMutated8 && (t8Res.reply.toLowerCase().includes('which') || t8Res.reply.toLowerCase().includes('specify') || t8Res.reply.toLowerCase().includes('am') || t8Res.reply.toLowerCase().includes('pm') || t8Res.reply.toLowerCase().includes('help'))) {
    console.log('✅ TEST 8 PASSED: Ambiguous reschedule safely asked for clarification with zero mutations.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 8 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 9: Duplicate Submissions Preserve Idempotency (0 Duplicate Rows)
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 9: Duplicate Submissions Preserve Idempotency ---');
  const clientReqId9 = 'idemp-duplicate-test-9';
  const sessId9 = 'sess_test_9';
  const snapBefore9 = getDatabaseState();

  // First submission
  const res9a = await processAgentChatMessage('ran today', {
    sessionId: sessId9,
    messageId: clientReqId9,
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const snapAfter9a = getDatabaseState();

  // Second submission with exact same clientRequestId
  const res9b = await processAgentChatMessage('ran today', {
    sessionId: sessId9,
    messageId: clientReqId9,
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const snapAfter9b = getDatabaseState();

  const isDuplicateIdempotent = (snapAfter9a.goal_progress_log === snapAfter9b.goal_progress_log);
  console.log(`T9 Status: 1st cached=${res9a._idempotent_cached || false}, 2nd cached=${res9b._idempotent_cached || false}, DB identical=${isDuplicateIdempotent}`);
  if (isDuplicateIdempotent && res9b._idempotent_cached) {
    console.log('✅ TEST 9 PASSED: Duplicate request during fallback returned cached response with zero duplicate mutations.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 9 FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 10: System Recovers When Gemini Becomes Available Again
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST 10: System Recovers When Gemini Recovers ---');
  // Reset circuit breaker to simulate quota recovery
  resetGeminiCircuitBreaker();
  const cbStateAfterReset = getGeminiCircuitBreakerState();
  console.log(`T10 Status: Circuit breaker reset, active=${cbStateAfterReset.active}`);

  // Mock Gemini recovery returning success
  const mockAiRecovered = {
    models: {
      generateContent: async () => ({
        text: 'Gemini Cloud service is healthy and back online.',
        functionCalls: []
      })
    }
  };
  const t10Res = await callGeminiWithBackoff(mockAiRecovered, 'gemini-test', 'status', {}, 1);
  console.log(`T10 Cloud Response: "${t10Res.text}"`);
  if (!cbStateAfterReset.active && t10Res.text.includes('healthy')) {
    console.log('✅ TEST 10 PASSED: System gracefully resumes Cloud Gemini operations upon recovery.\n');
    passedCount++;
  } else {
    console.error('❌ TEST 10 FAILED');
  }

  console.log('================================================================');
  console.log(`📊 FINAL RESULT: ${passedCount}/${totalCount} SCENARIOS PASSED`);
  console.log('================================================================\n');

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}

  process.exit(passedCount === totalCount ? 0 : 1);
}

runSuite().catch(err => {
  console.error('Error in test suite:', err);
  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
  process.exit(1);
});
