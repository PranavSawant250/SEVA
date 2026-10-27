/**
 * Step 1 test script — Goal import, chat command router, "call me", "steps for"
 * Run: node scripts/test-step1.js
 */
const http = require('http');

const BASE = 'http://localhost:3001';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3001, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    }).on('error', reject);
  });
}

const SAMPLE_GOALS = {
  "month": "October 2026",
  "goals": [
    {"category":"Technical","title":"Spring Boot Basics","target":"Controllers, Services, Repositories done","deadline":"2026-10-15","priority":"high"},
    {"category":"Technical","title":"PostgreSQL + Spring Boot","target":"JPA/Hibernate connected","deadline":"2026-10-20","priority":"high"},
    {"category":"DSA","title":"LeetCode 320","target":"40 problems in October","deadline":"2026-10-31","priority":"high"},
    {"category":"DSA","title":"Trees topic","target":"BFS, DFS, traversals complete","deadline":"2026-10-25","priority":"medium"},
    {"category":"Academic","title":"Shell Scripting Lab","target":"All practicals complete","deadline":"2026-10-31","priority":"medium"},
    {"category":"Personal","title":"Daily run","target":"5 days/week","deadline":"2026-10-31","priority":"medium"}
  ]
};

async function run() {
  console.log('=== STEP 1 TESTS ===\n');
  await new Promise(r => setTimeout(r, 500)); // let server settle

  // TEST 1: Import via endpoint (first time)
  console.log('--- TEST 1: POST /api/goals/import (first time) ---');
  const t1 = await post('/api/goals/import', SAMPLE_GOALS);
  console.log(`Status: ${t1.status}`);
  console.log(JSON.stringify(t1.body, null, 2));

  // TEST 2: Import again (should be 0 created, 6 updated, no duplicates)
  console.log('\n--- TEST 2: POST /api/goals/import (second time — expect 0 created, 6 updated) ---');
  const t2 = await post('/api/goals/import', SAMPLE_GOALS);
  console.log(`Status: ${t2.status}`);
  console.log(JSON.stringify(t2.body, null, 2));

  // TEST 3: Broken JSON via chat
  console.log('\n--- TEST 3: Chat — broken JSON ---');
  const t3 = await post('/api/chat/message', { message: '{"goals": [{"title": "missing priority"}' });
  console.log(`Status: ${t3.status}`);
  console.log(JSON.stringify(t3.body, null, 2));

  // TEST 4: "call me <name>"
  console.log('\n--- TEST 4: Chat — "call me Pranav" ---');
  const t4 = await post('/api/chat/message', { message: 'call me Pranav' });
  console.log(`Status: ${t4.status}`);
  console.log(JSON.stringify(t4.body, null, 2));

  // TEST 4b: Invalid name
  console.log('\n--- TEST 4b: Chat — "call me 12345" (invalid) ---');
  const t4b = await post('/api/chat/message', { message: 'call me 12345' });
  console.log(`Status: ${t4b.status}`);
  console.log(JSON.stringify(t4b.body, null, 2));

  // TEST 5: "steps for <goal>: a; b; c" on step-less goal
  console.log('\n--- TEST 5: Chat — "steps for JPA/Hibernate: Connect DB; Write entities; Run migration" ---');
  const t5 = await post('/api/chat/message', {
    message: 'steps for PostgreSQL + Spring Boot: Connect DB; Write entities; Run migration'
  });
  console.log(`Status: ${t5.status}`);
  console.log(JSON.stringify(t5.body, null, 2));

  // TEST 5b: "steps for" non-existent goal
  console.log('\n--- TEST 5b: Chat — "steps for Rust: a; b" (no such goal) ---');
  const t5b = await post('/api/chat/message', { message: 'steps for Rust: a; b' });
  console.log(`Status: ${t5b.status}`);
  console.log(JSON.stringify(t5b.body, null, 2));

  // TEST 6: Import via chat (JSON in message)
  console.log('\n--- TEST 6: Chat — paste goals JSON directly (expect 0 created, 6 updated) ---');
  const t6 = await post('/api/chat/message', { message: JSON.stringify(SAMPLE_GOALS) });
  console.log(`Status: ${t6.status}`);
  console.log(JSON.stringify(t6.body, null, 2));

  // TEST 7: Import with validation error (missing title at index 0)
  console.log('\n--- TEST 7: POST /api/goals/import — validation error (missing title) ---');
  const t7 = await post('/api/goals/import', {
    month: "Test",
    goals: [{ category: "X", deadline: "2026-12-01", priority: "high" }]
  });
  console.log(`Status: ${t7.status}`);
  console.log(JSON.stringify(t7.body, null, 2));

  // TEST 8: SELECT * FROM goals and goal_steps via a direct GET
  console.log('\n--- TEST 8: GET /api/goals ---');
  const t8 = await get('/api/goals');
  console.log(`Status: ${t8.status}`);
  const goals = t8.body.goals || [];
  goals.forEach(g => {
    console.log(`  [${g.id}] "${g.title}" type=${g.goal_type} priority=${g.priority} status=${g.status} target_count=${g.target_count} per_week=${g.per_week} steps=${g.steps.length}`);
    if (g.steps.length > 0) g.steps.forEach(s => console.log(`      step[${s.id}] "${s.step_text}" done=${s.done}`));
  });

  console.log('\n=== STEP 1 TESTS COMPLETE ===');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
