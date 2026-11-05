/**
 * backend/scripts/diagnose-groq-latency.js
 *
 * Granular Stage-by-Stage Latency Instrumentation for Groq GPT OSS 120B & 20B.
 * Measures:
 * 1. Context retrieval & setup
 * 2. Groq Round 1 inference & network
 * 3. Backend tool execution
 * 4. Groq Round 2 inference & network (if applicable)
 * 5. Total response assembly
 * 6. Detailed token breakdown (prompt, completion, reasoning)
 */

const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { callGroqChatCompletion, safeParseJson, getGroqModel } = require('../services/groqProvider');
const { getOpenAIToolDefinitions } = require('../services/chatTools');
const { executeToolCall, buildSystemPrompt } = require('../services/chatAgent');

const TEST_DB_PATH = path.join(__dirname, '../test_latency_isolated.db');

function initDb() {
  const fs = require('fs');
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
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
    VALUES (1, 'Shell Scripting practice', '2026-11-06', '14:00', 60, 'medium', 0);
  `);
  return db;
}

async function benchmarkPrompt(prompt, model = 'openai/gpt-oss-120b', testDb) {
  const timing = {
    model,
    prompt,
    t_start: Date.now(),
    t_context: 0,
    t_groq_r1: 0,
    t_backend_tool: 0,
    t_groq_r2: 0,
    t_total: 0,
    rounds: 0,
    actions: [],
    tokens: { prompt: 0, completion: 0, total: 0 },
    reasoningSnippets: []
  };

  const t0 = Date.now();
  // 1. Context setup
  const systemInstruction = buildSystemPrompt('2026-11-05', '10:00 AM', 'Asia/Kolkata');
  const tools = getOpenAIToolDefinitions();
  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: prompt }
  ];
  timing.t_context = Date.now() - t0;

  // 2. Groq Round 1
  const t_r1_start = Date.now();
  const resp1 = await callGroqChatCompletion(messages, tools, { model, temperature: 0.1 });
  timing.t_groq_r1 = Date.now() - t_r1_start;
  timing.rounds = 1;

  if (resp1.usage) {
    timing.tokens.prompt += resp1.usage.prompt_tokens || 0;
    timing.tokens.completion += resp1.usage.completion_tokens || 0;
    timing.tokens.total += resp1.usage.total_tokens || 0;
  }

  const msg1 = resp1.message;
  if (msg1.reasoning) {
    timing.reasoningSnippets.push(`R1: ${msg1.reasoning.substring(0, 100)}...`);
  }

  const toolCalls = msg1.tool_calls || [];
  if (toolCalls.length > 0) {
    messages.push(msg1);

    // 3. Backend Tool Execution
    const t_tool_start = Date.now();
    for (const call of toolCalls) {
      const toolName = call.function.name;
      const args = safeParseJson(call.function.arguments);
      const res = await executeToolCall({ name: toolName, args }, {
        todayDate: new Date('2026-11-05T10:00:00Z'),
        nowDate: new Date('2026-11-05T10:00:00Z'),
        sessionId: 'sess_bench',
        messageId: `msg_${Date.now()}`,
        actionIndex: timing.actions.length,
        db: testDb
      });
      timing.actions.push({ tool: toolName, args, res });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(res)
      });
    }
    timing.t_backend_tool = Date.now() - t_tool_start;

    // 4. Groq Round 2 (if model needs to summarize)
    const t_r2_start = Date.now();
    const resp2 = await callGroqChatCompletion(messages, tools, { model, temperature: 0.1 });
    timing.t_groq_r2 = Date.now() - t_r2_start;
    timing.rounds = 2;

    if (resp2.usage) {
      timing.tokens.prompt += resp2.usage.prompt_tokens || 0;
      timing.tokens.completion += resp2.usage.completion_tokens || 0;
      timing.tokens.total += resp2.usage.total_tokens || 0;
    }
    if (resp2.message.reasoning) {
      timing.reasoningSnippets.push(`R2: ${resp2.message.reasoning.substring(0, 100)}...`);
    }
    timing.reply = resp2.message.content;
  } else {
    timing.reply = msg1.content;
  }

  timing.t_total = Date.now() - timing.t_start;
  return timing;
}

async function run() {
  const testDb = initDb();
  const testPrompts = [
    { type: 'chat', prompt: 'Who are you and what do you do in one sentence?' },
    { type: 'hinglish', prompt: 'Kal ke liye kya tasks hai mera?' },
    { type: 'task', prompt: 'Add DB lab tomorrow at 10 AM' },
    { type: 'goal', prompt: 'I solved 3 DSA problems today' },
    { type: 'plan', prompt: 'What is scheduled for tomorrow?' }
  ];

  console.log('\n=============================================================');
  console.log(' BENCHMARK: Stage-by-Stage Latency Breakdown (120B vs 20B)');
  console.log('=============================================================\n');

  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  const allResults = [];

  for (const model of models) {
    console.log(`\n>>> Testing Model: ${model} <<<`);
    for (const tp of testPrompts) {
      process.stdout.write(`  Running: "${tp.prompt.substring(0, 35)}..." `);
      try {
        const res = await benchmarkPrompt(tp.prompt, model, testDb);
        allResults.push({ ...res, category: tp.type });
        console.log(`-> Total: ${res.t_total}ms (Groq R1: ${res.t_groq_r1}ms, Tool: ${res.t_backend_tool}ms, Groq R2: ${res.t_groq_r2}ms)`);
      } catch (err) {
        console.log(`-> FAILED: ${err.message}`);
        allResults.push({ model, prompt: tp.prompt, category: tp.type, error: err.message });
      }
    }
  }

  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, 'latency_benchmark_results.json'), JSON.stringify(allResults, null, 2));
  console.log('\nSaved benchmark results to latency_benchmark_results.json');
  testDb.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
}

run().catch(console.error);

