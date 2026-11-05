const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { GoogleGenAI } = require('@google/genai');

async function diagnose() {
  const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';
  const modelName = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  console.log('=== GEMINI API DIAGNOSTIC ===');
  console.log('API Key Present:', !!apiKey, 'Length:', apiKey.length, 'Prefix:', apiKey.substring(0, 6) + '...');
  console.log('Target Model:', modelName);

  const ai = new GoogleGenAI({ apiKey });
  const start = Date.now();

  try {
    const res = await ai.models.generateContent({
      model: modelName,
      contents: 'Hello, please respond with OK.'
    });
    console.log('SUCCESS! Elapsed:', Date.now() - start, 'ms');
    console.log('Response text:', res.text);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log('FAILED! Elapsed:', elapsed, 'ms');
    console.log('HTTP Status:', err.status);
    console.log('Error Code:', err.code);
    console.log('Error Name:', err.name);
    console.log('Error Message:', err.message);
    if (err.errorDetails) {
      console.log('Error Details:', JSON.stringify(err.errorDetails, null, 2));
    }
    if (err.response) {
      console.log('Response Headers:', err.response.headers);
    }
    // Inspect full error properties
    console.log('All error keys:', Object.keys(err));
    try {
      console.log('Full JSON:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    } catch (_) {}
  }
}

diagnose();

