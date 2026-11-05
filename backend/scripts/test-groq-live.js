/**
 * backend/scripts/test-groq-live.js
 *
 * Live API Test Runner for Groq openai/gpt-oss-120b.
 * Tests live chat completions, tool execution with real Groq responses,
 * Hinglish comprehension, latency, and token metrics.
 *
 * Uses an isolated database (NEVER touches production seva.db).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { processAgentChatMessage, resetMemoryCachesForTesting } = require('../services/chatAgent');
const { getGroqModel, isGroqAvailable } = require('../services/groqProvider');

const LIVE_TEST_DB_PATH = path.join(__dirname, '../test_groq_live.db');

function setupLiveTestDb() {
  if (fs.existsSync(LIVE_TEST_DB_PATH)) {
    fs.unlinkSync(LIVE_TEST_DB_PATH);
  }

  const testDb = new Database(LIVE_TEST_DB_PATH);
  testDb.pragma('journal_mode = WAL');

  const prodDb = require('../database/db');
  const tables = prodDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) {
    if (t.sql) testDb.exec(t.sql);
  }

  // Seed sample active goals and tasks
  testDb.exec(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status)
    VALUES (1, 'Solve 150 DSA Problems', 'DSA', 'high', 'count', 150, 50, 'active'),
           (2, 'Daily run', 'Fitness', 'medium', 'frequency', 5, 2, 'active');

    INSERT INTO tasks (id, name, date, time_slot, duration_min, priority, completed)
    VALUES (1, 'Shell Scripting practice', '2026-11-06', '14:00', 60, 'medium', 0);
  `);

  return testDb;
}

async function runLiveTests() {
  console.log('\n======================================================');
  console.log(` SEVA Groq Live API Verification (${getGroqModel()})`);
  console.log('======================================================\n');

  if (!isGroqAvailable()) {
    console.warn('⚠️ Groq is not configured or circuit breaker active.');
    process.exit(1);
  }

  const testDb = setupLiveTestDb();
  resetMemoryCachesForTesting();

  const testToday = new Date('2026-11-05T10:00:00Z');
  const testNow = new Date('2026-11-05T10:00:00Z');
  const sessionId = 'sess_live_groq_test_101';

  const testCases = [
    {
      name: '1. Basic Conversation (English)',
      prompt: 'Who are you and what do you do in one sentence?'
    },
    {
      name: '2. Hinglish Conversational Query',
      prompt: 'Kal ke liye kya tasks hai mera?'
    },
    {
      name: '3. Day Plan Task Creation',
      prompt: 'Add DB lab tomorrow at 10 AM'
    },
    {
      name: '4. Goal Progress Logging',
      prompt: 'I solved 3 DSA problems today'
    },
    {
      name: '5. Plan Query',
      prompt: 'What is scheduled for tomorrow?'
    }
  ];

  const metrics = [];

  for (const tc of testCases) {
    console.log(`\n▶ Running: ${tc.name}`);
    console.log(`  Prompt: "${tc.prompt}"`);

    const start = Date.now();
    try {
      const res = await processAgentChatMessage(tc.prompt, {
        todayDate: testToday,
        nowDate: testNow,
        sessionId,
        messageId: `live_msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        db: testDb
      });

      const elapsed = Date.now() - start;
      console.log(`  Reply [${res.badge}]: "${res.reply}"`);
      console.log(`  Provider: ${res.provider}`);
      console.log(`  Actions executed: ${res.actions ? res.actions.length : 0}`);
      if (res.actions && res.actions.length > 0) {
        res.actions.forEach(a => console.log(`    - Tool: ${a.tool}, Args: ${JSON.stringify(a.args)}`));
      }
      if (res.metrics) {
        console.log(`  Latency: ${res.metrics.latencyMs}ms | Tokens: prompt=${res.metrics.usage.prompt_tokens}, completion=${res.metrics.usage.completion_tokens}, total=${res.metrics.usage.total_tokens}`);
      }

      metrics.push({
        name: tc.name,
        success: res.success,
        provider: res.provider,
        badge: res.badge,
        latencyMs: elapsed,
        actionsCount: res.actions ? res.actions.length : 0,
        tokens: res.metrics?.usage || null
      });

    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      metrics.push({
        name: tc.name,
        success: false,
        error: err.message
      });
    }
  }

  // Verify created task in database
  const createdLabTask = testDb.prepare("SELECT * FROM tasks WHERE name LIKE '%DB lab%'").get();
  console.log('\n--- Database State Verification ---');
  if (createdLabTask) {
    console.log(`  ✅ DB lab task verified in isolated DB: ID=${createdLabTask.id}, Date=${createdLabTask.date}, Time=${createdLabTask.time_slot}`);
  } else {
    console.log('  ⚠️ DB lab task not found in database');
  }

  const dsaGoal = testDb.prepare("SELECT current_count FROM goals WHERE id = 1").get();
  console.log(`  ✅ DSA goal progress: current_count=${dsaGoal.current_count}`);

  testDb.close();
  if (fs.existsSync(LIVE_TEST_DB_PATH)) {
    fs.unlinkSync(LIVE_TEST_DB_PATH);
  }

  console.log('\n======================================================');
  console.log(' LIVE TEST METRICS SUMMARY');
  console.log('======================================================');
  console.table(metrics.map(m => ({
    Test: m.name,
    Success: m.success,
    Provider: m.provider,
    Latency: `${m.latencyMs}ms`,
    Actions: m.actionsCount,
    Tokens: m.tokens ? `${m.tokens.total_tokens} (prompt: ${m.tokens.prompt_tokens}, comp: ${m.tokens.completion_tokens})` : 'N/A'
  })));
}

runLiveTests().catch(err => {
  console.error('Fatal live test error:', err);
  process.exit(1);
});

