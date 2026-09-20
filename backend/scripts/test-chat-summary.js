/**
 * test-chat-summary.js — Standalone Phase 5 test script
 *
 * Tests chatWithSeva() and generateNightSummary() core functions.
 *
 * Run from backend folder:
 *   node scripts/test-chat-summary.js
 */

const { chatWithSeva } = require('../services/aiService');
const { generateNightSummary } = require('../services/summaryService');
const { getTodayDate } = require('../utils/dateUtils');
const db = require('../database/db');

async function main() {
  const today = getTodayDate();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     SEVA Phase 5 — Chat & Summary Test (test-chat-summary) ║');
  console.log(`║     Date: ${today.padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ─────────────────────────────────────────────────────────────
  // 1. CHAT TESTS (3 Scenarios)
  // ─────────────────────────────────────────────────────────────
  console.log('====================================================');
  console.log('PART 1: CHAT WITH SEVA (chatWithSeva)');
  console.log('====================================================\n');

  // Scenario A: Asking about today's plan
  console.log('----------------------------------------------------');
  console.log('Scenario A: Asking about today\'s plan');
  console.log('Prompt: "What is my plan for today?"');
  console.log('----------------------------------------------------');
  const responseA = await chatWithSeva('What is my plan for today?');
  console.log('SEVA Output:\n', responseA);

  // Scenario B: Conversational / unrelated prompt
  console.log('\n----------------------------------------------------');
  console.log('Scenario B: Conversational & unrelated prompt');
  console.log('Prompt: "How are you?"');
  console.log('----------------------------------------------------');
  const responseB = await chatWithSeva('How are you?');
  console.log('SEVA Output:\n', responseB);

  // Scenario C: Anti-Hallucination prompt (asking about non-existent 5 PM meeting)
  console.log('\n----------------------------------------------------');
  console.log('Scenario C: Anti-Hallucination check');
  console.log('Prompt: "What\'s my 5 PM meeting about?"');
  console.log('----------------------------------------------------');
  const responseC = await chatWithSeva("What's my 5 PM meeting about?");
  console.log('SEVA Output:\n', responseC);

  // ─────────────────────────────────────────────────────────────
  // 2. NIGHT SUMMARY TEST
  // ─────────────────────────────────────────────────────────────
  console.log('\n====================================================');
  console.log('PART 2: NIGHT SUMMARY GENERATION (generateNightSummary)');
  console.log('====================================================\n');

  // Ensure at least one completed and one missed task exists for today to test summary analytics
  const existingTasks = db.prepare("SELECT * FROM tasks WHERE date = ?").all(today);
  if (existingTasks.length === 0) {
    db.prepare("INSERT INTO tasks (name, priority, time_slot, source, completed, date) VALUES ('Complete Phase 5 backend tests', 'high', '10:00 AM', 'manual', 1, ?)").run(today);
    db.prepare("INSERT INTO tasks (name, priority, time_slot, source, completed, date) VALUES ('Review textbook Chapter 4', 'medium', '4:00 PM', 'manual', 0, ?)").run(today);
    console.log('Inserted sample completed & missed tasks for today\'s date:', today);
  }

  const summary = await generateNightSummary();
  console.log('\n📋 GENERATED NIGHT SUMMARY OBJECT:');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n' + '═'.repeat(60));
  console.log('✅ Phase 5 Standalone Test Script Complete.');
  console.log('═'.repeat(60));
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test script crashed:', err);
  process.exit(1);
});
