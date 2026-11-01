require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { GoogleGenAI } = require('@google/genai');

async function check() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const ai = new GoogleGenAI({ apiKey });

  console.log('--- Checking model list from Gemini API ---');
  try {
    const pager = await ai.models.list();
    const list = [];
    for await (const m of pager) {
      list.push(m.name);
    }
    console.log('Total models available:', list.length);
    const flashModels = list.filter(m => m.includes('flash') || m.includes('2.5') || m.includes('1.5') || m.includes('gemini'));
    console.log('Relevant Models:', flashModels);
  } catch (err) {
    console.error('List error:', err.message);
  }

  console.log('\n--- Checking direct call to gemini-3.8-flash ---');
  const target = 'gemini-3.8-flash';
  try {
    const res = await ai.models.generateContent({
      model: target,
      contents: [{ role: 'user', parts: [{ text: 'Respond with exactly: VERIFIED_OK' }] }]
    });
    console.log(`Call to ${target} succeeded! Response: "${res.text?.trim()}"`);
  } catch (err) {
    console.error(`Call to ${target} failed:`, err.status, err.message);
  }

  console.log('\n--- Checking tool calling on gemini-3.8-flash ---');
  try {
    const { getGeminiFunctionDeclarations } = require('../services/chatTools');
    const tools = [{ functionDeclarations: getGeminiFunctionDeclarations() }];
    const resTool = await ai.models.generateContent({
      model: target,
      contents: [{ role: 'user', parts: [{ text: 'Log 2 LeetCode problems completed today' }] }],
      config: { tools, temperature: 0.1 }
    });
    console.log(`Tool calling to ${target} succeeded! Function calls:`, JSON.stringify(resTool.functionCalls));
  } catch (err) {
    console.error(`Tool calling to ${target} failed:`, err.status, err.message);
  }
}

check();
