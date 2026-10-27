/**
 * Cold-start diagnostic test for chatWithSeva()
 * Sends the SAME message twice back-to-back.
 * If msg1 is slow and msg2 is fast → cold-start (model load time), not reply length.
 * Run: node scripts/test-coldstart.js
 */
const { chatWithSeva } = require('../services/aiService');

const MSG = "What tasks do I have today?";

(async () => {
  console.log('=== Cold-Start Diagnostic Test ===');
  console.log(`Message: "${MSG}"\n`);

  console.log('--- Run 1 (cold model) ---');
  const t1 = Date.now();
  const r1 = await chatWithSeva(MSG, null);
  const e1 = ((Date.now() - t1) / 1000).toFixed(2);
  console.log(`Reply: "${r1.substring(0, 120)}${r1.length > 120 ? '...' : ''}"`);
  console.log(`⏱️  Run 1 time: ${e1}s\n`);

  console.log('--- Run 2 (warm model, same message) ---');
  const t2 = Date.now();
  const r2 = await chatWithSeva(MSG, null);
  const e2 = ((Date.now() - t2) / 1000).toFixed(2);
  console.log(`Reply: "${r2.substring(0, 120)}${r2.length > 120 ? '...' : ''}"`);
  console.log(`⏱️  Run 2 time: ${e2}s\n`);

  console.log(`VERDICT: Cold=${e1}s  Warm=${e2}s  Ratio=${(parseFloat(e1)/parseFloat(e2)).toFixed(1)}x`);
  process.exit(0);
})();
