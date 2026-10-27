/**
 * Step 3 test script — Daily window endpoints and chat commands
 * Run: node scripts/test-step3.js
 */
const http = require('http');
const BASE = 'http://localhost:3001';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3001, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(raw) }); } catch { resolve({ s: res.statusCode, b: raw }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const chat = msg => req('POST', '/api/chat/message', { message: msg });
const getToday = () => req('GET', '/api/settings/today');
const putToday = body => req('PUT', '/api/settings/today', body);
const getPrefs = () => req('GET', '/api/settings/preferences');
const putPrefs = body => req('PUT', '/api/settings/preferences', body);

async function run() {
  console.log('=== STEP 3 TESTS — DAILY WINDOW ===\n');
  await new Promise(r => setTimeout(r, 300));

  // 3-1: GET window when nothing set
  console.log('--- 3-1: GET /api/settings/today (no window set) ---');
  const r31 = await getToday();
  console.log(`Status: ${r31.s}`, JSON.stringify(r31.b, null, 2));

  // 3-2: Set window via "free till" chat command
  console.log('\n--- 3-2: Chat "free till 9 PM" ---');
  const r32 = await chat('free till 9 PM');
  console.log(`${r32.b.reply}`);

  console.log('\n--- 3-3: GET /api/settings/today after "free till 9 PM" ---');
  const r33 = await getToday();
  console.log(JSON.stringify(r33.b, null, 2));

  // 3-4: "I have 4 hours" — absolute end computed from now
  console.log('\n--- 3-4: Chat "I have 4 hours" ---');
  const r34 = await chat('I have 4 hours');
  console.log(r34.b.reply);

  // 3-5: "I have 90 minutes"
  console.log('\n--- 3-5: Chat "I have 90 minutes" ---');
  const r35 = await chat('I have 90 minutes');
  console.log(r35.b.reply);

  // 3-6: Bad input — "free till banana"
  console.log('\n--- 3-6: Chat "free till banana" (should NOT crash or misparse) ---');
  const r36 = await chat('free till banana');
  console.log(`handled_by: ${r36.b.handled_by} | reply: ${r36.b.reply}`);

  // 3-7: "done for today"
  console.log('\n--- 3-7: Chat "done for today" ---');
  const r37 = await chat('done for today');
  console.log(r37.b.reply);
  const r37b = await getToday();
  console.log(`done_for_day: ${r37b.b.done_for_day}`);

  // 3-8: PUT /api/settings/today with window_end_time
  console.log('\n--- 3-8: PUT /api/settings/today {window_end_time: "10:00 PM"} ---');
  const r38 = await putToday({ window_end_time: '10:00 PM' });
  console.log(`Status: ${r38.s}`, JSON.stringify(r38.b));

  // 3-9: PUT /api/settings/preferences — update neglect_days
  console.log('\n--- 3-9: PUT /api/settings/preferences {neglect_days: 5} ---');
  const r39 = await putPrefs({ neglect_days: 5 });
  console.log(`Status: ${r39.s}`, JSON.stringify(r39.b.updated));

  // 3-10: GET preferences
  console.log('\n--- 3-10: GET /api/settings/preferences ---');
  const r310 = await getPrefs();
  console.log(JSON.stringify(r310.b.preferences, null, 2));

  // 3-11: "free until 10:30 pm" variant
  console.log('\n--- 3-11: Chat "free until 10:30 pm" ---');
  const r311 = await chat('free until 10:30 pm');
  console.log(r311.b.reply);

  // 3-12: Bad number — "I have 999 hours"
  console.log('\n--- 3-12: Chat "I have 999 hours" (out of range) ---');
  const r312 = await chat('I have 999 hours');
  console.log(`handled_by: ${r312.b.handled_by} | reply: ${r312.b.reply}`);

  console.log('\n=== STEP 3 TESTS COMPLETE ===');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
