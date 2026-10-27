const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDbPath = path.join(os.tmpdir(), `seva-test-hallucination-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'seva.db'), tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const db = require('../database/db');
process.on('exit', () => {
  try { db.close(); } catch (_) {}
  for (const s of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(tempDbPath + s)) fs.unlinkSync(tempDbPath + s); } catch (_) {}
  }
});
const { chatWithSeva } = require('../services/aiService');

// Clear 2026-09-26 history so it doesn't read past hallucinated messages
db.prepare("DELETE FROM chat_history WHERE date = '2026-09-26'").run();

console.log("Testing hallucination fix with prompt: \"what's my 5 PM meeting about?\"...");
chatWithSeva("what's my 5 PM meeting about?")
  .then(reply => {
    console.log("\n=================== SEVA RESPONSE ===================");
    console.log(reply);
    console.log("=====================================================\n");
  })
  .catch(console.error);
