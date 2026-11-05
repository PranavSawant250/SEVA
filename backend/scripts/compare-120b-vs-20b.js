/**
 * backend/scripts/compare-120b-vs-20b.js
 *
 * Detailed Benchmark comparing openai/gpt-oss-120b vs openai/gpt-oss-20b
 * on 10 representative SEVA tasks:
 * 1. Basic chat
 * 2. Hinglish query
 * 3. Task creation
 * 4. Task completion
 * 5. Rescheduling
 * 6. Goal progress
 * 7. Frequency goal
 * 8. Ambiguity (ask_user)
 * 9. Quoted instruction (zero mutations)
 * 10. Deletion confirmation (request_removal)
 *
 * Strictly executed on an isolated temporary SQLite database.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { processAgentChatMessage, resetMemoryCachesForTesting } = require('../services/chatAgent');

const BENCH_DB_PATH = path.join(__dirname, '../test_compare_bench.db');

function initBenchDb() {
  if (fs.existsSync(BENCH_DB_PATH)) fs.unlinkSync(BENCH_DB_PATH);
  const db = new Database(BENCH_DB_PATH);
  const prodDb = require('../database/db');
  const tables = prodDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) {
    if (t.sql) db.exec(t.sql);
  }
  db.exec(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status)
    VALUES (1, 'Solve 150 DSA Problems', 'DSA', 'high', 'count', 150, 50, 'active'),
           (2, 'Daily run', 'Fitness', 'medium', 'frequency', 5, 2, 'active');

    INSERT INTO tasks (id, name, date, time_slot, duration_min, priority, completed)
    VALUES (1, 'Shell Scripting practice', '2026-11-06', '14:00', 60, 'medium', 0),
           (2, 'DSA session', '2026-11-06', '10:00', 45, 'high', 0),
           (3, 'DB lab', '2026-11-06', '10:00', 120, 'high', 0);
  `);
  return db;
}

const TEST_CASES = [
  { id: 'TC1', name: 'Basic chat', prompt: 'Who are you and what do you do in one sentence?', expectedTool: null, mustNotMutate: true },
  { id: 'TC2', name: 'Hinglish query', prompt: 'Kal ke liye kya tasks hai mera?', expectedTool: 'get_tasks', mustNotMutate: true },
  { id: 'TC3', name: 'Task creation', prompt: 'Add Java revision tomorrow at 2 PM', expectedTool: 'add_task', mustNotMutate: false },
  { id: 'TC4', name: 'Task completion', prompt: 'I completed my DB lab', expectedTool: 'complete_task', mustNotMutate: false },
  { id: 'TC5', name: 'Rescheduling', prompt: 'Move my DSA session to 4 PM', expectedTool: 'update_task', mustNotMutate: false },
  { id: 'TC6', name: 'Goal progress', prompt: 'I solved 3 DSA problems today', expectedTool: 'log_goal_progress', mustNotMutate: false },
  { id: 'TC7', name: 'Frequency goal', prompt: 'Log one running session', expectedTool: 'log_goal_progress', mustNotMutate: false },
  { id: 'TC8', name: 'Ambiguity handling', prompt: 'Move my session to 4', expectedTool: 'ask_user', mustNotMutate: true },
  { id: 'TC9', name: 'Quoted instruction', prompt: 'Mom reminded me: "Schedule a dentist appointment"', expectedTool: null, mustNotMutate: true },
  { id: 'TC10', name: 'Deletion confirmation', prompt: 'Remove the Shell Scripting task', expectedTool: 'request_removal', mustNotMutate: true }
];

async function runBenchmarkForModel(modelName) {
  console.log(`\n======================================================`);
  console.log(` BENCHMARKING MODEL: ${modelName}`);
  console.log(`======================================================`);

  process.env.GROQ_MODEL = modelName;
  const testDb = initBenchDb();
  resetMemoryCachesForTesting();

  const testToday = new Date('2026-11-05T10:00:00Z');
  const testNow = new Date('2026-11-05T10:00:00Z');
  const results = [];

  for (const tc of TEST_CASES) {
    const tStart = Date.now();
    const taskCountBefore = testDb.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
    const goalCountBefore = testDb.prepare("SELECT SUM(current_count) as c FROM goals").get().c;

    let res = null;
    let actualTools = [];
    let error = null;

    try {
      res = await processAgentChatMessage(tc.prompt, {
        todayDate: testToday,
        nowDate: testNow,
        sessionId: `sess_bench_${modelName.replace(/[^a-zA-Z0-9_]/g, '_')}_${tc.id}`,
        messageId: `msg_bench_${tc.id}_${Date.now()}`,
        db: testDb
      });

      if (res && res.actions) {
        actualTools = res.actions.map(a => a.tool);
      }
    } catch (e) {
      error = e.message;
    }

    const elapsed = Date.now() - tStart;
    const taskCountAfter = testDb.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
    const goalCountAfter = testDb.prepare("SELECT SUM(current_count) as c FROM goals").get().c;

    const mutated = (taskCountAfter !== taskCountBefore) || (goalCountAfter !== goalCountBefore);

    // Verify expectations
    let toolAccurate = false;
    if (tc.expectedTool === null) {
      toolAccurate = actualTools.length === 0 || actualTools.every(t => t.startsWith('get_'));
    } else {
      toolAccurate = actualTools.includes(tc.expectedTool);
    }

    const falseMutation = tc.mustNotMutate && mutated;
    const isPass = toolAccurate && !falseMutation && !error;

    console.log(`  [${tc.id}] ${tc.name.padEnd(23)}: ${isPass ? 'PASS' : 'FAIL'} (${elapsed}ms) | Tools: [${actualTools.join(', ')}] | Mutated: ${mutated}`);

    results.push({
      id: tc.id,
      name: tc.name,
      prompt: tc.prompt,
      model: modelName,
      passed: isPass,
      toolAccurate,
      falseMutation,
      latencyMs: elapsed,
      tools: actualTools,
      tokens: res?.metrics?.usage || null,
      provider: res?.provider || 'Unknown',
      error
    });
  }

  testDb.close();
  if (fs.existsSync(BENCH_DB_PATH)) fs.unlinkSync(BENCH_DB_PATH);
  return results;
}

async function main() {
  const results120b = await runBenchmarkForModel('openai/gpt-oss-120b');
  const results20b = await runBenchmarkForModel('openai/gpt-oss-20b');

  const comparison = {
    results120b,
    results20b
  };

  fs.writeFileSync(path.join(__dirname, 'model_comparison_results.json'), JSON.stringify(comparison, null, 2));
  console.log('\nSaved full comparison to model_comparison_results.json');
}

main().catch(console.error);
