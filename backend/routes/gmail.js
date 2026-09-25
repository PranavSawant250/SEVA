const express = require('express');
const router = express.Router();
const gmailService = require('../services/gmailService');
const aiService = require('../services/aiService');
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');


// ─────────────────────────────────────────────────────────────
// AUTH ROUTES  (mounted at /api/auth)
// ─────────────────────────────────────────────────────────────

// GET /api/auth/gmail - Redirect to Google OAuth consent screen
router.get('/gmail', (req, res) => {
  try {
    const authUrl = gmailService.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error generating Google Auth URL:', error);
    res.status(500).json({ error: 'Failed to initiate Google OAuth login', details: error.message });
  }
});

// GET /api/auth/callback - OAuth callback handler from Google
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('Google OAuth Access Denied/Error:', error);
    return res.status(400).send(`Google OAuth Error: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Authorization code missing in callback request');
  }

  try {
    await gmailService.handleAuthCallback(code);
    console.log('✅ Google OAuth Login Successful!');

    // token.json is fully written by handleAuthCallback() above (awaited).
    // Only redirect AFTER the await resolves — order is guaranteed.
    res.redirect('http://localhost:3000/dashboard');
  } catch (err) {
    console.error('Error exchanging OAuth code for tokens:', err);
    res.status(500).send(`OAuth Token Exchange Failed: ${err.message}`);
  }
});

// ─────────────────────────────────────────────────────────────
// EMAIL ROUTES  (mounted at /api/emails)
// ─────────────────────────────────────────────────────────────

// GET /api/emails/fetch - Trigger Gmail fetch AND automatic AI analysis
router.get('/fetch', async (req, res) => {
  try {
    if (!gmailService.isLoggedIn()) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated',
        message: 'Please complete OAuth login first by visiting /api/auth/gmail in your browser.'
      });
    }

    const insertedCount = await gmailService.fetchRecentEmails();
    const analyzedCount = await aiService.processUnanalyzedEmails();

    res.json({
      success: true,
      insertedCount,
      analyzedCount,
      message: `Email fetch and AI analysis complete. ${insertedCount} new email(s) added, ${analyzedCount} email(s) analyzed.`
    });
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails', details: error.message });
  }
});

// GET /api/emails/analyze - Manually trigger AI analysis on unanalyzed emails
router.get('/analyze', async (req, res) => {
  try {
    const analyzedCount = await aiService.processUnanalyzedEmails();
    res.json({
      success: true,
      analyzedCount,
      message: `AI analysis complete. ${analyzedCount} email(s) analyzed.`
    });
  } catch (error) {
    console.error('Error analyzing emails:', error);
    res.status(500).json({ error: 'Failed to analyze emails', details: error.message });
  }
});

// GET /api/emails/today - Read-only results viewing endpoint (sorted newest first)
router.get('/today', (req, res) => {
  try {
    const emails = db.prepare(`
      SELECT id, subject, sender, body_preview, event_type, priority, summary, accepted, date, gmail_message_id
      FROM emails
      ORDER BY id DESC
    `).all();

    res.json({
      success: true,
      count: emails.length,
      emails
    });
  } catch (error) {
    console.error('Error fetching emails from DB:', error);
    res.status(500).json({ error: 'Failed to read emails from database', details: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STEP 0 — Accept / Dismiss endpoints (Phase 4 prerequisite)
// ─────────────────────────────────────────────────────────────

/*
 * POST /api/emails/accept/:id
 *
 * Marks the email as accepted (accepted = 1) AND creates a corresponding
 * row in the tasks table so the planning engine only ever needs to look
 * at the tasks table — no separate emails re-query in the planner.
 *
 * Body: none required
 * Response: { success, message, task }
 */
router.post('/accept/:id', (req, res) => {
  const emailId = parseInt(req.params.id, 10);

  if (isNaN(emailId)) {
    return res.status(400).json({ error: 'Invalid email id — must be an integer.' });
  }

  // 1. Look up the email row
  const email = db.prepare(`
    SELECT id, subject, sender, event_type, priority, summary, date, accepted
    FROM emails
    WHERE id = ?
  `).get(emailId);

  if (!email) {
    return res.status(404).json({ error: `No email found with id ${emailId}` });
  }

  if (email.accepted === 1) {
    return res.status(409).json({
      error: 'Already accepted',
      message: `Email ${emailId} has already been accepted and added to tasks.`
    });
  }

  // 2. Decide the task name: prefer AI summary, fall back to email subject
  const taskName = (email.summary && email.summary.trim())
    ? email.summary.trim()
    : (email.subject && email.subject.trim() ? email.subject.trim() : 'Email task');

  // 3. Use the email's own date for the task; fall back to today's date
  const today = getTodayDate();
  const taskDate = (email.date && email.date.trim()) ? email.date.trim() : today;

  // 4. Normalize priority
  const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];
  const priority = (email.priority && ALLOWED_PRIORITIES.includes(email.priority.toLowerCase()))
    ? email.priority.toLowerCase()
    : 'medium';

  console.log(`📧 Accepting email id=${emailId} — creating task: "${taskName}" | priority: ${priority} | date: ${taskDate}`);

  // 5. Run both DB operations in a transaction so they succeed or fail together
  const acceptAndInsert = db.transaction(() => {
    // Mark email as accepted
    db.prepare(`UPDATE emails SET accepted = 1 WHERE id = ?`).run(emailId);

    // Insert into tasks (source = 'email', not yet scheduled → time_slot = null)
    const result = db.prepare(`
      INSERT INTO tasks (name, priority, time_slot, source, completed, date, carry_forward)
      VALUES (?, ?, NULL, 'email', 0, ?, 0)
    `).run(taskName, priority, taskDate);

    return result.lastInsertRowid;
  });

  try {
    const newTaskId = acceptAndInsert();

    console.log(`✅ Email ${emailId} accepted. New task id=${newTaskId} inserted in tasks table.`);

    res.json({
      success: true,
      message: `Email accepted and added to tasks as id=${newTaskId}.`,
      task: {
        id: newTaskId,
        name: taskName,
        priority,
        time_slot: null,
        source: 'email',
        completed: 0,
        date: taskDate
      }
    });
  } catch (err) {
    console.error(`❌ Failed to accept email ${emailId}:`, err.message);
    res.status(500).json({ error: 'Database transaction failed', details: err.message });
  }
});

/*
 * POST /api/emails/dismiss/:id
 *
 * Marks the email as dismissed (accepted = 2). No task is created.
 * This is a soft-reject — the email stays in the DB for audit purposes.
 *
 * Body: none required
 * Response: { success, message }
 */
router.post('/dismiss/:id', (req, res) => {
  const emailId = parseInt(req.params.id, 10);

  if (isNaN(emailId)) {
    return res.status(400).json({ error: 'Invalid email id — must be an integer.' });
  }

  const email = db.prepare(`SELECT id, accepted FROM emails WHERE id = ?`).get(emailId);

  if (!email) {
    return res.status(404).json({ error: `No email found with id ${emailId}` });
  }

  if (email.accepted === 2) {
    return res.status(409).json({
      error: 'Already dismissed',
      message: `Email ${emailId} has already been dismissed.`
    });
  }

  try {
    db.prepare(`UPDATE emails SET accepted = 2 WHERE id = ?`).run(emailId);
    console.log(`🗑️ Email id=${emailId} dismissed (accepted = 2).`);

    res.json({
      success: true,
      message: `Email ${emailId} dismissed. No task created.`
    });
  } catch (err) {
    console.error(`❌ Failed to dismiss email ${emailId}:`, err.message);
    res.status(500).json({ error: 'Database update failed', details: err.message });
  }
});

module.exports = router;
