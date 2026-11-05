const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const os = require('os');
const fs = require('fs');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-b07-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const { processAgentChatMessage } = require('../services/chatAgent');
const db = require('../database/db');

async function testWithTodayTask() {
  const testDate = new Date('2026-11-01T14:00:00Z');
  // Update task 9 date to 2026-11-01
  db.prepare("UPDATE tasks SET date = '2026-11-01' WHERE id = 9").run();

  const message = 'Finished reviewing Database lecture notes';

  console.log('\n--- Calling processAgentChatMessage for B.07 with task 9 on 2026-11-01 ---');
  const res = await processAgentChatMessage(message, {
    todayDate: testDate,
    nowDate: testDate,
    messageId: `debug-b07-${Date.now()}`,
    history: [],
    db
  });

  console.log('\n--- Actions called ---');
  console.log(res.actions.map(a => ({ tool: a.tool, args: a.args })));
  console.log('Reply:', res.reply);

  console.log('\n--- Task 9 in DB ---');
  console.log(db.prepare("SELECT id, name, date, completed FROM tasks WHERE id = 9").get());
}

testWithTodayTask().catch(console.error);
