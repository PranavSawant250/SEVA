const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const os = require('os');
const fs = require('fs');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-b07-reconcile-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const { processAgentChatMessage } = require('../services/chatAgent');
const db = require('../database/db');

async function testB07ExactEvidence() {
  const testDate = new Date('2026-11-01T14:00:00Z');

  console.log('--- 1. Task 9 before date alignment ---');
  console.log(db.prepare("SELECT * FROM tasks WHERE id = 9").get());

  // In test-suite-b.js setup:
  db.prepare("UPDATE tasks SET date = '2026-11-01' WHERE id = 9").run();
  console.log('\n--- 2. Task 9 after test suite setup (before test execution) ---');
  console.log(db.prepare("SELECT * FROM tasks WHERE id = 9").get());

  console.log('\n--- 3. Running processAgentChatMessage for B.07 ---');
  const res = await processAgentChatMessage('Finished reviewing Database lecture notes', {
    todayDate: testDate,
    nowDate: testDate,
    messageId: `b07-recon-${Date.now()}`,
    history: [],
    db
  });

  console.log('\n--- 4. Actions executed & raw results ---');
  for (const a of res.actions) {
    console.log(`Tool: ${a.tool}`);
    console.log(`Args:`, JSON.stringify(a.args));
    console.log(`Result:`, JSON.stringify(a.result));
    console.log('');
  }

  console.log('--- 5. Assistant Final Response ---');
  console.log(res.reply);

  console.log('\n--- 6. Task 9 in DB after execution ---');
  console.log(db.prepare("SELECT * FROM tasks WHERE id = 9").get());
}

testB07ExactEvidence().catch(console.error);

