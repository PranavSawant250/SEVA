const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

// Initialize database & table schemas
const db = require('./database/db');
const gmailService = require('./services/gmailService');
const aiService = require('./services/aiService');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Base Route
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'SEVA — Personal Life Orchestrator Backend API',
    database: 'Connected (seva.db)',
    gmailAuthStatus: gmailService.isLoggedIn() ? 'Authenticated' : 'Pending Login (/api/auth/gmail)'
  });
});

// Register API Routes
app.use('/api/auth', require('./routes/gmail'));
app.use('/api/emails', require('./routes/gmail'));
app.use('/api/plan', require('./routes/plan'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/summary', require('./routes/summary'));
app.use('/api/timetable', require('./routes/timetable'));

// STEP 5: Auto-fetch emails and analyze every 30 minutes using node-cron
cron.schedule('*/30 * * * *', async () => {
  const timestamp = new Date().toLocaleString();
  
  if (!gmailService.isLoggedIn()) {
    console.log(`[${timestamp}] ⏰ Cron sync skipped: Gmail account not authenticated yet. Log in via /api/auth/gmail`);
    return;
  }

  try {
    console.log(`[${timestamp}] ⏰ Running scheduled 30-minute Gmail email fetch & AI analysis...`);
    const insertedCount = await gmailService.fetchRecentEmails();
    const analyzedCount = await aiService.processUnanalyzedEmails();
    console.log(`[${timestamp}] ⏰ Scheduled email sync complete. ${insertedCount} new email(s) inserted, ${analyzedCount} email(s) analyzed.`);
  } catch (error) {
    console.error(`[${timestamp}] ❌ Error during scheduled email sync:`, error.message);
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 SEVA Backend running on port ${PORT}`);
  console.log(`🔗 OAuth Login Link: http://localhost:${PORT}/api/auth/gmail`);
});
