const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(port, maxTries = 30) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'online') return true;
      }
    } catch (err) {
      if (i % 5 === 0) console.log(`  [waitForServer try ${i}] fetch error:`, err.code || err.message);
    }
    await sleep(300);
  }
  throw new Error(`Server failed to start on port ${port} within timeout`);
}

async function runRealProcessRestartTest() {
  console.log('================================================================');
  console.log('TEST 1: REAL BACKEND PROCESS TERMINATION & RESTART PERSISTENCE');
  console.log('================================================================');

  const tempDbPath = path.join(os.tmpdir(), `seva-restart-${Date.now()}.db`);
  fs.copyFileSync(path.join(__dirname, '../seva.db'), tempDbPath);
  console.log(`Isolated Temp DB created at: ${tempDbPath}`);

  const PORT = 3098;
  const sessionId = 'sess_real_process_restart_88';
  const clientRequestId = `req-restart-${Date.now()}`;
  const testMessage = 'Add a task called Finish Compiler Design homework for tomorrow at 5pm';

  // --- STEP 1: Launch real Backend Server Process #1 ---
  console.log('\n[Step 1] Spawning Backend Server Process #1...');
  let child1 = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEVA_DB_PATH: tempDbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child1.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('SEVA Backend running') || s.includes('POST /api/chat/message')) {
      process.stdout.write(`  [Server #1 Log] ${s.trim()}\n`);
    }
  });
  child1.stderr.on('data', d => process.stderr.write(`  [Server #1 Error] ${d.toString()}\n`));

  await waitForServer(PORT);
  console.log(`  Server Process #1 is healthy (PID: ${child1.pid}) listening on http://127.0.0.1:${PORT}`);

  // Inspect database count before
  let dbCheck = new Database(tempDbPath);
  const tasksBefore = dbCheck.prepare("SELECT count(*) as c FROM tasks WHERE name LIKE '%Compiler Design%'").get().c;
  console.log(`  Tasks matching before request: ${tasksBefore}`);
  dbCheck.close();

  // --- STEP 2: Send mutating chat request to Server #1 ---
  console.log(`\n[Step 2] Sending initial mutating request to Server #1 (PID: ${child1.pid})...`);
  console.log(`  Headers: x-session-id: ${sessionId}`);
  console.log(`  Payload:`, { session_id: sessionId, client_request_id: clientRequestId, message: testMessage });

  const res1 = await fetch(`http://127.0.0.1:${PORT}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
    body: JSON.stringify({ session_id: sessionId, client_request_id: clientRequestId, message: testMessage })
  });

  const res1Json = await res1.json();
  console.log(`  Server #1 Response Status: ${res1.status}`);
  console.log(`  Server #1 Response Body:`, JSON.stringify(res1Json, null, 2));

  // Inspect database count after initial execution
  dbCheck = new Database(tempDbPath);
  const tasksAfter1 = dbCheck.prepare("SELECT count(*) as c FROM tasks WHERE name LIKE '%Compiler Design%'").get().c;
  const envelope1 = dbCheck.prepare("SELECT session_id, client_request_id, status, lease_owner, lease_token FROM idempotency_requests WHERE session_id = ? AND client_request_id = ?").get(sessionId, clientRequestId);
  console.log(`  Tasks matching in database after Server #1: ${tasksAfter1} (Delta: +${tasksAfter1 - tasksBefore})`);
  console.log(`  Persisted Idempotency Envelope in SQLite on disk:`, envelope1);
  dbCheck.close();

  // --- STEP 3: Forcefully kill Server Process #1 ---
  console.log(`\n[Step 3] Terminating real Backend Process #1 (PID: ${child1.pid}) with SIGKILL...`);
  child1.kill('SIGKILL');
  await sleep(1000);
  console.log(`  Process #1 terminated. Checking if alive: ${child1.killed}`);

  // Confirm server is dead
  try {
    await fetch(`http://127.0.0.1:${PORT}/`);
    console.error('  ERROR: Server still reachable!');
  } catch (_) {
    console.log('  Confirmed: Server #1 process is completely dead and port is closed.');
  }

  // --- STEP 4: Start fresh Backend Server Process #2 ---
  console.log('\n[Step 4] Starting fresh Backend Server Process #2 from disk...');
  let child2 = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEVA_DB_PATH: tempDbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child2.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('SEVA Backend running') || s.includes('POST /api/chat/message')) {
      process.stdout.write(`  [Server #2 Log] ${s.trim()}\n`);
    }
  });
  child2.stderr.on('data', d => process.stderr.write(`  [Server #2 Error] ${d.toString()}\n`));

  await waitForServer(PORT);
  console.log(`  Server Process #2 is healthy (PID: ${child2.pid}) listening on http://127.0.0.1:${PORT}`);

  // --- STEP 5: Resend identical request to Server #2 ---
  console.log(`\n[Step 5] Retrying EXACT same request to Server #2 with identical session_id and client_request_id...`);
  const res2 = await fetch(`http://127.0.0.1:${PORT}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
    body: JSON.stringify({ session_id: sessionId, client_request_id: clientRequestId, message: testMessage })
  });

  const res2Json = await res2.json();
  console.log(`  Server #2 Response Status: ${res2.status}`);
  console.log(`  Server #2 Response Body:`, JSON.stringify(res2Json, null, 2));

  // Inspect database count after retry
  dbCheck = new Database(tempDbPath);
  const tasksAfter2 = dbCheck.prepare("SELECT count(*) as c FROM tasks WHERE name LIKE '%Compiler Design%'").get().c;
  const allTasks = dbCheck.prepare("SELECT id, name, date, time_slot, priority FROM tasks WHERE name LIKE '%Compiler Design%'").all();
  console.log(`  Tasks matching in database after Server #2 retry: ${tasksAfter2}`);
  console.log(`  All matching tasks in database:`, allTasks);
  dbCheck.close();

  // --- STEP 6: Assertions ---
  console.log('\n--- ASSERTIONS ---');
  console.log(`  1. Pre-restart execution succeeded: ${res1.status === 200 ? 'PASS' : 'FAIL'}`);
  console.log(`  2. Post-restart retry succeeded: ${res2.status === 200 ? 'PASS' : 'FAIL'}`);
  console.log(`  3. Exactly one mutation committed (Count 0 -> 1): ${tasksAfter2 === 1 ? 'PASS' : 'FAIL'}`);
  console.log(`  4. Zero duplicate tasks created on retry: ${tasksAfter1 === tasksAfter2 ? 'PASS' : 'FAIL'}`);

  // Clean shutdown
  child2.kill('SIGKILL');
  try { fs.unlinkSync(tempDbPath); } catch (_) {}
}

runRealProcessRestartTest().catch(console.error);
