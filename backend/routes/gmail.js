const express = require('express');
const router = express.Router();
const gmailService = require('../services/gmailService');
const aiService = require('../services/aiService');

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
    
    // Send success page if frontend dashboard is not running yet
    res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1 style="color: #2e7d32;">✅ Google OAuth Login Successful!</h1>
        <p>Your Gmail refresh token has been saved securely to <code>credentials/token.json</code>.</p>
        <p>You can now trigger email fetch at <a href="/api/emails/fetch">/api/emails/fetch</a> or view results at <a href="/api/emails/today">/api/emails/today</a>.</p>
      </div>
    `);
  } catch (err) {
    console.error('Error exchanging OAuth code for tokens:', err);
    res.status(500).send(`OAuth Token Exchange Failed: ${err.message}`);
  }
});

// GET /api/emails/fetch - Trigger Gmail fetch AND automatic AI analysis
router.get('/fetch', async (req, res) => {
  try {
    if (!gmailService.isLoggedIn()) {
      return res.status(401).json({
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
  const db = require('../database/db');
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
});

module.exports = router;
