/**
 * backend/scripts/test-model-ids.js
 * Call each pinned model ID once and show success or exact error.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { GoogleGenAI } = require('@google/genai');

async function testModel(apiKey, modelId) {
  process.stdout.write(`Testing model "${modelId}"... `);
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts: [{ text: 'Respond with exactly: OK' }] }]
    });
    const text = response.text ? response.text.trim() : JSON.stringify(response);
    console.log(`SUCCESS: "${text}"`);
    return { modelId, success: true, text };
  } catch (err) {
    console.log(`ERROR: [status: ${err.status}] ${err.message}`);
    return { modelId, success: false, error: err.message, status: err.status };
  }
}

async function run() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in backend/.env');
    process.exit(1);
  }

  const modelsToTest = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ];

  console.log('=== Pinned Model IDs Live Call Test ===');
  for (const m of modelsToTest) {
    await testModel(apiKey, m);
  }
}

run();

