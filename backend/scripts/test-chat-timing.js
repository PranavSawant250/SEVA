/**
 * Test script: chatWithSeva() timing — multi-message test
 * Run with: node scripts/test-chat-timing.js
 */
const { chatWithSeva } = require('../services/aiService');

const TEST_MESSAGES = [
  "What tasks do I have today?",
  "Which of my tasks is highest priority?",
  "Have I completed anything recently based on my past summaries?",
  "Give me a quick overview of my upcoming workload."
];

(async () => {
  console.log('=== chatWithSeva() Multi-Message Timing Test ===\n');
  console.log(`phi3.5 context window: 131,072 tokens (~524,288 chars)`);
  console.log(`Safe threshold: 75% = ~393,216 chars\n`);

  for (let i = 0; i < TEST_MESSAGES.length; i++) {
    const msg = TEST_MESSAGES[i];
    console.log(`\n--- Message ${i + 1}: "${msg}" ---`);
    const start = Date.now();
    const reply = await chatWithSeva(msg, null);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`SEVA: "${reply.substring(0, 150)}${reply.length > 150 ? '...' : ''}"`);
    console.log(`⏱️  Response time: ${elapsed}s`);
  }

  console.log('\n=== Test complete ===');
  process.exit(0);
})();
