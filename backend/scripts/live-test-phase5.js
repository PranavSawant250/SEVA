const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');

async function runPhase5LiveTests() {
  const today = getTodayDate();
  console.log('====================================================');
  console.log(`LIVE TESTING SEQUENCE — PHASE 5 (Date: ${today})`);
  console.log('====================================================\n');

  // TEST 1: POST /api/chat/message (Ask about plan)
  console.log('----------------------------------------------------');
  console.log('1. POST http://localhost:3001/api/chat/message');
  console.log('   Body: { "message": "What is my plan for today?" }');
  console.log('----------------------------------------------------');
  const chatRes1 = await fetch('http://localhost:3001/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What is my plan for today?' })
  });
  const chatData1 = await chatRes1.json();
  console.log('HTTP Status:', chatRes1.status);
  console.log('Raw Response:', JSON.stringify(chatData1, null, 2));

  // TEST 2: POST /api/chat/message (Conversational command test — must NOT alter plan)
  console.log('\n----------------------------------------------------');
  console.log('2. POST http://localhost:3001/api/chat/message');
  console.log('   Body: { "message": "Replan my day, I have a surprise meeting now" }');
  console.log('----------------------------------------------------');
  const chatRes2 = await fetch('http://localhost:3001/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Replan my day, I have a surprise meeting now' })
  });
  const chatData2 = await chatRes2.json();
  console.log('HTTP Status:', chatRes2.status);
  console.log('Raw Response:', JSON.stringify(chatData2, null, 2));

  console.log('\n   Checking GET /api/plan/today to confirm plan is UNCHANGED...');
  const planCheckRes = await fetch('http://localhost:3001/api/plan/today');
  const planCheckData = await planCheckRes.json();
  console.log('Plan Count:', planCheckData.count, '| Plan Unchanged:', JSON.stringify(planCheckData.plan, null, 2));

  // TEST 3: GET /api/chat/history
  console.log('\n----------------------------------------------------');
  console.log('3. GET http://localhost:3001/api/chat/history');
  console.log('----------------------------------------------------');
  const historyRes = await fetch('http://localhost:3001/api/chat/history');
  const historyData = await historyRes.json();
  console.log('HTTP Status:', historyRes.status);
  console.log('Raw Response:', JSON.stringify(historyData, null, 2));

  // TEST 4: Mark task complete & check plan status
  console.log('\n----------------------------------------------------');
  console.log('4. Marking task complete & verifying plan status...');
  console.log('----------------------------------------------------');
  const tasksBefore = db.prepare("SELECT id, name, completed FROM tasks WHERE date = ?").all(today);
  console.log('Tasks before mark:', JSON.stringify(tasksBefore, null, 2));

  if (tasksBefore.length > 0) {
    const targetTaskId = tasksBefore[0].id;
    const patchRes = await fetch(`http://localhost:3001/api/tasks/${targetTaskId}/complete`, { method: 'PATCH' });
    const patchData = await patchRes.json();
    console.log(`PATCH /api/tasks/${targetTaskId}/complete HTTP Status:`, patchRes.status, '| Response:', JSON.stringify(patchData, null, 2));
  }

  // Ensure at least one missed task remains for today to test carry-forward
  const incompleteCheck = db.prepare("SELECT id FROM tasks WHERE date = ? AND completed = 0").all(today);
  if (incompleteCheck.length === 0) {
    db.prepare("INSERT INTO tasks (name, priority, time_slot, source, completed, date) VALUES ('Prepare project presentation', 'high', '5:00 PM', 'manual', 0, ?)").run(today);
    console.log('Inserted high-priority incomplete task for today to test carry-forward.');
  }

  // TEST 5: GET /api/summary/generate
  console.log('\n----------------------------------------------------');
  console.log('5. GET http://localhost:3001/api/summary/generate');
  console.log('----------------------------------------------------');
  const sumGenRes = await fetch('http://localhost:3001/api/summary/generate');
  const sumGenData = await sumGenRes.json();
  console.log('HTTP Status:', sumGenRes.status);
  console.log('Raw Response:', JSON.stringify(sumGenData, null, 2));

  // TEST 6: SQLite check for carried-forward task rows
  console.log('\n----------------------------------------------------');
  console.log('6. SQLite query on tasks for carry_forward = 1 ...');
  console.log("SELECT id, name, date, source, carry_forward FROM tasks WHERE carry_forward = 1;");
  console.log('----------------------------------------------------');
  const cfRows = db.prepare("SELECT id, name, date, source, carry_forward FROM tasks WHERE carry_forward = 1;").all();
  console.log('Carried Forward Task Rows in DB:', JSON.stringify(cfRows, null, 2));

  // TEST 7: GET /api/summary/generate AGAIN (Idempotency / UPSERT test)
  console.log('\n----------------------------------------------------');
  console.log('7. GET http://localhost:3001/api/summary/generate AGAIN (Idempotency test)...');
  console.log('----------------------------------------------------');
  const sumGenRes2 = await fetch('http://localhost:3001/api/summary/generate');
  const sumGenData2 = await sumGenRes2.json();
  console.log('HTTP Status:', sumGenRes2.status);
  
  const nsRows = db.prepare("SELECT id, date, streak FROM night_summary WHERE date = ?;").all(today);
  console.log(`night_summary rows for '${today}':`, JSON.stringify(nsRows, null, 2));
  console.log('Row Count for today:', nsRows.length, '(Expected: 1)');

  // TEST 8: GET /api/summary/history
  console.log('\n----------------------------------------------------');
  console.log('8. GET http://localhost:3001/api/summary/history');
  console.log('----------------------------------------------------');
  const sumHistRes = await fetch('http://localhost:3001/api/summary/history');
  const sumHistData = await sumHistRes.json();
  console.log('HTTP Status:', sumHistRes.status);
  console.log('Raw Response:', JSON.stringify(sumHistData, null, 2));

  console.log('\n====================================================');
  console.log('✅ PHASE 5 LIVE TESTING COMPLETE.');
  console.log('====================================================');
}

runPhase5LiveTests().catch(err => {
  console.error('❌ Live test failed:', err);
});
