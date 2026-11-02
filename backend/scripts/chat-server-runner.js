const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const db = require('../database/db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    pid: process.pid,
    database: process.env.SEVA_DB_PATH || 'default'
  });
});

app.use('/api/chat', require('../routes/chat'));

const PORT = parseInt(process.env.PORT, 10) || 3099;
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 Chat Backend Server running at http://${HOST}:${PORT} (PID: ${process.pid}) [DB: ${process.env.SEVA_DB_PATH || 'seva.db'}]`);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, exiting.');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, exiting.');
  server.close(() => process.exit(0));
});

