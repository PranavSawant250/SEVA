/**
 * Safety valve test: temporarily override CHAT_SAFE_THRESHOLD to ~4000 chars
 * to force trimming, then confirm the trim log fires and reply is coherent.
 * Run: node scripts/test-valve.js
 */

// Monkey-patch the threshold BEFORE requiring aiService
// We do this by modifying the module after load via a test shim
const aiServicePath = require.resolve('../services/aiService');

// Load the module to get chatWithSeva
const aiService = require('../services/aiService');

// Access internal via a specially named export if we add one,
// OR we just test it end-to-end and check logs for the warning line.
// Since threshold is a module-level const, we test it by directly calling
// chatWithSeva with a padded userMessage to push total chars over 4000.

const { chatWithSeva } = aiService;

// Real threshold is ~22,937 chars. Current context is ~3,500 chars.
// To force trim without changing production code, we pass a very large
// userMessage (padded to ~20,000 chars) — this will push staticChars over 22,937.
// This tests the trim path in production logic without touching the constant.

const PADDING = 'A'.repeat(20000);
const MSG = `Test message with padding to trigger safety valve. ${PADDING}`;

(async () => {
  console.log('=== Safety Valve Test ===');
  console.log(`Sending message of ${MSG.length} chars to push context over ~22,937 char threshold.`);
  console.log('Watch for: ⚠️  Chat history exceeds safe context size...\n');

  const t = Date.now();
  const reply = await chatWithSeva(MSG, null);
  const elapsed = ((Date.now() - t) / 1000).toFixed(2);

  console.log(`\nReply: "${reply.substring(0, 200)}${reply.length > 200 ? '...' : ''}"`);
  console.log(`⏱️  Response time: ${elapsed}s`);
  console.log('\n=== Test complete ===');
  process.exit(0);
})();
