const { google } = require('googleapis');
const { getAuthenticatedClient } = require('../services/gmailService');

async function inspectFullRawEmail() {
  const authClient = await getAuthenticatedClient();
  if (!authClient) {
    console.error('❌ Not authenticated');
    return;
  }

  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const messageId = '1a0ae0197c5320b8';

  try {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const payload = res.data.payload;

    for (const part of payload.parts || []) {
      if (part.body && part.body.data) {
        const text = Buffer.from(part.body.data, 'base64').toString('utf-8');
        console.log(`\n=================== FULL ${part.mimeType} ===================`);
        console.log(text);
      }
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

inspectFullRawEmail();
