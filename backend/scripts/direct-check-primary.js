require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function checkPrimary() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const modelId = 'gemini-3.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  console.log(`Sending direct HTTP POST to: models/${modelId}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Respond with exactly: PING_OK' }] }]
      })
    });
    console.log(`HTTP Status: ${res.status} ${res.statusText}`);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data).slice(0, 300));
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

checkPrimary();

