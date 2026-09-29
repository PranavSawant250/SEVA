const db = require('../database/db');
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
