const Database = require('better-sqlite3');
const path = require('path');

// Initialize SQLite database file in the backend folder
const dbPath = path.join(__dirname, '..', 'seva.db');
const db = new Database(dbPath);

// Enable foreign key constraints & Write-Ahead Logging (WAL) mode for corruption resilience
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Create all 6 tables exactly as specified in the SEVA specification document
db.exec(`
  -- TABLE 1: emails (Stores Gmail fetched emails and AI classification metadata)
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT,
    subject TEXT,
    sender TEXT,
    body_preview TEXT,
    event_type TEXT,
    priority TEXT,
    summary TEXT,
    date TEXT,
    accepted INTEGER DEFAULT 0
  );

  -- TABLE 2: tasks (Stores manually added tasks and tasks derived from emails)
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    priority TEXT,
    time_slot TEXT,
    source TEXT,
    completed INTEGER DEFAULT 0,
    date TEXT,
    carry_forward INTEGER DEFAULT 0
  );

  -- TABLE 3: day_plans (Stores hour-by-hour AI generated daily schedules)
  CREATE TABLE IF NOT EXISTS day_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    plan_json TEXT,
    generated_at DATETIME,
    completed_count INTEGER DEFAULT 0,
    missed_count INTEGER DEFAULT 0
  );

  -- TABLE 4: chat_history (Stores permanent conversational logs between user and SEVA)
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    role TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- TABLE 5: night_summary (Stores daily review, completed/missed counts, streak, and carry forwards)
  CREATE TABLE IF NOT EXISTS night_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    completed_tasks TEXT,
    missed_tasks TEXT,
    carry_forward TEXT,
    seva_message TEXT,
    streak INTEGER DEFAULT 0
  );

  -- TABLE 6: timetable (Stores regular recurring weekly class/work schedule)
  CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week TEXT,
    subject TEXT,
    start_time TEXT,
    end_time TEXT
  );
`);

// Add gmail_message_id column if created previously without it
try {
  db.exec(`ALTER TABLE emails ADD COLUMN gmail_message_id TEXT;`);
} catch (err) {
  // Column already exists
}

// Add unique index on gmail_message_id for deduplication
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_gmail_message_id ON emails(gmail_message_id);`);
} catch (err) {
  // Index already exists
}

console.log('✅ SQLite Database initialized and all 6 SEVA tables created in seva.db');

module.exports = db;
