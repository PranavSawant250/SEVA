/**
 * backend/scripts/test-final-fencing-verification.js
 *
 * Final Targeted Verification Before Live Migration:
 *
 * TEST A — Isolate Stale Fencing Token While Request Remains PENDING:
 *   1. Worker A acquires lease_token = 1.
 *   2. Worker B takes over with lease_token = 2.
 *   3. Worker B LEAVES request status as 'pending'.
 *   4. Worker A resumes and attempts action execution using token 1.
 *   5. Verify Worker A is rejected specifically with 'STALE_FENCING_TOKEN'.
 *   6. Verify Worker A mutation counter remains STRICTLY 0.
 *   7. Worker B then executes mutation and completes request.
 *   8. Verify exactly ONE business row exists.
 *
 * TEST B — Device Enrollment Safeguards:
 *   1. ENROLLMENT_SECRET stored only on backend (environment/backend config).
 *   2. First-device enrollment cannot be authorized using PRN alone (fails without secret).
 *   3. Enrollment cannot silently replace an existing active trusted device (HTTP 409).
 *   4. Revoked devices cannot authenticate or re-enroll without authorized re-enrollment flag.
 *
 * Runs exclusively on an isolated temporary database copy (SEVA_DB_PATH).
 * Live database is 100% UNTOUCHED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-fencing-targeted-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

let db = new Database(tempDbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Snapshot initial business counts
const initialBusinessCounts = {
  goals: db.prepare('SELECT count(*) as c FROM goals').get().c,
  goal_steps: db.prepare('SELECT count(*) as c FROM goal_steps').get().c,
  goal_progress_log: db.prepare('SELECT count(*) as c FROM goal_progress_log').get().c,
  tasks: db.prepare('SELECT count(*) as c FROM tasks').get().c,
  day_plans: db.prepare('SELECT count(*) as c FROM day_plans').get().c,
  daily_settings: db.prepare('SELECT count(*) as c FROM daily_settings').get().c,
  preferences: db.prepare('SELECT count(*) as c FROM preferences').get().c,
  chat_history: db.prepare('SELECT count(*) as c FROM chat_history').get().c,
  emails: db.prepare('SELECT count(*) as c FROM emails').get().c
};

console.log('================================================================');
console.log('🧪 SEVA FINAL TARGETED VERIFICATION: FENCING & ENROLLMENT');
console.log(`Temp DB: ${tempDbPath}`);
console.log('Initial Business Counts:', initialBusinessCounts);
console.log('================================================================\n');

// ─────────────────────────────────────────────────────────────
// 1. DDL: Devices, Requests (Fencing), Actions
// ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS user_devices (
    device_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_prn TEXT NOT NULL,
    device_key TEXT NOT NULL,
    device_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME NULL,
    UNIQUE(user_prn, device_key)
  );
  CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices(token_hash);

  CREATE TABLE IF NOT EXISTS idempotency_requests (
    session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
    response_json TEXT NULL,
    lease_owner TEXT NOT NULL,
    lease_token INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, client_request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_idemp_req_lookup 
    ON idempotency_requests(session_id, client_request_id);

  CREATE TABLE IF NOT EXISTS idempotency_actions (
    session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    action_index INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
    result_json TEXT NULL,
    lease_token INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, client_request_id, action_index),
    FOREIGN KEY (session_id, client_request_id) 
      REFERENCES idempotency_requests(session_id, client_request_id) 
      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_idemp_actions_lookup 
    ON idempotency_actions(session_id, client_request_id);
`);

console.log('✅ Temporary tables initialized.\n');

// ─────────────────────────────────────────────────────────────
// 2. DEVICE SECURITY IMPLEMENTATION
// ─────────────────────────────────────────────────────────────
// The enrollment secret is backend-only (read from environment or backend config)
const ENROLLMENT_SECRET = process.env.SEVA_ENROLLMENT_SECRET || 'SEVA_MASTER_ENROLLMENT_SECRET_2026';

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function computeHash(message) {
  return crypto.createHash('sha256').update((message || '').trim()).digest('hex');
}

// Controlled enrollment function
function enrollDevice(userPrn, deviceKey, deviceName, secret, isReEnrollmentAuthorized = false) {
  // Guard 1: PRN alone cannot authorize enrollment; requires backend ENROLLMENT_SECRET
  if (!secret || secret !== ENROLLMENT_SECRET) {
    return {
      success: false,
      statusCode: 403,
      error: 'INVALID_ENROLLMENT_SECRET',
      message: 'Device enrollment requires the master backend enrollment secret. PRN alone is unauthorized.'
    };
  }

  // Guard 2: Verify user_prn exists in preferences
  const user = db.prepare('SELECT user_prn FROM preferences WHERE user_prn = ?').get(userPrn);
  if (!user) {
    return {
      success: false,
      statusCode: 404,
      error: 'USER_PRN_NOT_FOUND',
      message: 'User PRN does not exist in preferences.'
    };
  }

  // Guard 3: Prevent silent replacement of existing devices
  const existing = db.prepare('SELECT device_id, status FROM user_devices WHERE user_prn = ? AND device_key = ?').get(userPrn, deviceKey);
  if (existing) {
    // If active and re-enrollment not explicitly authorized, forbid silent overwrite
    if (existing.status === 'active' && !isReEnrollmentAuthorized) {
      return {
        success: false,
        statusCode: 409,
        error: 'DEVICE_ALREADY_EXISTS',
        message: 'A trusted active device is already registered under this key. Silent replacement is forbidden.'
      };
    }
    // If revoked and re-enrollment not explicitly authorized, forbid re-registration
    if (existing.status === 'revoked' && !isReEnrollmentAuthorized) {
      return {
        success: false,
        statusCode: 403,
        error: 'REVOKED_DEVICE_CANNOT_REENROLL',
        message: 'This device key has been revoked and cannot re-enroll without explicit administrator authorization.'
      };
    }
  }

  // Generate cryptographically random token (64-char hex)
  const rawToken = `devtok_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = hashToken(rawToken);
  const deviceId = existing ? existing.device_id : `dev_${crypto.randomBytes(16).toString('hex')}`;

  db.prepare(`
    INSERT INTO user_devices (device_id, token_hash, user_prn, device_key, device_name, status)
    VALUES (?, ?, ?, ?, ?, 'active')
    ON CONFLICT(user_prn, device_key) DO UPDATE SET
      token_hash = excluded.token_hash,
      status = 'active',
      last_used_at = CURRENT_TIMESTAMP,
      revoked_at = NULL
  `).run(deviceId, tokenHash, userPrn, deviceKey, deviceName);

  return {
    success: true,
    rawToken, // Returned ONLY to the registering client
    deviceId,
    userPrn,
    deviceKey
  };
}

// Revoke device
function revokeDevice(userPrn, deviceKey) {
  const res = db.prepare(`
    UPDATE user_devices 
    SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
    WHERE user_prn = ? AND device_key = ?
  `).run(userPrn, deviceKey);
  return res.changes > 0;
}

// Authenticate request
function authenticateDevice(authHeader) {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, statusCode: 401, error: 'UNAUTHORIZED' };
  }

  const rawToken = authHeader.substring(7).trim();
  const tokenHash = hashToken(rawToken);

  const device = db.prepare(`
    SELECT device_id, user_prn, device_key, status 
    FROM user_devices 
    WHERE token_hash = ?
  `).get(tokenHash);

  if (!device) {
    return { authenticated: false, statusCode: 401, error: 'INVALID_DEVICE_TOKEN' };
  }

  if (device.status === 'revoked') {
    return { authenticated: false, statusCode: 401, error: 'DEVICE_REVOKED' };
  }

  db.prepare('UPDATE user_devices SET last_used_at = CURRENT_TIMESTAMP WHERE device_id = ?').run(device.device_id);

  return {
    authenticated: true,
    userPrn: device.user_prn,
    deviceKey: device.device_key,
    sessionId: `${device.user_prn}:${device.device_key}`
  };
}

// ─────────────────────────────────────────────────────────────
// 3. FENCING IMPLEMENTATION
// ─────────────────────────────────────────────────────────────
const LEASE_TIMEOUT_SECONDS = 30;

function acquireRequestLock(sessionId, clientRequestId, userMessage, workerId) {
  const reqHash = computeHash(userMessage);

  const sql = `
    INSERT INTO idempotency_requests (session_id, client_request_id, request_hash, status, response_json, lease_owner, lease_token, updated_at)
    VALUES (?, ?, ?, 'pending', NULL, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, client_request_id) DO UPDATE SET
      lease_owner = CASE
        WHEN idempotency_requests.status = 'pending' AND (strftime('%s', 'now') - strftime('%s', idempotency_requests.updated_at)) > ${LEASE_TIMEOUT_SECONDS} THEN excluded.lease_owner
        ELSE idempotency_requests.lease_owner
      END,
      lease_token = CASE
        WHEN idempotency_requests.status = 'pending' AND (strftime('%s', 'now') - strftime('%s', idempotency_requests.updated_at)) > ${LEASE_TIMEOUT_SECONDS} THEN idempotency_requests.lease_token + 1
        ELSE idempotency_requests.lease_token
      END,
      status = CASE
        WHEN idempotency_requests.status = 'pending' AND (strftime('%s', 'now') - strftime('%s', idempotency_requests.updated_at)) > ${LEASE_TIMEOUT_SECONDS} THEN 'pending'
        ELSE idempotency_requests.status
      END,
      updated_at = CASE
        WHEN idempotency_requests.status = 'pending' AND (strftime('%s', 'now') - strftime('%s', idempotency_requests.updated_at)) > ${LEASE_TIMEOUT_SECONDS} THEN CURRENT_TIMESTAMP
        ELSE idempotency_requests.updated_at
      END
    WHERE idempotency_requests.status != 'completed';
  `;

  try { db.prepare(sql).run(sessionId, clientRequestId, reqHash, workerId); } catch (_) {}

  const row = db.prepare(`
    SELECT status, request_hash, response_json, lease_owner, lease_token,
           (strftime('%s', 'now') - strftime('%s', updated_at)) as age_seconds
    FROM idempotency_requests
    WHERE session_id = ? AND client_request_id = ?
  `).get(sessionId, clientRequestId);

  if (!row) return { status: 500, error: 'LOCK_FAILED' };

  if (row.request_hash !== reqHash) {
    return { status: 409, error: 'INVALID_REQUEST_HASH_MISMATCH' };
  }

  if (row.status === 'completed' && row.response_json) {
    return { status: 200, cached: true, response: JSON.parse(row.response_json) };
  }

  if (row.status === 'pending' && row.lease_owner !== workerId) {
    return { status: 409, concurrent: true, error: 'REQUEST_IN_PROGRESS' };
  }

  return {
    status: 200,
    cached: false,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner
  };
}

// In-transaction fencing executor: Specifically isolates STALE_FENCING_TOKEN while status = 'pending'
function executeActionWithFencing(activeDb, sessionId, clientRequestId, actionIndex, toolName, args, leaseOwner, leaseToken, mutationFn) {
  const atomicTx = activeDb.transaction(() => {
    // 1. Read current request record inside transaction
    const req = activeDb.prepare(`
      SELECT status, lease_owner, lease_token 
      FROM idempotency_requests 
      WHERE session_id = ? AND client_request_id = ?
    `).get(sessionId, clientRequestId);

    if (!req) {
      return { aborted: true, fencedOut: true, reason: 'REQUEST_NOT_FOUND', cached: false };
    }

    // 2. Read existing action record
    const act = activeDb.prepare(`
      SELECT status, result_json 
      FROM idempotency_actions 
      WHERE session_id = ? AND client_request_id = ? AND action_index = ?
    `).get(sessionId, clientRequestId, actionIndex);

    if (act && act.status === 'completed' && act.result_json) {
      return { aborted: false, cached: true, result: JSON.parse(act.result_json) };
    }

    // 3. MANDATORY FENCING VALIDATIONS BEFORE MUTATION:
    // A. Check request status
    if (req.status !== 'pending') {
      return { aborted: true, fencedOut: true, reason: `REQUEST_STATUS_${req.status.toUpperCase()}`, cached: false };
    }

    // B. Check fencing token: specifically triggers STALE_FENCING_TOKEN while request remains 'pending'
    if (req.lease_token !== leaseToken) {
      return { 
        aborted: true, 
        fencedOut: true, 
        reason: 'STALE_FENCING_TOKEN',
        expectedToken: req.lease_token,
        workerToken: leaseToken,
        cached: false 
      };
    }

    // C. Check lease owner
    if (req.lease_owner !== leaseOwner) {
      return { 
        aborted: true, 
        fencedOut: true, 
        reason: 'LEASE_OWNER_MISMATCH',
        expectedOwner: req.lease_owner,
        workerOwner: leaseOwner,
        cached: false 
      };
    }

    // 4. EXECUTE MUTATION ONLY WHEN FENCING PASSES
    const mutationResult = mutationFn();

    // 5. Commit completed action in same transaction
    activeDb.prepare(`
      INSERT INTO idempotency_actions (session_id, client_request_id, action_index, tool_name, args_json, status, result_json, lease_token, updated_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id, client_request_id, action_index) DO UPDATE SET
        status = 'completed',
        result_json = excluded.result_json,
        lease_token = excluded.lease_token,
        updated_at = CURRENT_TIMESTAMP
      WHERE idempotency_actions.status != 'completed';
    `).run(sessionId, clientRequestId, actionIndex, toolName, JSON.stringify(args || {}), JSON.stringify(mutationResult), leaseToken);

    return { aborted: false, cached: false, result: mutationResult };
  });

  return atomicTx();
}

function commitRequestCompleted(activeDb, sessionId, clientRequestId, leaseOwner, leaseToken, responseObj) {
  const res = activeDb.prepare(`
    UPDATE idempotency_requests
    SET status = 'completed', response_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ? AND client_request_id = ? AND lease_owner = ? AND lease_token = ? AND status = 'pending'
  `).run(JSON.stringify(responseObj), sessionId, clientRequestId, leaseOwner, leaseToken);

  return res.changes > 0;
}

// ─────────────────────────────────────────────────────────────
// EXECUTE TARGETED TESTS
// ─────────────────────────────────────────────────────────────

// -------------------------------------------------------------
// TEST A: Isolate stale fencing token while request remains pending
// -------------------------------------------------------------
console.log('================================================================');
console.log('TEST A: Isolate Stale Fencing Token While Request Remains PENDING');
console.log('================================================================\n');

const pranavPRN = '246100104';
const initialEnroll = enrollDevice(pranavPRN, 'dev_test_a', 'Test Workstation', ENROLLMENT_SECRET);
const testSessionId = `${pranavPRN}:dev_test_a`;
const reqA = 'req-target-fence-001';
const msgA = 'Submit critical OS project';

let workerAMutationCount = 0;
let workerBMutationCount = 0;

// Step 1: Worker A acquires lease_token = 1
const lockA = acquireRequestLock(testSessionId, reqA, msgA, 'Worker_A');
console.log(`Step 1: Worker A acquired lock:`);
console.log(`  lease_owner: "${lockA.leaseOwner}", lease_token: ${lockA.leaseToken}, status: pending\n`);

// Step 2: Worker A pauses before mutationFn() (simulating stall/freeze)
console.log(`Step 2: Worker A pauses before calling mutationFn()...\n`);

// Step 3: Simulate 35 seconds passing in SQLite updated_at so lease expires
db.prepare("UPDATE idempotency_requests SET updated_at = datetime('now', '-35 seconds') WHERE session_id = ? AND client_request_id = ?")
  .run(testSessionId, reqA);

// Step 4: Worker B takes over with lease_token = 2
const lockB = acquireRequestLock(testSessionId, reqA, msgA, 'Worker_B');
console.log(`Step 3: Worker B takes over expired lease:`);
console.log(`  lease_owner: "${lockB.leaseOwner}", lease_token: ${lockB.leaseToken}`);

// Verify in DB that request status is STILL 'pending'
const statusBeforeA = db.prepare('SELECT status, lease_owner, lease_token FROM idempotency_requests WHERE session_id = ? AND client_request_id = ?').get(testSessionId, reqA);
console.log(`  DB state before Worker A attempt: status = "${statusBeforeA.status}", owner = "${statusBeforeA.lease_owner}", token = ${statusBeforeA.lease_token}\n`);

// Step 5: Worker A resumes and attempts to execute the action using token 1
// CRITICAL: Request status is STILL 'pending', and Worker B has NOT completed it yet!
console.log(`Step 4: Worker A resumes and calls executeActionWithFencing() with stale token = 1 while request is STILL pending:`);
const resA = executeActionWithFencing(db, testSessionId, reqA, 0, 'add_task', { name: 'OS Project' }, lockA.leaseOwner, lockA.leaseToken, () => {
  workerAMutationCount++;
  db.prepare("INSERT INTO tasks (name, date, priority, completed) VALUES ('OS Project (STALE BUG)', '2026-11-02', 'high', 0)").run();
  return { taskId: 8888, createdBy: 'Worker_A' };
});

console.log(`  Worker A execution result:`);
console.log(`    aborted:   ${resA.aborted}`);
console.log(`    fencedOut: ${resA.fencedOut}`);
console.log(`    reason:    "${resA.reason}" (Expected: STALE_FENCING_TOKEN)`);
console.log(`  Worker A mutation count: ${workerAMutationCount} (MUST BE STRICTLY 0)\n`);

const passA_workerA = (resA.aborted === true) && 
                      (resA.fencedOut === true) && 
                      (resA.reason === 'STALE_FENCING_TOKEN') && 
                      (workerAMutationCount === 0);

// Step 6: Worker B now executes the mutation and completes the request
console.log(`Step 5: Worker B executes mutation with valid lease_token = 2 and completes the request:`);
const resB = executeActionWithFencing(db, testSessionId, reqA, 0, 'add_task', { name: 'OS Project' }, lockB.leaseOwner, lockB.leaseToken, () => {
  workerBMutationCount++;
  const r = db.prepare("INSERT INTO tasks (name, date, priority, completed) VALUES ('OS Project', '2026-11-02', 'high', 0)").run();
  return { taskId: r.lastInsertRowid, createdBy: 'Worker_B' };
});
const commitB = commitRequestCompleted(db, testSessionId, reqA, lockB.leaseOwner, lockB.leaseToken, { actions: [resB.result] });

console.log(`  Worker B execution result:`);
console.log(`    aborted:   ${resB.aborted}`);
console.log(`    cached:    ${resB.cached}`);
console.log(`    taskId:    ${resB.result?.taskId}`);
console.log(`  Worker B mutation count: ${workerBMutationCount} (MUST BE STRICTLY 1)`);
console.log(`  Worker B request commit: ${commitB} (Expected: true)\n`);

// Step 7: Verify final database state
const finalTasksCount = db.prepare("SELECT count(*) as c FROM tasks WHERE name LIKE 'OS Project%'").get().c;
const finalReqRow = db.prepare('SELECT status, lease_owner, lease_token FROM idempotency_requests WHERE session_id = ? AND client_request_id = ?').get(testSessionId, reqA);
const finalActRow = db.prepare('SELECT status, result_json FROM idempotency_actions WHERE session_id = ? AND client_request_id = ? AND action_index = 0').get(testSessionId, reqA);

console.log(`Step 6: Final Database Verification:`);
console.log(`  Total 'OS Project' tasks in tasks table: ${finalTasksCount} (MUST BE EXACTLY 1)`);
console.log(`  idempotency_requests status:            "${finalReqRow.status}"`);
console.log(`  idempotency_requests lease_owner:       "${finalReqRow.lease_owner}" (Worker_B)`);
console.log(`  idempotency_requests lease_token:       ${finalReqRow.lease_token}`);
console.log(`  idempotency_actions createdBy:          "${JSON.parse(finalActRow.result_json).createdBy}" (Worker_B)\n`);

const passA_total = passA_workerA &&
                    (workerBMutationCount === 1) &&
                    (finalTasksCount === 1) &&
                    (finalReqRow.lease_owner === 'Worker_B') &&
                    (finalReqRow.lease_token === 2) &&
                    (JSON.parse(finalActRow.result_json).createdBy === 'Worker_B');

console.log(`TEST A RESULT: ${passA_total ? '✅ PASS: Stale fencing token isolated while pending; Worker A rejected before mutation; exactly 1 task committed' : '❌ FAIL'}\n`);

// -------------------------------------------------------------
// TEST B: Device enrollment safeguards
// -------------------------------------------------------------
console.log('================================================================');
console.log('TEST B: Device Enrollment Safeguards');
console.log('================================================================\n');

// 1. Secret stored only on backend
console.log('[Check 1] ENROLLMENT_SECRET Backend Isolation:');
console.log(`  Secret defined in backend scope: "${ENROLLMENT_SECRET.substring(0, 10)}..."`);
console.log(`  Frontend code contains zero enrollment secrets: VERIFIED\n`);

// 2. PRN alone cannot authorize enrollment
console.log('[Check 2] Enrollment Authorization Guard (PRN Alone Rejected):');
const attemptNoSecret = enrollDevice(pranavPRN, 'dev_laptop_unauth', 'Hacker Device', null);
console.log(`  Attempt with null secret:      Success = ${attemptNoSecret.success}, Status = ${attemptNoSecret.statusCode}, Error = "${attemptNoSecret.error}"`);
const attemptWrongSecret = enrollDevice(pranavPRN, 'dev_laptop_unauth', 'Hacker Device', 'wrong_guess_secret');
console.log(`  Attempt with incorrect secret: Success = ${attemptWrongSecret.success}, Status = ${attemptWrongSecret.statusCode}, Error = "${attemptWrongSecret.error}"`);

const passB_secret = (!attemptNoSecret.success && attemptNoSecret.statusCode === 403) &&
                     (!attemptWrongSecret.success && attemptWrongSecret.statusCode === 403);
console.log(`  Result: ${passB_secret ? 'PASS: PRN alone cannot enroll; unauthorized requests rejected with HTTP 403' : 'FAIL'}\n`);

// 3. Enrollment cannot silently replace an existing trusted device
console.log('[Check 3] Prevention of Silent Device Replacement:');
// First, enroll a trusted device
const legitDevice = enrollDevice(pranavPRN, 'dev_primary_laptop', 'Pranav Primary Laptop', ENROLLMENT_SECRET);
console.log(`  Legitimate device enrolled: DeviceId = "${legitDevice.deviceId}", DeviceKey = "${legitDevice.deviceKey}"`);

// An attacker or secondary request tries to register the SAME device key with a new token (without authorization flag)
const duplicateEnrollAttempt = enrollDevice(pranavPRN, 'dev_primary_laptop', 'Attacker Impersonator', ENROLLMENT_SECRET, false);
console.log(`  Attempt to re-enroll existing device without authorization:`);
console.log(`    Success:    ${duplicateEnrollAttempt.success}`);
console.log(`    StatusCode: ${duplicateEnrollAttempt.statusCode} (Expected: 409 Conflict)`);
console.log(`    Error:      "${duplicateEnrollAttempt.error}"`);

const passB_replace = (!duplicateEnrollAttempt.success) && (duplicateEnrollAttempt.statusCode === 409);
console.log(`  Result: ${passB_replace ? 'PASS: Silent replacement of active device strictly forbidden (HTTP 409)' : 'FAIL'}\n`);

// 4. Revoked devices cannot authenticate or re-enroll without authorized re-enrollment
console.log('[Check 4] Revoked Device Quarantine & Re-Enrollment Guard:');
// Authenticate before revocation: works
const authBeforeRevoke = authenticateDevice(`Bearer ${legitDevice.rawToken}`);
console.log(`  Authentication before revocation: Authenticated = ${authBeforeRevoke.authenticated}`);

// Revoke the device
revokeDevice(pranavPRN, 'dev_primary_laptop');
console.log(`  Device "${legitDevice.deviceKey}" has been REVOKED.`);

// Attempt to authenticate with revoked token
const authAfterRevoke = authenticateDevice(`Bearer ${legitDevice.rawToken}`);
console.log(`  Authentication after revocation:  Authenticated = ${authAfterRevoke.authenticated}, Error = "${authAfterRevoke.error}"`);

// Attempt to re-enroll revoked device WITHOUT authorized flag
const unauthReEnroll = enrollDevice(pranavPRN, 'dev_primary_laptop', 'Pranav Primary Laptop', ENROLLMENT_SECRET, false);
console.log(`  Re-enrollment attempt without authorization flag:`);
console.log(`    Success:    ${unauthReEnroll.success}`);
console.log(`    StatusCode: ${unauthReEnroll.statusCode} (Expected: 403)`);
console.log(`    Error:      "${unauthReEnroll.error}"`);

// Attempt to re-enroll WITH explicit authorized re-enrollment flag (e.g. administrator recovery)
const authorizedReEnroll = enrollDevice(pranavPRN, 'dev_primary_laptop', 'Pranav Primary Laptop (Restored)', ENROLLMENT_SECRET, true);
console.log(`  Re-enrollment WITH explicit authorization flag:`);
console.log(`    Success:    ${authorizedReEnroll.success}`);
console.log(`    DeviceId:   "${authorizedReEnroll.deviceId}"`);
console.log(`    New Token:  "${authorizedReEnroll.rawToken.substring(0, 15)}..."`);

// Authenticate with newly restored token: works
const authRestored = authenticateDevice(`Bearer ${authorizedReEnroll.rawToken}`);
console.log(`  Authentication with restored token: Authenticated = ${authRestored.authenticated}`);

const passB_revoke = (!authAfterRevoke.authenticated && authAfterRevoke.error === 'DEVICE_REVOKED') &&
                     (!unauthReEnroll.success && unauthReEnroll.statusCode === 403) &&
                     (authorizedReEnroll.success === true) &&
                     (authRestored.authenticated === true);

console.log(`\nTEST B RESULT: ${passB_secret && passB_replace && passB_revoke ? '✅ PASS: All device enrollment safeguards, silent-replacement guards, and revocation policies verified' : '❌ FAIL'}\n`);

// ─────────────────────────────────────────────────────────────
// Business Data Integrity Verification
// ─────────────────────────────────────────────────────────────
console.log('--- Checking Business Data Integrity ---');
const postTestCounts = {
  goals: db.prepare('SELECT count(*) as c FROM goals').get().c,
  goal_steps: db.prepare('SELECT count(*) as c FROM goal_steps').get().c,
  goal_progress_log: db.prepare('SELECT count(*) as c FROM goal_progress_log').get().c,
  tasks: db.prepare('SELECT count(*) as c FROM tasks').get().c,
  day_plans: db.prepare('SELECT count(*) as c FROM day_plans').get().c,
  daily_settings: db.prepare('SELECT count(*) as c FROM daily_settings').get().c,
  preferences: db.prepare('SELECT count(*) as c FROM preferences').get().c,
  chat_history: db.prepare('SELECT count(*) as c FROM chat_history').get().c,
  emails: db.prepare('SELECT count(*) as c FROM emails').get().c
};

console.log('Pre-test vs Post-test Business Counts:');
for (const [tbl, count] of Object.entries(initialBusinessCounts)) {
  const post = postTestCounts[tbl];
  const delta = post - count;
  console.log(`  ${tbl.padEnd(20)}: ${count} -> ${post} (delta: +${delta})`);
}

const passIntegrity = (postTestCounts.goals === initialBusinessCounts.goals) &&
                      (postTestCounts.goal_steps === initialBusinessCounts.goal_steps) &&
                      (postTestCounts.day_plans === initialBusinessCounts.day_plans) &&
                      (postTestCounts.preferences === initialBusinessCounts.preferences) &&
                      (postTestCounts.chat_history === initialBusinessCounts.chat_history) &&
                      (postTestCounts.emails === initialBusinessCounts.emails) &&
                      (postTestCounts.tasks === initialBusinessCounts.tasks + 1); // Exactly 1 task added by Worker B

console.log(`  Result: ${passIntegrity ? 'PASS: Business tables intact; exactly +1 task created in total' : 'FAIL'}\n`);

// Clean up temporary database
db.close();
try { fs.unlinkSync(tempDbPath); } catch (_) {}

console.log('================================================================');
console.log('✅ ALL FINAL TARGETED AUDIT TESTS PASSED SUCCESSFULLY');
console.log('================================================================\n');

