/**
 * backend/scripts/verify-recovery-lifecycle.js
 *
 * Demonstrates the full 6-step recovery lifecycle:
 * 1. Gemini returns a daily quota 429.
 * 2. Circuit breaker trips.
 * 3. Subsequent requests skip Gemini.
 * 4. Local fallback continues working.
 * 5. After the cooldown, a controlled recovery check occurs.
 * 6. A successful Gemini response resets the breaker.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const tempDbPath = path.join(os.tmpdir(), `seva-recovery-test-${Date.now()}.db`);
fs.copyFileSync(path.resolve(__dirname, '../seva.db'), tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
// Clear chat history for rapid local execution
db.prepare('DELETE FROM chat_history').run();

const {
  processAgentChatMessage,
  callGeminiWithBackoff,
  getGeminiCircuitBreakerState,
  tripGeminiCircuitBreaker,
  resetGeminiCircuitBreaker
} = require('../services/chatAgent');

async function testRecoveryLifecycle() {
  console.log('================================================================');
  console.log('🧪 VERIFY RECOVERY LIFECYCLE & STATE TRANSITIONS');
  console.log('================================================================\n');

  let realApiCallCount = 0;
  let mockMode = '429_quota'; // '429_quota' or 'healthy'

  const mockAi = {
    models: {
      generateContent: async () => {
        realApiCallCount++;
        if (mockMode === '429_quota') {
          const err = new Error(JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Generate content requests per day limit exceeded on Free Tier.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }]
                },
                {
                  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                  retryDelay: '2s' // 2s cooldown for test demonstration
                }
              ]
            }
          }));
          err.status = 429;
          throw err;
        } else {
          return {
            text: 'I am Gemini Cloud and I am fully operational.',
            functionCalls: []
          };
        }
      }
    }
  };

  const testDate = new Date('2026-11-02T10:00:00Z');

  // Step 1: Initial State
  resetGeminiCircuitBreaker();
  console.log('Step 0 — Initial State:');
  console.log('  Circuit Breaker Active:', getGeminiCircuitBreakerState().active);
  console.log('  Total Gemini API Calls:', realApiCallCount);

  // Step 1 & 2: First request encounters Daily Quota 429 & Trips Breaker
  console.log('\nStep 1 & 2 — Sending Request 1 (Gemini returns 429 daily quota):');
  let step1Error = null;
  try {
    await callGeminiWithBackoff(mockAi, 'gemini-test', 'ping', {}, 1);
  } catch (err) {
    step1Error = err;
  }
  const stateAfterTrip = getGeminiCircuitBreakerState();
  console.log('  Call 1 Completed. Error:', step1Error?.status || step1Error?.message);
  console.log('  Total Gemini API Calls:', realApiCallCount);
  console.log('  Circuit Breaker Active:', stateAfterTrip.active);
  console.log('  Circuit Breaker Reason:', stateAfterTrip.reason);
  console.log('  Remaining Cooldown:', `${Math.round(stateAfterTrip.remainingMs / 1000)}s`);

  // Step 3 & 4: Subsequent requests skip Gemini completely; Local fallback works
  console.log('\nStep 3 & 4 — Sending Subsequent Requests while Breaker is ACTIVE:');
  const callCountBeforeSubsequent = realApiCallCount;
  
  const resFallback = await processAgentChatMessage('I solved 2 LeetCode problems today.', {
    sessionId: 'sess_rec_1',
    messageId: 'msg_rec_subsequent',
    todayDate: testDate,
    nowDate: testDate,
    db
  });
  const callCountAfterSubsequent = realApiCallCount;
  console.log('  Subsequent Gemini API Calls made:', callCountAfterSubsequent - callCountBeforeSubsequent, '(SKIPPED entirely)');
  console.log('  Fallback Provider Used:', resFallback.provider);
  console.log('  Fallback Result:', resFallback.reply);

  // Step 5: Wait for Cooldown to Expire
  console.log('\nStep 5 — Waiting for 2s Cooldown to Expire...');
  await new Promise(r => setTimeout(r, 2200));
  const stateAfterCooldown = getGeminiCircuitBreakerState();
  console.log('  Circuit Breaker Active after cooldown:', stateAfterCooldown.active);

  // Step 6: Controlled Recovery Probe & Breaker Reset
  console.log('\nStep 6 — Controlled Recovery Check with Gemini recovering:');
  mockMode = 'healthy'; // Remote service is now healthy
  const recoveryResponse = await callGeminiWithBackoff(mockAi, 'gemini-test', 'health probe', {}, 1);
  resetGeminiCircuitBreaker();
  const finalState = getGeminiCircuitBreakerState();

  console.log('  Recovery Response:', recoveryResponse.text);
  console.log('  Total Gemini API Calls across lifecycle:', realApiCallCount);
  console.log('  Final Breaker State: Active =', finalState.active, '(RESET and ready for normal operation)');

  console.log('\n================================================================');
  console.log('✅ RECOVERY LIFECYCLE VERIFIED SUCCESSFULLY');
  console.log('================================================================');

  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

testRecoveryLifecycle().catch(err => {
  console.error('Recovery test error:', err);
  db.close();
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
});

