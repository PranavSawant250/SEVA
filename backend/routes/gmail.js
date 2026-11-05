const express = require('express');
const router = express.Router();
const gmailService = require('../services/gmailService');
const aiService = require('../services/aiService');
const { classifyEmail, isActionableInvitation } = require('../services/emailClassifier');
const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');
const TaskService = require('../services/taskService');


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

// GET /api/auth/status & /api/auth/user - Return current authentication and user profile info
router.get(['/status', '/user'], async (req, res) => {
  try {
    const loggedIn = gmailService.isLoggedIn();
    let email = null;
    const name = 'Pranav';

    if (loggedIn) {
      try {
        const authClient = await gmailService.getAuthenticatedClient();
        if (authClient) {
          const { google } = require('googleapis');
          const gmail = google.gmail({ version: 'v1', auth: authClient });
          const profile = await gmail.users.getProfile({ userId: 'me' });
          if (profile && profile.data && profile.data.emailAddress) {
            email = profile.data.emailAddress;
          }
        }
      } catch (err) {
        // network or quota issue — still authenticated if token.json is valid on disk
      }
    }

    return res.json({
      success: true,
      authenticated: loggedIn,
      user: {
        name,
        email: email || (loggedIn ? 'pranav@seva.local' : null),
        role: 'Student / Engineering',
        avatar: null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/logout - Terminate session by unlinking token.json cleanly
router.post('/logout', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const tokenPath = path.join(__dirname, '..', 'credentials', 'token.json');

    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
      console.log('🚪 Session logged out: credentials/token.json deleted.');
    }

    return res.json({
      success: true,
      message: 'Logged out successfully. Authentication session cleared.'
    });
  } catch (err) {
    console.error('Logout error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to terminate session'
    });
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
    console.error('Error fetching emails:', error.message);
    const isAuthError = error.message?.includes('authenticated') || error.message?.includes('OAuth') || error.message?.includes('invalid_grant');
    if (isAuthError) {
      const tokenPath = require('path').join(__dirname, '..', 'credentials', 'token.json');
      if (error.message?.includes('invalid_grant') && require('fs').existsSync(tokenPath)) {
        try { require('fs').unlinkSync(tokenPath); } catch (e) {}
      }
      return res.status(401).json({
        success: false,
        error: 'Not authenticated',
        details: error.message,
        authUrl: 'http://localhost:3001/api/auth/gmail',
        message: 'Please complete OAuth login first by visiting /api/auth/gmail in your browser.'
      });
    }
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

// GET /api/emails/today - Enhanced email viewing with personal relevance and importance filtering
router.get('/today', (req, res) => {
  try {
    const filter = (req.query && req.query.filter) ? String(req.query.filter).toLowerCase() : 'all';

    let querySql = `
      SELECT id, subject, sender, body_preview, event_type, priority, summary, accepted, date, gmail_message_id,
             is_personal, importance_category, relevance_score, action_required, matched_identity,
             user_feedback, reviewed, dismissed
      FROM emails
    `;

    const whereClauses = [];
    if (filter === 'important') {
      // Personally relevant, high score, or non-defaulter high priority
      whereClauses.push(`(is_personal = 1 OR relevance_score >= 1.5 OR (priority = 'high' AND subject NOT LIKE '%defaulter%' AND body_preview NOT LIKE '%defaulter%')) AND dismissed = 0`);
    } else if (filter === 'defaulter') {
      whereClauses.push(`(importance_category = 'academic_warning' OR subject LIKE '%defaulter%' OR body_preview LIKE '%defaulter%')`);
    } else if (filter === 'personal') {
      whereClauses.push(`is_personal = 1`);
    }

    if (whereClauses.length > 0) {
      querySql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    // Rank: personally relevant and critical action first, then high relevance score, then high priority
    querySql += `
      ORDER BY
        is_personal DESC,
        relevance_score DESC,
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        id DESC
    `;

    const rows = db.prepare(querySql).all();

    // Map rows and dynamically flag is_invitation
    const emails = rows.map(r => ({
      ...r,
      is_invitation: isActionableInvitation(r)
    }));

    res.json({
      success: true,
      count: emails.length,
      filter,
      emails
    });
  } catch (error) {
    console.error('Error fetching emails from DB:', error);
    res.status(500).json({ error: 'Failed to read emails from database', details: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// FEEDBACK & ACTION CONTROLS (Phase 10 & Personalization)
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/emails/:id/feedback
 * Allows user to mark email as:
 *  - 'important' | 'not_important'
 *  - 'personal'  | 'not_personal'
 *  - 'action_required' | 'info_only'
 * Persists in email_feedback table and updates email row.
 */
router.post('/:id/feedback', (req, res) => {
  try {
    const emailId = parseInt(req.params.id, 10);
    const { feedback_type } = req.body || {};

    if (isNaN(emailId)) {
      return res.status(400).json({ success: false, error: 'Invalid email ID' });
    }

    const ALLOWED_FEEDBACK = ['important', 'not_important', 'personal', 'not_personal', 'action_required', 'info_only'];
    if (!feedback_type || !ALLOWED_FEEDBACK.includes(feedback_type)) {
      return res.status(400).json({
        success: false,
        error: `feedback_type must be one of: ${ALLOWED_FEEDBACK.join(', ')}`
      });
    }

    const email = db.prepare('SELECT id, sender, subject FROM emails WHERE id = ?').get(emailId);
    if (!email) {
      return res.status(404).json({ success: false, error: `Email ${emailId} not found` });
    }

    // Extract domain if present
    let domain = null;
    const domainMatch = (email.sender || '').match(/@([\w.-]+)/);
    if (domainMatch) domain = domainMatch[1].toLowerCase();

    // Persist to email_feedback
    db.prepare(`
      INSERT INTO email_feedback (email_id, sender, domain, subject_pattern, feedback_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(emailId, email.sender, domain, email.subject ? email.subject.substring(0, 50) : null, feedback_type);

    // Update emails table
    db.prepare('UPDATE emails SET user_feedback = ? WHERE id = ?').run(feedback_type, emailId);

    // Re-score the email
    const reclassification = classifyEmail(email);
    db.prepare(`
      UPDATE emails
      SET relevance_score = ?, priority = ?
      WHERE id = ?
    `).run(reclassification.relevance_score, reclassification.priority, emailId);

    return res.json({
      success: true,
      message: `Feedback "${feedback_type}" recorded and applied.`,
      email_id: emailId,
      updated_score: reclassification.relevance_score
    });
  } catch (err) {
    console.error('Error saving email feedback:', err);
    return res.status(500).json({ success: false, error: 'Failed to record feedback', details: err.message });
  }
});

/**
 * POST /api/emails/:id/review
 * Marks an attendance/academic warning email as reviewed by the user.
 */
router.post('/:id/review', (req, res) => {
  try {
    const emailId = parseInt(req.params.id, 10);
    if (isNaN(emailId)) return res.status(400).json({ success: false, error: 'Invalid email ID' });

    db.prepare('UPDATE emails SET reviewed = 1 WHERE id = ?').run(emailId);
    return res.json({ success: true, message: `Email ${emailId} marked as reviewed.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to mark email reviewed', details: err.message });
  }
});

/**
 * POST /api/emails/:id/dismiss-alert
 * Dismisses an email alert from SEVA's active alert view without deleting the email from database.
 */
router.post('/:id/dismiss-alert', (req, res) => {
  try {
    const emailId = parseInt(req.params.id, 10);
    if (isNaN(emailId)) return res.status(400).json({ success: false, error: 'Invalid email ID' });

    db.prepare('UPDATE emails SET dismissed = 1 WHERE id = ?').run(emailId);
    return res.json({ success: true, message: `Email ${emailId} alert dismissed.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to dismiss alert', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STEP 0 — Accept / Dismiss endpoints (Phase 4 prerequisite)
// ─────────────────────────────────────────────────────────────

/*
 * POST /api/emails/accept/:id
 *
 * Marks genuine event/task email as accepted (accepted = 1) and creates task.
 * Safeguard: Attendance reports and defaulter lists cannot be accepted as calendar invitations.
 */
router.post('/accept/:id', (req, res) => {
  const emailId = parseInt(req.params.id, 10);

  if (isNaN(emailId)) {
    return res.status(400).json({ error: 'Invalid email id — must be an integer.' });
  }

  // 1. Look up the email row
  const email = db.prepare(`
    SELECT id, subject, sender, body_preview, event_type, priority, summary, date, accepted,
           importance_category, is_personal
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

  // Attendance notices & defaulter lists should not display or accept calendar RSVP controls
  if (email.importance_category === 'academic_warning' && !isActionableInvitation(email)) {
    return res.status(400).json({
      success: false,
      error: 'attendance_not_invitation',
      message: 'This notice is an attendance/defaulter report, not a calendar invitation. Please use "Mark Reviewed" or "Dismiss Alert".'
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

    // Insert into tasks via centralized TaskService
    return TaskService.createTask({
      name: taskName,
      priority,
      date: taskDate,
      source: 'email'
    });
  });

  try {
    const createdTask = acceptAndInsert();

    console.log(`✅ Email ${emailId} accepted. New task id=${createdTask.id} inserted in tasks table.`);

    res.json({
      success: true,
      message: `Email accepted and added to tasks as id=${createdTask.id}.`,
      task: createdTask
    });
  } catch (err) {
    console.error(`❌ Failed to accept email ${emailId}:`, err.message);
    res.status(500).json({ error: 'Database transaction failed', details: err.message });
  }
});

/*
 * POST /api/emails/dismiss/:id
 * Marks the email as dismissed (accepted = 2). No task is created.
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

/*
 * DELETE /api/emails/:id
 * Permanently removes an email record from SEVA.
 */
router.delete('/:id', (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  if (isNaN(emailId)) {
    return res.status(400).json({ success: false, error: 'Invalid email ID' });
  }

  try {
    const info = db.prepare('DELETE FROM emails WHERE id = ?').run(emailId);
    if (info.changes === 0) {
      return res.status(404).json({ success: false, error: `Email ${emailId} not found` });
    }
    console.log(`🗑️ Email id=${emailId} permanently removed.`);
    return res.json({ success: true, message: `Email ${emailId} removed.` });
  } catch (err) {
    console.error(`❌ Failed to delete email ${emailId}:`, err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete email', details: err.message });
  }
});

module.exports = router;
