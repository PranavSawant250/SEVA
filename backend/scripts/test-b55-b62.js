const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const os = require('os');
const fs = require('fs');

const liveDbPath = path.resolve(__dirname, '../seva.db');
const tempDbPath = path.join(os.tmpdir(), `seva-b55-b62-${Date.now()}.db`);
fs.copyFileSync(liveDbPath, tempDbPath);
process.env.SEVA_DB_PATH = tempDbPath;

const { processAgentChatMessage } = require('../services/chatAgent');
const db = require('../database/db');

const ITEMS = [
  { id: 'B.55', message: 'aaj ka kya schedule hai?', expectedTool: 'get_today_plan' },
  { id: 'B.56', message: 'do LeetCode questions solve kar liye maine', expectedTool: 'log_goal_progress' },
  { id: 'B.57', message: 'kal subah 8 baje German exam study add kar do', expectedTool: 'add_task' },
  { id: 'B.58', message: 'DSA practice task complete ho gaya', expectedTool: 'complete_task' },
  {
    id: 'B.59',
    history: [
      { role: 'user', message: 'What tasks do I have today?' },
      { role: 'assistant', message: 'You have: 1. DSA practice (high priority, 60m)' }
    ],
    message: 'I finished that task',
    expectedTool: 'complete_task'
  },
  {
    id: 'B.60',
    history: [
      { role: 'user', message: 'Show me my coding goals' },
      { role: 'assistant', message: '1. LeetCode 320 (progress: 10/40), 2. Trees (step BFS)' }
    ],
    message: 'I solved 2 problems for the first goal',
    expectedTool: 'log_goal_progress'
  },
  { id: 'B.61', message: 'Update task', expectedTool: 'ask_user' },
  { id: 'B.62', message: 'Log some progress on my goals', expectedTool: 'ask_user' }
];

async function runB55ToB62() {
  const testDate = new Date('2026-11-01T14:00:00Z');
  let pass = 0;
  for (const item of ITEMS) {
    const res = await processAgentChatMessage(item.message, {
      todayDate: testDate,
      nowDate: testDate,
      messageId: `test-${item.id}-${Date.now()}`,
      history: item.history || [],
      db
    });
    const tools = (res && res.actions) ? res.actions.map(a => a.tool) : [];
    const isPass = tools.includes(item.expectedTool);
    if (isPass) pass++;
    console.log(`[${item.id}] "${item.message}" -> Expected: ${item.expectedTool} | Got: ${JSON.stringify(tools)} -> ${isPass ? 'PASS' : 'FAIL'}`);
    await new Promise(r => setTimeout(r, 4200));
  }
  console.log(`\nResult: ${pass} / ${ITEMS.length} passed.`);
}

runB55ToB62().catch(console.error);

