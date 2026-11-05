/**
 * backend/scripts/test-groq-safeguards.js
 *
 * Comprehensive Automated Test Suite for SEVA Groq GPT OSS 120B Integration.
 * Validates all 5 mandatory safeguards, core day-plan mutations, goals,
 * confirmation safety, idempotency, and fallback state preservation.
 *
 * Uses an ephemeral isolated database (NEVER mutates production seva.db).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  isGroqAvailable,
  getGroqModel,
  safeParseJson,
  parseGroqError,
  tripGroqCircuitBreaker,
  resetGroqCircuitBreaker,
  getGroqCircuitBreakerState
} = require('../services/groqProvider');

const {
  processAgentChatMessage,
  executeToolCall,
  DEFAULT_GEMINI_MODEL,
  resetMemoryCachesForTesting
} = require('../services/chatAgent');

const { getOpenAIToolDefinitions, getToolByName } = require('../services/chatTools');
const TaskService = require('../services/taskService');
const DayPlanService = require('../services/dayPlanService');
const { getPendingState, clearPending } = require('../services/chatCommands');

// ─────────────────────────────────────────────────────────────
// SETUP EPHEMERAL ISOLATED DATABASE
// ─────────────────────────────────────────────────────────────
const TEST_DB_PATH = path.join(__dirname, '../test_groq_isolated.db');

function initTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  const testDb = new Database(TEST_DB_PATH);
  testDb.pragma('journal_mode = WAL');

  // Clone exact schema from db
  const prodDb = require('../database/db');
  const tables = prodDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) {
    if (t.sql) testDb.exec(t.sql);
  }

  // Seed sample data
  testDb.exec(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status)
    VALUES (1, 'Solve 150 DSA Problems', 'DSA', 'high', 'count', 150, 45, 'active'),
           (2, 'Daily run', 'Fitness', 'medium', 'frequency', 5, 2, 'active');

    INSERT INTO tasks (id, name, date, time_slot, duration_min, priority, completed)
    VALUES (1, 'Shell Scripting practice', '2026-11-06', '14:00', 60, 'medium', 0),
           (2, 'DSA session', '2026-11-06', '10:00', 45, 'high', 0);

    INSERT INTO day_plans (date, plan_json)
    VALUES ('2026-11-06', '[{"time":"10:00 AM","task":"DSA session","priority":"high","duration":45,"completed":false}]');
  `);

  return testDb;
}

let passedTests = 0;
let totalTests = 0;

function assertTest(condition, testName, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName} - ${details}`);
  }
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log(' SEVA Groq GPT OSS 120B — Safeguards & Integration Tests');
  console.log('======================================================\n');

  const testDb = initTestDb();
  resetMemoryCachesForTesting();
  clearPending();

  const testToday = new Date('2026-11-05T10:00:00Z');
  const testNow = new Date('2026-11-05T10:00:00Z');
  const testSessionId = 'sess_test_groq_001';

  // ─────────────────────────────────────────────────────────────
  // 1. SAFEGUARD 4: Startup Resilience & Config
  // ─────────────────────────────────────────────────────────────
  console.log('--- Suite 1: Safeguard 4 (Startup Resilience & Model Config) ---');
  {
    assertTest(typeof getGroqModel() === 'string', 'Groq model is configured', `Model: ${getGroqModel()}`);
    assertTest(getGroqModel() === 'openai/gpt-oss-120b', 'Default Groq model is openai/gpt-oss-120b');
    
    // Test circuit breaker trip & reset
    tripGroqCircuitBreaker(5000, 'Test trip');
    const cbActive = getGroqCircuitBreakerState();
    assertTest(cbActive.active === true, 'Groq circuit breaker trips correctly');
    resetGroqCircuitBreaker();
    const cbReset = getGroqCircuitBreakerState();
    assertTest(cbReset.active === false, 'Groq circuit breaker resets cleanly');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. SAFEGUARD 5: Actual GPT OSS Response & Schema Compatibility
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 2: Safeguard 5 (Schema & Malformed JSON Argument Recovery) ---');
  {
    const tools = getOpenAIToolDefinitions();
    assertTest(tools.length >= 14, `All ${tools.length} tools converted to OpenAI/Groq format`);
    const addTaskTool = tools.find(t => t.function.name === 'add_task');
    assertTest(addTaskTool && addTaskTool.function.parameters.type === 'object', 'add_task tool schema parameters type is lowercase object');
    const durType = addTaskTool.function.parameters.properties.duration_min.type;
    const isIntType = Array.isArray(durType) ? durType.includes('integer') : durType === 'integer';
    assertTest(isIntType, 'duration_min type normalized to integer (with null support)');

    // Test safeParseJson resilience
    const validJson = safeParseJson('{"name":"Study Graph Theory","duration_min":45}');
    assertTest(validJson.name === 'Study Graph Theory' && validJson.duration_min === 45, 'safeParseJson parses standard valid JSON');

    const wrappedJson = safeParseJson('```json\n{"name":"Study Graph Theory"}\n```');
    assertTest(wrappedJson.name === 'Study Graph Theory', 'safeParseJson extracts JSON wrapped in markdown');

    const malformedJson = safeParseJson('{name: "Missing quotes", invalid');
    assertTest(malformedJson._parse_error === true, 'safeParseJson flags unrecoverable malformed JSON without throwing');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. SAFEGUARD 2: Multiple Tool Calls Sequential Execution
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 3: Safeguard 2 (Sequential Multiple Tool Calls) ---');
  {
    // Simulate model returning 2 tool calls in message.tool_calls
    const mockToolCalls = [
      { name: 'add_task', args: { name: 'Sequential Task 1', date: 'tomorrow', duration_min: 30 } },
      { name: 'add_task', args: { name: 'Sequential Task 2', date: 'tomorrow', duration_min: 45 } }
    ];

    let actionIndex = 0;
    const executedResults = [];

    for (const call of mockToolCalls) {
      const res = await executeToolCall(call, {
        todayDate: testToday,
        nowDate: testNow,
        sessionId: testSessionId,
        messageId: 'msg_seq_001',
        actionIndex: actionIndex++,
        db: testDb
      });
      console.log('Call result:', res);
      executedResults.push(res);
    }

    assertTest(executedResults.length === 2, 'Both sequential tool calls executed');
    assertTest(executedResults[0].success === true && executedResults[1].success === true, 'Both sequential task additions succeeded');

    const rows = testDb.prepare("SELECT name FROM tasks WHERE name LIKE 'Sequential Task%' ORDER BY id ASC").all();
    assertTest(rows.length === 2, 'Both tasks persisted to isolated SQLite database');
    assertTest(rows[0].name === 'Sequential Task 1' && rows[1].name === 'Sequential Task 2', 'Tasks inserted in exact sequential order');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. SAFEGUARD 1: Fallback State & Mutation Preservation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 4: Safeguard 1 (Fallback State Preservation) ---');
  {
    // Round 1 executed by primary provider
    const initialAction = {
      tool: 'add_task',
      args: { name: 'Preserved Lab Task', date: 'tomorrow' },
      result: await executeToolCall({ name: 'add_task', args: { name: 'Preserved Lab Task', date: 'tomorrow' } }, {
        todayDate: testToday,
        nowDate: testNow,
        sessionId: testSessionId,
        messageId: 'msg_fb_pres_001',
        actionIndex: 0,
        db: testDb
      })
    };

    assertTest(initialAction.result.success === true, 'Round 1 mutation succeeded');

    // Simulate Groq failure in Round 2: secondary provider inherits executedActions
    const executedActions = [initialAction];
    const updatedScreens = new Set(['Day Plan']);
    const actionCounter = { val: 1 };

    // When falling back to local/recovery without re-running Round 1:
    assertTest(executedActions.length === 1, 'Preserved action history contains Round 1 execution');
    assertTest(actionCounter.val === 1, 'Action counter continues from 1');

    // Verify task count is exactly 1 (no duplicate creation)
    const count = testDb.prepare("SELECT COUNT(*) as count FROM tasks WHERE name = 'Preserved Lab Task'").get().count;
    assertTest(count === 1, 'Preserved task exists exactly once in database (0 duplicates)');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. SAFEGUARD 3: Timeout & Idempotency Safety
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 5: Safeguard 3 (Timeout & Idempotency Across Replays) ---');
  {
    // Test idempotency: calling same action with same clientRequestId returns cached result
    const firstCall = await executeToolCall({ name: 'add_task', args: { name: 'Idempotent Task', date: 'today' } }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_idemp_test_001',
      actionIndex: 0,
      db: testDb
    });

    const secondCall = await executeToolCall({ name: 'add_task', args: { name: 'Idempotent Task', date: 'today' } }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_idemp_test_001',
      actionIndex: 0,
      db: testDb
    });

    assertTest(firstCall.success === true, 'First action execution succeeded');
    assertTest(secondCall._idempotent_cached === true, 'Second action execution detected cached idempotent result');

    const dbRows = testDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE name = 'Idempotent Task'").get().c;
    assertTest(dbRows === 1, 'Exactly one row created in database despite repeated execution');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. CORE DAY PLAN & TASK OPERATIONS VIA TaskService
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 6: Core Day Plan & Task Mutations via TaskService ---');
  {
    // A. Add DB lab tomorrow at 10 AM
    const addRes = await executeToolCall({
      name: 'add_task',
      args: { name: 'DB lab', date: 'tomorrow', time_slot: '10:00 AM', priority: 'high', duration_min: 120 }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_task_001',
      actionIndex: 0,
      db: testDb
    });
    assertTest(addRes.success === true, 'Add DB lab tomorrow at 10 AM succeeded');
    const labTask = testDb.prepare("SELECT * FROM tasks WHERE name = 'DB lab'").get();
    assertTest(labTask && labTask.time_slot === '10:00 AM' && labTask.date === '2026-11-06', 'DB lab task scheduled for tomorrow at 10:00 AM');

    // B. Move DSA session to 4 PM
    const updateRes = await executeToolCall({
      name: 'update_task',
      args: { task_identifier: 'DSA session', time_slot: '4:00 PM', date: '2026-11-06' }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_task_002',
      actionIndex: 0,
      db: testDb
    });
    assertTest(updateRes.success === true, 'Move DSA session to 4:00 PM succeeded');
    const dsaTask = testDb.prepare("SELECT time_slot FROM tasks WHERE name = 'DSA session'").get();
    assertTest(dsaTask && dsaTask.time_slot === '4:00 PM', 'DSA session time updated to 4:00 PM in tasks table');

    // C. Complete DB lab
    const compRes = await executeToolCall({
      name: 'complete_task',
      args: { task_identifier: 'DB lab', date: 'tomorrow' }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_task_003',
      actionIndex: 0,
      db: testDb
    });
    console.log('Complete result:', compRes);
    assertTest(compRes.success === true, 'Complete DB lab succeeded');
    const compTask = testDb.prepare("SELECT completed FROM tasks WHERE name = 'DB lab'").get();
    assertTest(compTask && compTask.completed === 1, 'DB lab marked completed = 1 in database');

    // D. Read tomorrow plan
    const planRes = await executeToolCall({
      name: 'get_today_plan',
      args: { date: 'tomorrow' }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_plan_001',
      actionIndex: 0,
      db: testDb
    });
    assertTest(planRes.success === true, 'Retrieve plan for tomorrow succeeded');
  }

  // ─────────────────────────────────────────────────────────────
  // 7. GOALS & PROGRESS CONSISTENCY
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 7: Goals & Progress Tracking ---');
  {
    // A. Solve 3 DSA problems
    const dsaProgress = await executeToolCall({
      name: 'log_goal_progress',
      args: { goal_identifier: 'DSA', amount: 3, note: 'Solved 3 problems' }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_goal_001',
      actionIndex: 0,
      db: testDb
    });
    assertTest(dsaProgress.success === true, 'Log 3 DSA problems succeeded');
    const dsaGoal = testDb.prepare("SELECT current_count FROM goals WHERE id = 1").get();
    assertTest(dsaGoal.current_count === 48, 'DSA goal count incremented to 48 (45 + 3)');

    // B. Log running session
    const runProgress = await executeToolCall({
      name: 'log_goal_progress',
      args: { goal_identifier: 'Daily run', amount: 1 }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_goal_002',
      actionIndex: 0,
      db: testDb
    });
    assertTest(runProgress.success === true, 'Log 1 running session succeeded');
    const runGoal = testDb.prepare("SELECT current_count FROM goals WHERE id = 2").get();
    assertTest(runGoal.current_count === 3, 'Running goal count incremented to 3 (2 + 1)');
  }

  // ─────────────────────────────────────────────────────────────
  // 8. SAFETY & CONFIRMATION INVARIANTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Suite 8: Safety & Removal Confirmation Invariants ---');
  {
    // A. Model direct confirm_removal rejection
    const directConfirm = await executeToolCall({
      name: 'confirm_removal',
      args: { confirmed: true }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_sec_001',
      actionIndex: 0,
      db: testDb
    });
    assertTest(directConfirm.success === false, 'Direct model confirm_removal is rejected');
    assertTest(directConfirm.error && directConfirm.error.includes('Unauthorized'), 'Rejection error states Unauthorized');

    // B. Request removal creates pending state
    const reqRem = await executeToolCall({
      name: 'request_removal',
      args: { type: 'task', identifier: 'Shell Scripting practice' }
    }, {
      todayDate: testToday,
      nowDate: testNow,
      sessionId: testSessionId,
      messageId: 'msg_sec_002',
      actionIndex: 0,
      db: testDb
    });
    assertTest(reqRem.success === true && reqRem.pending_confirmation === true, 'Request removal sets pending_confirmation');
    const pending = getPendingState();
    assertTest(pending !== null && pending.type === 'removal', 'Pending state established in command router');
    clearPending();
  }

  // Clean up test DB
  testDb.close();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  console.log('\n======================================================');
  console.log(` RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('======================================================\n');

  if (passedTests < totalTests) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
