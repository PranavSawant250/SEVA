const { google } = require('googleapis');
const { getAuthenticatedClient } = require('../services/gmailService');
const { analyzeEmail } = require('../services/aiService');

function getBodyPreview(payload, snippet) {
  let rawText = '';

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

  // Clean URLs and common header/nav boilerplate
  let cleanText = rawText
    .replace(/<https?:\/\/[^>]+>/gi, '') // Remove <http...> URLs
    .replace(/https?:\/\/\S+/gi, '')     // Remove bare URLs
    .replace(/Notification settings/gi, '')
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

async function testCleanExtractionAndAI() {
  const authClient = await getAuthenticatedClient();
  if (!authClient) return;

  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const messageId = '1a0ae0197c5320b8';

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const preview = getBodyPreview(res.data.payload, res.data.snippet);
  console.log('✨ CLEANED BODY PREVIEW RESULT:');
  console.log(preview);

  const emailObj = {
    subject: 'New announcement: "MSE MODEL ANSWERS"',
    sender: '"RAVINDRA RATHOD (Classroom)" <no-reply@classroom.google.com>',
    body_preview: preview
  };

  console.log('\n🤖 Running Phi-3.5 AI Analysis on Cleaned Email...');
  const aiResult = await analyzeEmail(emailObj, 'phi3.5');

  console.log('📊 AI RESULT:');
  console.log(`   • event_type: "${aiResult.event_type}"`);
  console.log(`   • priority:   "${aiResult.priority}"`);
  console.log(`   • time:       ${aiResult.time ? `"${aiResult.time}"` : 'null'}`);
  console.log(`   • summary:    "${aiResult.summary}"`);
}

testCleanExtractionAndAI();
