/**
 * backend/scripts/verify-idempotency-restart.js
 *
 * Verifies that idempotency survives real process termination and restart:
 * 1. Process A executes mutation with fixed sessionId and clientRequestId.
 * 2. Process A exits (in-memory maps destroyed).
 * 3. Fresh Process B boots with the same DB.
 * 4. Process B receives identical request.
 * 5. Process B returns cached response with 0 second mutation.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-idemp-restart-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);

console.log('================================================================');
console.log('🧪 VERIFY IDEMPOTENCY ACROSS ACTUAL PROCESS RESTARTS');
console.log(`Database: Isolated Temp DB (${tempDbPath})`);
console.log('================================================================\n');

const childScript = `
const path = require('path');
process.env.SEVA_DB_PATH = ${JSON.stringify(tempDbPath)};
require('dotenv').config({ path: ${JSON.stringify(path.resolve(__dirname, '../.env'))} });
const db = require(${JSON.stringify(path.resolve(__dirname, '../database/db'))});
const { processAgentChatMessage, tripGeminiCircuitBreaker } = require(${JSON.stringify(path.resolve(__dirname, '../services/chatAgent'))});

// Disable Gemini to test local fallback idempotency
tripGeminiCircuitBreaker(3600000, 'Test Idempotency');

async function run() {
  const sessionId = 'sess_fixed_prod_idemp';
  const clientRequestId = 'req_fixed_prod_idemp_101';
  const testDate = new Date('2026-11-02T10:00:00Z');

  const countBefore = db.prepare("SELECT current_count FROM goals WHERE id = 7").get().current_count;

  const res = await processAgentChatMessage('I solved 2 LeetCode problems today.', {
    sessionId,
    messageId: clientRequestId,
    todayDate: testDate,
    nowDate: testDate,
    db
  });

  const countAfter = db.prepare("SELECT current_count FROM goals WHERE id = 7").get().current_count;
  const progressRows = db.prepare("SELECT count(*) as c FROM goal_progress_log").get().c;

  console.log(JSON.stringify({
    pid: process.pid,
    reply: res.reply,
    cached: res._idempotent_cached || false,
    countBefore,
    countAfter,
    progressRows
  }));

  db.close();
}

run().catch(e => { console.error(e); process.exit(1); });
`;

const childScriptPath = path.join(__dirname, `idemp-child-${Date.now()}.js`);
fs.writeFileSync(childScriptPath, childScript);

// Step 1: Run Process A
console.log('Step 1: Running Process A (First Execution)...');
const p1 = spawnSync(process.execPath, [childScriptPath], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
if (p1.stderr) console.error('P1 Stderr:', p1.stderr.trim());
const p1Lines = p1.stdout.trim().split('\n');
const p1Json = JSON.parse(p1Lines[p1Lines.length - 1]);
console.log('  Process A PID:', p1Json.pid);
console.log('  Cached on 1st run:', p1Json.cached);
console.log('  Goal count before:', p1Json.countBefore, '-> after:', p1Json.countAfter);
console.log('  Total progress rows in DB:', p1Json.progressRows);

// Step 2: Process A is dead. Launch fresh Process B
console.log('\nStep 2: Process A terminated. Launching fresh Process B (Simulating Backend Restart)...');
const p2 = spawnSync(process.execPath, [childScriptPath], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
if (p2.stderr) console.error('P2 Stderr:', p2.stderr.trim());
const p2Lines = p2.stdout.trim().split('\n');
const p2Json = JSON.parse(p2Lines[p2Lines.length - 1]);
console.log('  Process B PID (Fresh Process):', p2Json.pid);
console.log('  Cached on 2nd run:', p2Json.cached);
console.log('  Goal count before:', p2Json.countBefore, '-> after:', p2Json.countAfter);
console.log('  Total progress rows in DB:', p2Json.progressRows);

console.log('\nStep 3: Evaluating Idempotency Guarantee:');
const executedOnce = p1Json.countAfter === p1Json.countBefore + 2;
const zeroSecondMutation = p2Json.countAfter === p1Json.countAfter;
const identicalProgressRows = p1Json.progressRows === p2Json.progressRows;
const returnedCached = p2Json.cached === true;

console.log('  • First execution performed mutation:', executedOnce);
console.log('  • Second execution returned cached response:', returnedCached);
console.log('  • Second execution caused 0 new mutations:', zeroSecondMutation);
console.log('  • Total progress rows identical:', identicalProgressRows);

if (executedOnce && zeroSecondMutation && identicalProgressRows && returnedCached) {
  console.log('\n✅ IDEMPOTENCY ACROSS RESTART VERIFIED: Exactly one mutation, zero duplicates.');
} else {
  console.error('\n❌ IDEMPOTENCY VERIFICATION FAILED.');
}

try {
  fs.unlinkSync(childScriptPath);
  fs.unlinkSync(tempDbPath);
} catch (_) {}

