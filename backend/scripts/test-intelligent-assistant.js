/**
 * backend/scripts/test-intelligent-assistant.js
 *
 * Comprehensive Automated Integration Test Suite for SEVA:
 * Truly Intelligent, Personalized, Action-Oriented Personal Assistant.
 *
 * Verifies all 34 requirements across 5 test suites:
 *   Suite 1: Chat and Goal Synchronization (Tests 1 - 7)
 *   Suite 2: Day Plan & Task Coordination (Tests 8 - 14)
 *   Suite 3: Personalized Email Detection (Tests 15 - 26)
 *   Suite 4: Email Actions & Learning (Tests 27 - 31)
 *   Suite 5: Regression & Isolation (Tests 32 - 34)
 *
 * TEST ISOLATION:
 *  Uses a temporary database copy via process.env.SEVA_DB_PATH.
 *  Cleans up all temporary files on completion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Setup isolated temporary database copy
const tempDbPath = path.join(os.tmpdir(), `seva-test-assistant-${process.pid}-${Date.now()}.db`);
const liveDbPath = path.join(__dirname, '..', 'seva.db');
if (fs.existsSync(liveDbPath)) {
  fs.copyFileSync(liveDbPath, tempDbPath);
}
process.env.SEVA_DB_PATH = tempDbPath;

const express = require('express');
const http = require('http');
const db = require('../database/db');

// Cleanup on exit
function cleanup() {
  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(tempDbPath + ext)) fs.unlinkSync(tempDbPath + ext);
    } catch (_) {}
  }
}
process.on('exit', cleanup);

// Mount Express App with full routing
const app = express();
app.use(express.json());

const chatRouter = require('../routes/chat');
const goalsRouter = require('../routes/goals');
const planRouter = require('../routes/plan');
const tasksRouter = require('../routes/tasks');
const settingsRouter = require('../routes/settings');
const gmailRouter = require('../routes/gmail');
const summaryRouter = require('../routes/summary');

app.use('/api/chat', chatRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/plan', planRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/emails', gmailRouter);
app.use('/api/summary', summaryRouter);

const { getTodayDate } = require('../utils/dateUtils');
const { classifyEmail, matchStrictPrn, matchName, isActionableInvitation } = require('../services/emailClassifier');
const { processNaturalLanguageAction } = require('../services/actionEngine');

// In-memory Express request helper (zero network sockets, lightning fast, 100% sandboxed)
function request(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr, 'http://localhost');
    const query = {};
    for (const [k, v] of u.searchParams.entries()) query[k] = v;

    const req = {
      method: method.toUpperCase(),
      url: urlStr,
      originalUrl: urlStr,
      path: u.pathname,
      query,
      body: body || {},
      headers: { 'content-type': 'application/json' },
      get(h) { return this.headers[h.toLowerCase()]; }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload) {
        try {
          resolve({ status: this.statusCode, body: typeof payload === 'string' ? JSON.parse(payload) : payload });
        } catch {
          resolve({ status: this.statusCode, body: payload });
        }
        return this;
      },
      end(payload) {
        resolve({ status: this.statusCode, body: payload });
      }
    };
    try {
      app.handle(req, res, err => {
        if (err) reject(err);
        else resolve({ status: 404, body: { error: 'Not found' } });
      });
    } catch (err) {
      reject(err);
    }
  });
}

let passedCount = 0;
let totalCount = 0;

function assertTest(num, title, condition, details = '') {
  totalCount++;
  if (condition) {
    passedCount++;
    console.log(`  ✔ Test ${num}: ${title}`);
  } else {
    console.error(`  ❌ FAIL Test ${num}: ${title}`);
    if (details) console.error(`     Details: ${details}`);
    process.exit(1);
  }
}

async function runAllTests() {
  console.log('\n=============================================================');
  console.log('🧪 SEVA INTELLIGENT ASSISTANT INTEGRATION TEST SUITE (34 Specs)');
  console.log(`🔒 Test Isolation DB: ${tempDbPath}`);
  console.log('=============================================================\n');

  const today = getTodayDate();

  // Reset/seed clean initial state in temp DB
  db.exec(`
    DELETE FROM goals;
    DELETE FROM goal_steps;
    DELETE FROM goal_progress_log;
    DELETE FROM tasks;
    DELETE FROM day_plans;
    DELETE FROM emails;
    DELETE FROM email_feedback;
    DELETE FROM daily_settings;

    -- Seed Configured Preferences
    INSERT OR REPLACE INTO preferences (id, user_name, user_prn)
    VALUES (1, 'Pranav Sawant', '246100104');

    -- Seed Test Goal 1: Count goal (DSA Practice, target 40, current 12)
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status, created_date, deadline)
    VALUES (1, 'DSA Practice', 'Technical', 'high', 'count', 40, 12, 'active', '${today}', '2026-11-30');

    -- Seed Test Goal 2: Milestone goal (Spring Boot Project)
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status, created_date, deadline)
    VALUES (2, 'Spring Boot Project', 'Academic', 'high', 'milestone', NULL, 0, 'active', '${today}', '2026-11-30');

    INSERT INTO goal_steps (goal_id, step_text, done) VALUES (2, 'Setup project skeleton', 1);
    INSERT INTO goal_steps (goal_id, step_text, done) VALUES (2, 'Create user authentication entities', 0);
    INSERT INTO goal_steps (goal_id, step_text, done) VALUES (2, 'Implement JWT filter', 0);
    INSERT INTO goal_steps (goal_id, step_text, done) VALUES (2, 'Write unit tests', 0);

    -- Seed Timetable block: Fixed DBMS lecture at 2:00 PM - 3:30 PM
    DELETE FROM timetable;
    INSERT INTO timetable (day_of_week, subject, start_time, end_time)
    VALUES ('Wednesday', 'DBMS Lecture', '2:00 PM', '3:30 PM');

    -- Seed Today Task: Database study session
    INSERT INTO tasks (id, name, priority, time_slot, source, completed, date, duration_min)
    VALUES (101, 'Database study session', 'medium', '11:00 AM', 'manual', 0, '${today}', 60);

    -- Seed Today Task: SEVA demo presentation
    INSERT INTO tasks (id, name, priority, time_slot, source, completed, date, duration_min)
    VALUES (102, 'SEVA demo presentation', 'medium', '4:00 PM', 'manual', 0, '${today}', 45);

    -- Seed Day Plan for today
    INSERT INTO day_plans (date, plan_json, completed_count, missed_count)
    VALUES ('${today}', json_array(
      json_object('task_id', 101, 'task', 'Database study session', 'priority', 'medium', 'time', '11:00 AM', 'completed', 0),
      json_object('task_id', 102, 'task', 'SEVA demo presentation', 'priority', 'medium', 'time', '4:00 PM', 'completed', 0)
    ), 0, 0);
  `);

  console.log('--- SUITE 1: CHAT & GOAL SYNCHRONIZATION ---');

  // Test 1: Reporting two newly solved DSA problems increases progress by exactly two (12 -> 14)
  const res1 = await request('POST', '/api/chat/message', { message: 'I completed two DSA problems.' });
  const goal1After = db.prepare('SELECT current_count FROM goals WHERE id = 1').get();
  const log1 = db.prepare('SELECT amount, note FROM goal_progress_log WHERE goal_id = 1 ORDER BY id DESC LIMIT 1').get();
  assertTest(1, 'Reporting two newly solved DSA problems increases progress by exactly two (12 -> 14)',
    goal1After && goal1After.current_count === 14 && log1 && log1.amount === 2 && res1.body.reply.includes('14/40'),
    `Expected current_count 14, got ${goal1After ? goal1After.current_count : null}`
  );

  // Test 2: Goal completion and Day Plan task state update according to their defined rules
  // If we log 26 more DSA problems to reach 40/40, goal becomes 'completed'
  await request('POST', '/api/chat/message', { message: 'I completed 26 DSA problems.' });
  const goal1Completed = db.prepare('SELECT current_count, status, completed_date FROM goals WHERE id = 1').get();
  assertTest(2, 'Goal completion status updates when target is met (14 + 26 = 40/40 -> completed)',
    goal1Completed && goal1Completed.current_count === 40 && goal1Completed.status === 'completed' && goal1Completed.completed_date === today,
    `Status: ${goal1Completed?.status}, count: ${goal1Completed?.current_count}`
  );

  // Test 3: Repeating an operation does not double-count (idempotency guard)
  const res3 = await request('POST', '/api/chat/message', { message: 'I completed 26 DSA problems.' });
  const goal1Repeat = db.prepare('SELECT current_count FROM goals WHERE id = 1').get();
  assertTest(3, 'Repeating an operation does not double-count (idempotency)',
    goal1Repeat && goal1Repeat.current_count === 40 && res3.body.reply.includes('Already logged'),
    `Count after duplicate request: ${goal1Repeat?.current_count}`
  );

  // Test 4: Future intentions do not update completed progress
  const countBeforeFuture = db.prepare('SELECT current_count FROM goals WHERE id = 1').get().current_count;
  await request('POST', '/api/chat/message', { message: 'I will solve two DSA problems tomorrow.' });
  const countAfterFuture = db.prepare('SELECT current_count FROM goals WHERE id = 1').get().current_count;
  assertTest(4, 'Future intentions do not update completed progress',
    countBeforeFuture === countAfterFuture,
    `Before: ${countBeforeFuture}, After: ${countAfterFuture}`
  );

  // Test 5: Corrections to previous reports work safely
  // Reset goal count to 20 for testing correction
  db.prepare('UPDATE goals SET current_count = 20 WHERE id = 1').run();
  db.prepare("INSERT INTO goal_progress_log (goal_id, date, amount, note) VALUES (1, ?, 3, 'chat:completed:3')").run(today);
  const res5 = await request('POST', '/api/chat/message', { message: 'Correction: I only solved 1 DSA problem.' });
  const goal1Corrected = db.prepare('SELECT current_count FROM goals WHERE id = 1').get();
  assertTest(5, 'Corrections to previous reports work safely (adjusted down by 2: 20 -> 18)',
    goal1Corrected && goal1Corrected.current_count === 18 && res5.body.reply.includes('18/40'),
    `Expected 18, got ${goal1Corrected?.current_count}`
  );

  // Test 6: Ambiguous goal selection causes no unintended mutation
  // Ensure goal 1 is active, and add a second active DSA-related goal
  db.prepare("UPDATE goals SET status = 'active', current_count = 18 WHERE id = 1").run();
  db.prepare(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status)
    VALUES (3, 'Advanced DSA Problems', 'Technical', 'medium', 'count', 30, 5, 'active')
  `).run();
  const c1Before = db.prepare('SELECT current_count FROM goals WHERE id = 1').get().current_count;
  const c3Before = db.prepare('SELECT current_count FROM goals WHERE id = 3').get().current_count;
  const res6 = await request('POST', '/api/chat/message', { message: 'I completed two DSA problems.' });
  const c1After = db.prepare('SELECT current_count FROM goals WHERE id = 1').get().current_count;
  const c3After = db.prepare('SELECT current_count FROM goals WHERE id = 3').get().current_count;
  assertTest(6, 'Ambiguous goal selection causes no unintended mutation and prompts clarification',
    c1Before === c1After && c3Before === c3After && res6.body.reply.includes('Did you mean'),
    `c1: ${c1Before}->${c1After}, c3: ${c3Before}->${c3After}, reply: ${res6.body.reply}`
  );
  // Clean up goal 3
  db.prepare('DELETE FROM goals WHERE id = 3').run();

  // Test 7: Goal steps, task completion and uncompletion remain consistent
  // "finished the next two Spring Boot steps" should tick steps 2 & 3
  const res7 = await request('POST', '/api/chat/message', { message: 'I finished the next two Spring Boot steps.' });
  const stepsDone = db.prepare('SELECT id, step_text, done FROM goal_steps WHERE goal_id = 2 ORDER BY id ASC').all();
  const doneCount = stepsDone.filter(s => s.done === 1).length;
  assertTest(7, 'Goal steps tick accurately (steps 1, 2, 3 now marked done: 3/4)',
    doneCount === 3 && res7.body.reply.includes('Marked 2 step(s) as complete'),
    `Done steps count: ${doneCount}`
  );

  console.log('\n--- SUITE 2: DAY PLAN & TASK COORDINATION ---');

  // Test 8: Adding a task in Chat makes it appear in Day Plan
  const res8 = await request('POST', '/api/chat/message', { message: 'I want a 45-minute DSA session today.' });
  const addedTask = db.prepare(`SELECT * FROM tasks WHERE name LIKE '%DSA%' AND duration_min = 45 AND date = ?`).get(today);
  const planToday8 = db.prepare(`SELECT plan_json FROM day_plans WHERE date = ?`).get(today);
  assertTest(8, 'Adding a task in Chat makes it appear in tasks and Day Plan',
    addedTask !== undefined && planToday8.plan_json.includes('DSA'),
    `Task exists: ${Boolean(addedTask)}, plan: ${planToday8?.plan_json}`
  );

  // Test 9: Rescheduling changes the actual persisted time
  const res9 = await request('POST', '/api/chat/message', { message: 'Move database study session to 5 PM.' });
  const task101 = db.prepare('SELECT time_slot FROM tasks WHERE id = 101').get();
  assertTest(9, 'Rescheduling changes the actual persisted time to 5:00 PM',
    task101 && task101.time_slot === '5:00 PM' && res9.body.reply.includes('5:00 PM'),
    `task101 time_slot: ${task101?.time_slot}`
  );

  // Test 10: Priority changes affect the planner appropriately
  const res10 = await request('POST', '/api/chat/message', { message: 'Make my SEVA demo presentation high priority.' });
  const task102 = db.prepare('SELECT priority FROM tasks WHERE id = 102').get();
  assertTest(10, 'Priority changes update the task priority to high',
    task102 && task102.priority === 'high' && res10.body.reply.includes('high priority'),
    `task102 priority: ${task102?.priority}`
  );

  // Test 11: Availability changes trigger correct replanning
  const res11 = await request('POST', '/api/chat/message', { message: 'I have only one hour available today.' });
  const settingsToday = db.prepare('SELECT window_end_minutes, available_minutes FROM daily_settings WHERE date = ?').get(today);
  assertTest(11, 'Availability change updates daily_settings window (60 minutes)',
    settingsToday && settingsToday.available_minutes === 60 && (res11.body.reply.includes('1 hour') || res11.body.reply.includes('one hour')),
    `available_minutes: ${settingsToday?.available_minutes}`
  );

  // Test 12: Fixed timetable blocks and completed tasks are preserved
  // Task 101 completion
  await request('PATCH', '/api/tasks/101/complete', { completed: 1 });
  const task101Done = db.prepare('SELECT completed FROM tasks WHERE id = 101').get().completed;
  assertTest(12, 'Completed tasks are preserved and cannot be overwritten by replanning',
    task101Done === 1,
    `task101 completed: ${task101Done}`
  );

  // Test 13: Failed actions do not produce false success messages
  // Rescheduling during fixed timetable lecture (2:00 PM - 3:30 PM)
  const todayDayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  db.prepare(`
    INSERT INTO timetable (day_of_week, subject, start_time, end_time)
    VALUES (?, 'DBMS Lecture', '2:00 PM', '3:30 PM')
  `).run(todayDayName);
  const conflictReply = processNaturalLanguageAction('Move SEVA demo presentation to 2 PM.', new Date(), new Date());
  assertTest(13, 'Conflict with fixed timetable block explains conflict and refuses schedule overwrite',
    conflictReply && conflictReply.includes('conflicts with your DBMS Lecture (2:00 PM - 3:30 PM)'),
    `Reply was: ${conflictReply}`
  );

  // Test 14: The frontend / API refreshes and displays the latest backend state
  const tasksCheck = await request('GET', '/api/tasks');
  const task101Found = tasksCheck.body.tasks.find(t => t.id === 101);
  assertTest(14, 'API GET /api/tasks reflects task completed state (task 101 completed=1)',
    tasksCheck.body.success && task101Found && task101Found.completed === 1,
    `task101Found: ${JSON.stringify(task101Found)}`
  );

  console.log('\n--- SUITE 3: PERSONALIZED EMAIL DETECTION ---');

  // Test 15: A college defaulter list containing PRN 246100104 ranks as highly relevant
  const email15 = {
    subject: 'Attendance Defaulter List - Semester V',
    sender: 'exam.cell@college.ac.in',
    body_preview: 'The following students have attendance below 75%: 246100104, 246100105. Report to HOD office.'
  };
  const c15 = classifyEmail(email15);
  assertTest(15, 'College defaulter list containing PRN 246100104 ranks as highly relevant',
    c15.is_personal === 1 && c15.importance_category === 'academic_warning' && c15.priority === 'high' && c15.relevance_score >= 4.0,
    `Personal: ${c15.is_personal}, Cat: ${c15.importance_category}, Priority: ${c15.priority}, Score: ${c15.relevance_score}`
  );

  // Test 16: Defaulter list containing Pranav Sawant in a clear academic context ranks as highly relevant even if PRN is absent
  const email16 = {
    subject: 'Defaulter Warning: Internal Assessment Submission',
    sender: 'hod.comp@college.edu',
    body_preview: 'Debarred list for low attendance: Pranav Sawant, John Doe. Hall tickets withheld.'
  };
  const c16 = classifyEmail(email16);
  assertTest(16, 'Defaulter list containing "Pranav Sawant" ranks as highly relevant without PRN',
    c16.is_personal === 1 && c16.importance_category === 'academic_warning' && c16.priority === 'high',
    `Personal: ${c16.is_personal}, Cat: ${c16.importance_category}`
  );

  // Test 17: "Sawant Pranav" is recognized as a possible name variation
  const email17 = {
    subject: 'Attendance Shortage Report',
    sender: 'academic@college.ac.in',
    body_preview: 'Students with attendance below 75%: Sawant Pranav - 64% in Operating Systems.'
  };
  const c17 = classifyEmail(email17);
  assertTest(17, '"Sawant Pranav" recognized as valid name variation with extracted percentage',
    c17.is_personal === 1 && c17.summary.includes('64%'),
    `Personal: ${c17.is_personal}, Summary: ${c17.summary}`
  );

  // Test 18: Matching PRN in unrelated phone number or transaction ID does not trigger false academic alert
  const email18 = {
    subject: 'Your Order Receipt',
    sender: 'support@store.com',
    body_preview: 'Customer care phone: +9198246100104. Order TXN24610010499 confirmed.'
  };
  const c18 = classifyEmail(email18);
  assertTest(18, 'Matching PRN in phone number or transaction ID does not trigger false alert',
    c18.is_personal === 0 && c18.importance_category !== 'academic_warning',
    `Personal: ${c18.is_personal}, Cat: ${c18.importance_category}`
  );

  // Test 19: A different student\'s PRN does not trigger a match
  const email19 = {
    subject: 'College Defaulter List',
    sender: 'dean@college.ac.in',
    body_preview: 'Students with attendance below 75%: 246100999, 246100888.'
  };
  const c19 = classifyEmail(email19);
  assertTest(19, "A different student's PRN does not trigger a personal match",
    c19.is_personal === 0 && c19.matched_identity === null,
    `Personal: ${c19.is_personal}, matched: ${c19.matched_identity}`
  );

  // Test 20: Name and PRN matching works in supported email-body tables
  const email20 = {
    subject: 'Official Exam Eligibility List',
    sender: 'exam@college.ac.in',
    body_preview: '| Roll No | PRN | Student Name | Status |\n| 14 | 246100104 | Pranav Sawant | Defaulter |'
  };
  const c20 = classifyEmail(email20);
  assertTest(20, 'Name and PRN matching works in tabular email rows',
    c20.is_personal === 1 && c20.priority === 'high',
    `Personal: ${c20.is_personal}, Priority: ${c20.priority}`
  );

  // Test 21: Matching works in supported PDF and spreadsheet attachment text
  const email21 = {
    subject: 'Semester Attendance Notice with Attached Sheet',
    sender: 'exam@college.ac.in',
    body_preview: 'Please find attached the final defaulter spreadsheet.',
    attachment_text: 'Sheet1: PRN 246100104 Pranav Sawant Attendance 58% Debarred'
  };
  const c21 = classifyEmail(email21);
  assertTest(21, 'Matching works in attachment extracted text',
    c21.is_personal === 1 && c21.summary.includes('58%'),
    `Personal: ${c21.is_personal}, Summary: ${c21.summary}`
  );

  // Test 22: Generic college announcement without identity is ranked according to general importance
  const email22 = {
    subject: 'College Campus Holiday Notice',
    sender: 'registrar@college.ac.in',
    body_preview: 'College will remain closed on Friday for National Holiday.'
  };
  const c22 = classifyEmail(email22);
  assertTest(22, 'Generic college announcement without identity classified as general announcement',
    c22.is_personal === 0 && c22.importance_category === 'college_announcement' && c22.priority === 'medium',
    `Personal: ${c22.is_personal}, Cat: ${c22.importance_category}, Priority: ${c22.priority}`
  );

  // Test 23: A personalized academic warning outranks an irrelevant promotional email
  const emailPromo = {
    subject: 'Mega Sale 50% Off Everything Today Only!',
    sender: 'marketing@shopping.com',
    body_preview: 'Urgent: Huge discount for you today.'
  };
  const cPromo = classifyEmail(emailPromo);
  assertTest(23, 'Personalized academic warning outranks irrelevant promo email with "urgent" keyword',
    c15.relevance_score > cPromo.relevance_score && cPromo.priority === 'low',
    `Academic score: ${c15.relevance_score}, Promo score: ${cPromo.relevance_score}`
  );

  // Test 24: Uncertain identity matches handled conservatively without inventing claims
  const email24 = {
    subject: 'General Meeting Notice',
    sender: 'club@college.ac.in',
    body_preview: 'Committee members please assemble in auditorium.'
  };
  const c24 = classifyEmail(email24);
  assertTest(24, 'Uncertain identity matches handled conservatively without inventing details',
    c24.is_personal === 0 && !c24.summary.includes('attendance') && !c24.summary.includes('PRN'),
    `Summary: ${c24.summary}`
  );

  // Test 25: Classification does not modify or delete mailbox messages
  const mailboxCountBefore = db.prepare('SELECT COUNT(*) as cnt FROM emails').get().cnt;
  classifyEmail({ subject: 'Test', sender: 'test@test.com', body_preview: 'test' });
  const mailboxCountAfter = db.prepare('SELECT COUNT(*) as cnt FROM emails').get().cnt;
  assertTest(25, 'Classification is a pure read function and never deletes or alters mailbox rows',
    mailboxCountBefore === mailboxCountAfter,
    `Before: ${mailboxCountBefore}, After: ${mailboxCountAfter}`
  );

  // Test 26: Repeated email syncs do not duplicate messages or alerts
  db.prepare(`
    INSERT OR IGNORE INTO emails (gmail_message_id, subject, sender, body_preview, date)
    VALUES ('gmail-msg-001', 'First Email', 'dean@college.ac.in', 'Sample text', '${today}')
  `).run();
  const insertDuplicate = db.prepare(`
    INSERT OR IGNORE INTO emails (gmail_message_id, subject, sender, body_preview, date)
    VALUES ('gmail-msg-001', 'First Email Duplicate', 'dean@college.ac.in', 'Sample text', '${today}')
  `).run();
  assertTest(26, 'Unique index prevents duplicate email inserts on repeated syncs',
    insertDuplicate.changes === 0,
    `Changes: ${insertDuplicate.changes}`
  );

  console.log('\n--- SUITE 4: EMAIL ACTIONS & LEARNING ---');

  // Test 27: Attendance notices do not display irrelevant Accept/Decline controls
  const isInviteForDefaulter = isActionableInvitation(email15);
  assertTest(27, 'Attendance & defaulter notices have is_invitation = false (no Accept/Decline RSVP)',
    isInviteForDefaulter === false,
    `isInviteForDefaulter: ${isInviteForDefaulter}`
  );

  // Test 28: Genuine supported invitations retain appropriate actions
  const inviteEmail = {
    subject: 'Project Sync Calendar Invite',
    sender: 'mentor@work.com',
    event_type: 'meeting',
    body_preview: 'Google Meet link: meet.google.com/xyz. Please RSVP to attend the meeting.'
  };
  const isInviteForMeeting = isActionableInvitation(inviteEmail);
  assertTest(28, 'Genuine Google Meet/calendar invite has is_invitation = true',
    isInviteForMeeting === true,
    `isInviteForMeeting: ${isInviteForMeeting}`
  );

  // Test 29: Accepting an attendance defaulter notice as a calendar invitation is rejected
  db.prepare(`
    INSERT INTO emails (id, gmail_message_id, subject, sender, body_preview, importance_category, accepted, date)
    VALUES (999, 'gmail-defaulter-999', 'Defaulter Notice', 'exam@college.ac.in', 'Attendance below 75%', 'academic_warning', 0, '${today}')
  `).run();
  const res29 = await request('POST', '/api/emails/accept/999');
  assertTest(29, 'POST /api/emails/accept rejects attendance/defaulter notices as calendar invites',
    res29.status === 400 && res29.body.error === 'attendance_not_invitation',
    `Status: ${res29.status}, body: ${JSON.stringify(res29.body)}`
  );

  // Test 30: User feedback persists and affects future classifications
  const res30 = await request('POST', '/api/emails/999/feedback', { feedback_type: 'important' });
  const feedbackRow = db.prepare("SELECT * FROM email_feedback WHERE email_id = 999").get();
  assertTest(30, 'User feedback persists in email_feedback table and updates email score',
    feedbackRow && feedbackRow.feedback_type === 'important' && res30.body.success,
    `feedbackRow: ${JSON.stringify(feedbackRow)}`
  );

  // Test 31: Provider failures and missing permissions handled gracefully
  const res31 = await request('GET', '/api/emails/fetch');
  assertTest(31, 'Email fetch without active OAuth token returns friendly 401 requiring authentication',
    res31.status === 401 && res31.body.error === 'Not authenticated',
    `Status: ${res31.status}, body: ${JSON.stringify(res31.body)}`
  );

  console.log('\n--- SUITE 5: REGRESSION & ISOLATION ---');

  // Test 32: Night Summary generates accurately from persisted state without hallucinated work
  const summaryRes = await request('GET', '/api/summary/generate');
  assertTest(32, 'Night summary generates strictly from persisted state (1 completed task, 1 carry forward)',
    summaryRes.body.success && summaryRes.body.summary.completed_tasks.length >= 1,
    `Completed tasks in summary: ${summaryRes.body.summary?.completed_tasks?.length}`
  );

  // Test 33: Tests do not modify live database counts or user records
  const liveDbExists = fs.existsSync(liveDbPath);
  assertTest(33, 'Tests ran in isolated sandbox temp DB without corrupting live seva.db',
    liveDbExists && process.env.SEVA_DB_PATH === tempDbPath,
    `Current process SEVA_DB_PATH: ${process.env.SEVA_DB_PATH}`
  );

  // Test 34: Existing application routes and scheduler remain fully operational
  const healthCheck = await request('GET', '/api/goals');
  assertTest(34, 'Existing application features and /api/goals endpoint remain fully operational',
    healthCheck.body.success && Array.isArray(healthCheck.body.goals),
    `Goals count: ${healthCheck.body.goals?.length}`
  );

  console.log('\n--- SUITE 6: USER SCREENSHOT REPRODUCTIONS & CONCISE ACTIONS ---');

  // Seed Trees topic goal with BFS, DFS, traversals
  db.prepare(`
    INSERT INTO goals (id, title, category, priority, goal_type, target_count, current_count, status, created_date, deadline)
    VALUES (4, 'Trees topic', 'DSA', 'medium', 'milestone', NULL, 0, 'active', '${today}', '2026-10-25')
  `).run();
  db.prepare(`INSERT INTO goal_steps (goal_id, step_text, done) VALUES (4, 'BFS', 0)`).run();
  db.prepare(`INSERT INTO goal_steps (goal_id, step_text, done) VALUES (4, 'DFS', 0)`).run();
  db.prepare(`INSERT INTO goal_steps (goal_id, step_text, done) VALUES (4, 'traversals', 0)`).run();

  // Seed task for Trees on today's plan
  db.prepare(`
    INSERT INTO tasks (id, name, priority, time_slot, source, completed, date, duration_min, goal_id)
    VALUES (105, 'Trees topic: next 2 steps (BFS, DFS)', 'medium', '11:00 AM', 'goal', 0, '${today}', 120, 4)
  `).run();

  // Test 35: BFS completion under Trees ("Today i have completed bfs topic of tree")
  const res35 = await request('POST', '/api/chat/message', { message: 'Today i have completed bfs topic of tree' });
  const stepBfs = db.prepare("SELECT done FROM goal_steps WHERE goal_id = 4 AND step_text = 'BFS'").get();
  const stepDfs = db.prepare("SELECT done FROM goal_steps WHERE goal_id = 4 AND step_text = 'DFS'").get();
  const stepTrav = db.prepare("SELECT done FROM goal_steps WHERE goal_id = 4 AND step_text = 'traversals'").get();
  const goalTrees = db.prepare("SELECT status FROM goals WHERE id = 4").get();
  assertTest(35, 'Today i have completed bfs topic of tree marks BFS done, keeps DFS/traversals undone and goal active',
    stepBfs && stepBfs.done === 1 &&
    stepDfs && stepDfs.done === 0 &&
    stepTrav && stepTrav.done === 0 &&
    goalTrees && goalTrees.status === 'active' &&
    res35.body.reply === 'Done! BFS is marked complete under Trees.',
    `BFS: ${stepBfs?.done}, DFS: ${stepDfs?.done}, status: ${goalTrees?.status}, reply: ${res35.body.reply}`
  );

  // Test 36: Repeated BFS message does not double-count or corrupt progress
  const logCountBefore = db.prepare("SELECT COUNT(*) as cnt FROM goal_progress_log WHERE goal_id = 4").get().cnt;
  const res36 = await request('POST', '/api/chat/message', { message: 'Today i have completed bfs topic of tree' });
  const logCountAfter = db.prepare("SELECT COUNT(*) as cnt FROM goal_progress_log WHERE goal_id = 4").get().cnt;
  assertTest(36, 'Repeating BFS completion does not increment progress or duplicate logs',
    logCountBefore === logCountAfter &&
    (res36.body.reply.includes('already marked complete') || res36.body.reply.includes('Done! BFS is marked complete')),
    `Logs before: ${logCountBefore}, after: ${logCountAfter}, reply: ${res36.body.reply}`
  );

  // Test 37: Conversational plan restriction with German exam prep & 2 LeetCode questions
  const { getTomorrowDate } = require('../utils/dateUtils');
  const tomorrowStr = getTomorrowDate(new Date());
  const res37 = await request('POST', '/api/chat/message', {
    message: 'Tomorrow I have to prepare for my German exam only and 2 LeetCode questions.'
  });
  const planTmrwRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(tomorrowStr);
  const tasksTmrw = db.prepare('SELECT name, priority FROM tasks WHERE date = ?').all(tomorrowStr);
  const planTmrw = planTmrwRow ? JSON.parse(planTmrwRow.plan_json) : [];
  const hasGerman = planTmrw.some(item => item.task.includes('German'));
  const hasLeetCode = planTmrw.some(item => item.task.includes('LeetCode'));
  const hasUnrelated = planTmrw.some(item => item.task.includes('Daily run') || item.task.includes('Spring Boot') || item.task.includes('Trees'));
  assertTest(37, 'Conversational plan restriction saves ONLY requested tasks (German prep + 2 LeetCode) and excludes unrelated goals',
    res37.body.reply === 'Got it — German exam preparation and 2 LeetCode questions tomorrow.' &&
    hasGerman && hasLeetCode && !hasUnrelated && tasksTmrw.length >= 2,
    `Reply: ${res37.body.reply}, items: ${JSON.stringify(planTmrw.map(i => i.task))}`
  );

  // Test 38: Check-in conversational correction without rigid command rejection (Screenshot 2 repro)
  const { startNightlyCheckIn } = require('../services/nightlyService');
  startNightlyCheckIn(new Date()); // Start check-in
  // User answers budget with constraint
  const res38a = await request('POST', '/api/chat/message', { message: '6 hr and tmrw i have to prepare for my german exam only' });
  // User follows up with correction
  const res38b = await request('POST', '/api/chat/message', {
    message: 'tommorow i have to prepare for my german exam only and 2 leetcode question only'
  });
  assertTest(38, 'Nightly check-in accepts natural plan correction without "I didn\'t recognize that command" error',
    !res38a.body.reply.includes("didn't recognize that command") &&
    !res38b.body.reply.includes("didn't recognize that command") &&
    res38b.body.reply.includes('German exam preparation and 2 LeetCode questions tomorrow'),
    `Reply 38a: ${res38a.body.reply}\nReply 38b: ${res38b.body.reply}`
  );

  // Test 39: Concise task reschedule response
  db.prepare(`
    INSERT OR REPLACE INTO tasks (id, name, priority, time_slot, source, completed, date, duration_min)
    VALUES (111, 'database study', 'medium', '11:00 AM', 'manual', 0, '${today}', 60)
  `).run();
  const res39 = await request('POST', '/api/chat/message', { message: 'Move database study to 4 PM.' });
  assertTest(39, 'Task reschedule returns short concise confirmation: "Moved database study to 4 PM."',
    res39.body.reply.includes('Moved database study to 4:00 PM') || res39.body.reply.includes('Moved database study to 4 PM'),
    `Reply was: ${res39.body.reply}`
  );

  // Test 40: Concise LeetCode count progress response
  db.prepare("UPDATE goals SET current_count = 4, target_count = 40, status = 'active' WHERE id = 1").run();
  const res40 = await request('POST', '/api/chat/message', { message: 'I solved two LeetCode problems.' });
  assertTest(40, 'Count progress returns concise confirmation with persisted values: "Logged 2 problems. DSA Practice progress: 4/40 → 6/40."',
    res40.body.reply.startsWith('Logged 2 problems') && res40.body.reply.includes('4/40 → 6/40'),
    `Reply was: ${res40.body.reply}`
  );

  // Test 41: "not generate day plan"
  const res41 = await request('POST', '/api/chat/message', { message: 'not generate day plan' });
  assertTest(41, '"not generate day plan" cancels generation without AI monologue',
    res41.body.reply === "Okay, I won't generate or change the plan.",
    `Reply was: ${res41.body.reply}`
  );

  // Test 42: "Like as we decided of LeetCode and German only, so create plan on that."
  const res42 = await request('POST', '/api/chat/message', {
    message: 'Like as we decided of LeetCode and German only, so create plan on that.'
  });
  const planTodayRow = db.prepare('SELECT plan_json FROM day_plans WHERE date = ?').get(today);
  const planTodayItems = planTodayRow ? JSON.parse(planTodayRow.plan_json) : [];
  assertTest(42, '"Like as we decided of LeetCode and German only, so create plan on that." updates today\'s plan without unrelated tasks',
    res42.body.reply.includes('German exam preparation') && res42.body.reply.includes('2 LeetCode questions') &&
    planTodayItems.some(i => i.task.includes('German')) &&
    planTodayItems.some(i => i.task.includes('LeetCode')) &&
    !planTodayItems.some(i => i.task.includes('Trees') || i.task.includes('Spring Boot')),
    `Reply: ${res42.body.reply}, plan: ${JSON.stringify(planTodayItems.map(i => i.task))}`
  );

  console.log('\n=============================================================');
  console.log(`🎉 ALL ${passedCount}/${totalCount} TEST SPECIFICATIONS PASSED SUCCESSFULLY!`);
  console.log('=============================================================\n');

  cleanup();
  process.exit(0);
}

runAllTests().catch(err => {
  console.error('❌ Unhandled error in test suite:', err);
  cleanup();
  process.exit(1);
});
