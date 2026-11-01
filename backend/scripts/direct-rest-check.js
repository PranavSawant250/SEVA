require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function directCheck() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const modelId = 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  console.log(`Sending direct HTTP POST to: models/${modelId}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Respond with exactly: VERIFIED' }] }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    console.log(`HTTP Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log('Response Body:', text);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Fetch error:', err.name, err.message);
  }
}

directCheck();

