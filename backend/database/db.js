const Database = require('better-sqlite3');
const path = require('path');

// Initialize SQLite database file in the backend folder
const dbPath = path.join(__dirname, '..', 'seva.db');
const db = new Database(dbPath);

// Enable foreign key constraints & Write-Ahead Logging (WAL) mode for corruption resilience
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// ─────────────────────────────────────────────────────────────
// Create original 6 tables (unchanged, IF NOT EXISTS guards)
// ─────────────────────────────────────────────────────────────
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
try { db.exec(`ALTER TABLE emails ADD COLUMN gmail_message_id TEXT;`); } catch (_) {}

// Add unique index on gmail_message_id for deduplication
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_gmail_message_id ON emails(gmail_message_id);`); } catch (_) {}

// ─────────────────────────────────────────────────────────────
// Phase 9 tables — Goals, Scheduler, Settings
// All CREATE TABLE IF NOT EXISTS; safe to run on every boot.
// ─────────────────────────────────────────────────────────────
db.exec(`
  -- goals: one row per goal, persists until completed or soft-removed
  CREATE TABLE IF NOT EXISTS goals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    month            TEXT,
    category         TEXT,
    title            TEXT NOT NULL,
    target_text      TEXT,
    deadline         TEXT,
    priority         TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    goal_type        TEXT DEFAULT 'milestone' CHECK(goal_type IN ('milestone','count','frequency')),
    target_count     INTEGER NULL,
    current_count    INTEGER DEFAULT 0,
    per_week         INTEGER NULL,
    manual_progress  INTEGER NULL,
    status           TEXT DEFAULT 'active' CHECK(status IN ('active','completed','removed')),
    created_date     TEXT,
    completed_date   TEXT NULL
  );

  -- goal_progress_log: audit trail for count and frequency logging
  CREATE TABLE IF NOT EXISTS goal_progress_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id  INTEGER NOT NULL,
    date     TEXT NOT NULL,
    amount   INTEGER DEFAULT 1,
    note     TEXT
  );

  -- goal_steps: optional checklist for milestone goals
  -- done = 0 pending, 1 = done; never hard-deleted
  CREATE TABLE IF NOT EXISTS goal_steps (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id   INTEGER NOT NULL,
    step_text TEXT NOT NULL,
    done      INTEGER DEFAULT 0
  );

  -- daily_settings: one row per date; stores the user's window for that day
  -- window_end_minutes: absolute minutes since midnight (e.g. 21*60 = 9 PM)
  -- available_minutes: the raw input ("I have 4 hours" → 240) stored for reference
  --   and reused as tomorrow's check-in budget
  -- done_for_day = 1 → user said "done for today"; scheduler places nothing further
  CREATE TABLE IF NOT EXISTS daily_settings (
    date               TEXT PRIMARY KEY,
    window_end_minutes INTEGER NULL,
    available_minutes  INTEGER NULL,
    done_for_day       INTEGER DEFAULT 0
  );

  -- preferences: single row enforced by CHECK(id=1) + INSERT OR IGNORE seed
  -- run_slot_start: preferred time for daily habits (e.g. "6:30 AM")
  -- default_urgent_minutes: fallback duration for urgent tasks without duration_min
  -- buffer_minutes: gap between consecutive schedule blocks (no meals, no sleep)
  -- user_name: optional display name; NULL means SEVA omits the name in messages
  -- neglect_days: days without activity before a goal triggers a neglect reminder
  CREATE TABLE IF NOT EXISTS preferences (
    id                     INTEGER PRIMARY KEY CHECK(id = 1),
    run_slot_start         TEXT DEFAULT '6:30 AM',
    default_urgent_minutes INTEGER DEFAULT 90,
    buffer_minutes         INTEGER DEFAULT 15,
    user_name              TEXT NULL,
    neglect_days           INTEGER DEFAULT 3
  );
`);

// Seed the single preferences row on first boot
try { db.exec(`INSERT OR IGNORE INTO preferences (id) VALUES (1);`); } catch (_) {}

// ─────────────────────────────────────────────────────────────
// Phase 9 additive columns on tasks (guarded per-column).
// SQLite has no ADD COLUMN IF NOT EXISTS, so we check PRAGMA first.
// All columns are NULL or DEFAULT 0 → zero effect on existing rows.
// ─────────────────────────────────────────────────────────────
(function addTaskColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);

  const newCols = [
    // goal_id: links a task to its originating goal; NULL for all existing rows
    { name: 'goal_id',      sql: 'ALTER TABLE tasks ADD COLUMN goal_id INTEGER NULL' },
    // due_date: YYYY-MM-DD deadline for urgent academic tasks; NULL = no override
    { name: 'due_date',     sql: 'ALTER TABLE tasks ADD COLUMN due_date TEXT NULL' },
    // fixed_start: "H:MM AM/PM" hard start for exams/surprise events; NULL = flexible
    { name: 'fixed_start',  sql: 'ALTER TABLE tasks ADD COLUMN fixed_start TEXT NULL' },
    // fixed_end: "H:MM AM/PM" hard end; NULL = use duration_min from fixed_start
    { name: 'fixed_end',    sql: 'ALTER TABLE tasks ADD COLUMN fixed_end TEXT NULL' },
    // duration_min: planned duration in minutes; NULL → scheduler falls back to 30
    { name: 'duration_min', sql: 'ALTER TABLE tasks ADD COLUMN duration_min INTEGER NULL' },
    // is_urgent: 1 = Layer 2 priority; 0 for all existing rows (no behaviour change)
    { name: 'is_urgent',    sql: 'ALTER TABLE tasks ADD COLUMN is_urgent INTEGER DEFAULT 0' },
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column tasks.${col.name}`);
    }
  }
})();

// ─────────────────────────────────────────────────────────────
// Phase 9 additive columns on preferences (guarded per-column).
// user_name and neglect_days may have been added in a later iteration.
// ─────────────────────────────────────────────────────────────
(function addPreferencesColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(preferences)").all().map(c => c.name);

  const newCols = [
    { name: 'user_name',    sql: "ALTER TABLE preferences ADD COLUMN user_name TEXT NULL" },
    { name: 'neglect_days', sql: "ALTER TABLE preferences ADD COLUMN neglect_days INTEGER DEFAULT 3" },
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column preferences.${col.name}`);
    }
  }
})();

console.log('✅ SQLite Database initialized and all SEVA tables created in seva.db');

module.exports = db;
