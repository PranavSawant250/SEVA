require('dotenv').config();
console.log('key set:', !!process.env.GEMINI_API_KEY, '| model:', process.env.GEMINI_MODEL);
const { GoogleGenAI } = require('@google/genai');

(async () => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    contents: 'Reply with exactly: SEVA connected',
  });
  console.log(res.text);
})().catch(e => console.error(e.stack));