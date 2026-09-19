const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const db = require('../database/db');
const { getTodayDate } = require('../utils/dateUtils');
const TOKEN_PATH = path.join(__dirname, '..', 'credentials', 'token.json');


// Get OAuth2 client instance using environment variables
function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/callback';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth Client ID or Client Secret missing in .env');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Generate Google Consent Screen Auth URL
function getAuthUrl() {
  const oauth2Client = createOAuth2Client();
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // Requests refresh token
    prompt: 'consent',     // Forces consent screen to ensure refresh token is issued
    scope: scopes
  });
}

// Exchange Auth Code for Tokens and persist to token.json
async function handleAuthCallback(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  
  // If token.json already exists and new tokens don't include refresh_token, preserve existing refresh_token
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const existingTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      if (!tokens.refresh_token && existingTokens.refresh_token) {
        tokens.refresh_token = existingTokens.refresh_token;
      }
    } catch (err) {
      console.warn('Could not read existing token.json to merge refresh_token:', err.message);
    }
  }

  // Save tokens to disk
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('🔑 Saved Gmail OAuth tokens to credentials/token.json');

  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// Load authenticated OAuth2 client from saved token.json
async function getAuthenticatedClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    return null;
  }

  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(tokens);

    // Save updated tokens if auto-refreshed
    oauth2Client.on('tokens', (newTokens) => {
      const updatedTokens = { ...tokens, ...newTokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));
      console.log('🔄 Refreshed and updated Gmail OAuth tokens on disk');
    });

    return oauth2Client;
  } catch (error) {
    console.error('Error loading saved OAuth tokens:', error.message);
    return null;
  }
}

// Helper to check if user has logged in
function isLoggedIn() {
  return fs.existsSync(TOKEN_PATH);
}

// Helper function to extract clean plain-text body preview from Gmail payload
function getBodyPreview(payload, snippet) {
  let rawText = '';

  // Traverse MIME parts prioritizing text/plain over text/html
  function extractTextFromParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        rawText = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return; // Prioritize text/plain
      } else if (part.mimeType === 'text/html' && part.body && part.body.data && !rawText) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        rawText = html.replace(/<[^>]*>/g, ' ');
      }
      if (part.parts && !rawText) {
        extractTextFromParts(part.parts);
      }
    }
  }

  if (payload.parts) {
    extractTextFromParts(payload.parts);
  } else if (payload.body && payload.body.data) {
    const raw = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    rawText = payload.mimeType === 'text/html' ? raw.replace(/<[^>]*>/g, ' ') : raw;
  }

  if (!rawText) {
    rawText = snippet || '';
  }

  // Strip URLs and common notification header/footer boilerplate (e.g. Google Classroom navigation chrome)
  let cleanText = rawText
    .replace(/<https?:\/\/[^>]+>/gi, '')   // Remove <http...> URLs
    .replace(/https?:\/\/\S+/gi, '')       // Remove bare http URLs
    .replace(/Notification settings/gi, '') // Strip nav header text
    .replace(/Unsubscribe or change your settings/gi, '')
    .replace(/Google LLC \d+ Amphitheatre.*/gi, '');

  const lines = cleanText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  cleanText = lines.join(' ').replace(/\s+/g, ' ');

  if (!cleanText || cleanText.length < 10) {
    cleanText = (snippet || '').replace(/https?:\/\/\S+/gi, '').trim();
  }

  return cleanText.substring(0, 400);
}

// Fetch recent emails (last 24 hours) and store in SQLite database
async function fetchRecentEmails() {
  const authClient = await getAuthenticatedClient();
  if (!authClient) {
    throw new Error('User is not authenticated with Gmail. Please complete OAuth login at /api/auth/gmail first.');
  }

  const gmail = google.gmail({ version: 'v1', auth: authClient });

  // Search messages from last 24 hours, cap at 20
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: 'newer_than:1d',
    maxResults: 20
  });

  const messages = response.data.messages || [];
  if (messages.length === 0) {
    return 0;
  }

  let newInsertedCount = 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO emails (gmail_message_id, subject, sender, body_preview, event_type, priority, summary, date, accepted)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0)
  `);

  for (const msg of messages) {
    try {
      const msgData = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = msgData.data.payload.headers || [];
      const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
      const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

      const subject = subjectHeader ? subjectHeader.value : '(No Subject)';
      const sender = fromHeader ? fromHeader.value : 'Unknown Sender';
      const bodyPreview = getBodyPreview(msgData.data.payload, msgData.data.snippet);

      // Parse email date into YYYY-MM-DD
      let emailDateStr = getTodayDate();
      if (dateHeader && dateHeader.value) {
        const parsedDate = new Date(dateHeader.value);
        if (!isNaN(parsedDate.getTime())) {
          emailDateStr = getTodayDate(parsedDate);
        }
      }

      // Execute SQLite insert (skips if gmail_message_id already exists)
      const result = insertStmt.run(msg.id, subject, sender, bodyPreview, emailDateStr);
      if (result.changes > 0) {
        newInsertedCount++;
      }
    } catch (err) {
      console.error(`Error processing email message ${msg.id}:`, err.message);
    }
  }

  return newInsertedCount;
}

module.exports = {
  getAuthUrl,
  handleAuthCallback,
  getAuthenticatedClient,
  isLoggedIn,
  fetchRecentEmails
};
