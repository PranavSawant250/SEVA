const Database = require('better-sqlite3');
const path = require('path');

// Initialize SQLite database file in the backend folder (or override via SEVA_DB_PATH for isolated tests)
const dbPath = process.env.SEVA_DB_PATH
  ? path.resolve(process.env.SEVA_DB_PATH)
  : path.join(__dirname, '..', 'seva.db');
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
    accepted INTEGER DEFAULT 0,
    is_personal INTEGER DEFAULT 0,
    importance_category TEXT DEFAULT 'general',
    relevance_score REAL DEFAULT 0,
    action_required INTEGER DEFAULT 0,
    matched_identity TEXT NULL,
    user_feedback TEXT NULL,
    reviewed INTEGER DEFAULT 0,
    dismissed INTEGER DEFAULT 0
  );

  -- TABLE 1b: email_feedback (Stores user feedback on importance and personal relevance)
  CREATE TABLE IF NOT EXISTS email_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NULL,
    sender TEXT NULL,
    domain TEXT NULL,
    subject_pattern TEXT NULL,
    feedback_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id         INTEGER NOT NULL,
    date            TEXT NOT NULL,
    amount          INTEGER DEFAULT 1,
    note            TEXT,
    chat_message_id INTEGER NULL
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
    user_name              TEXT DEFAULT 'Pranav Sawant',
    user_prn               TEXT DEFAULT '246100104',
    neglect_days           INTEGER DEFAULT 3
  );
`);

// Seed the single preferences row on first boot with configured identity
try {
  db.exec(`INSERT OR IGNORE INTO preferences (id, user_name, user_prn) VALUES (1, 'Pranav Sawant', '246100104');`);
  // Ensure default identity is populated if row already existed with nulls
  db.exec(`UPDATE preferences SET user_name = 'Pranav Sawant' WHERE id = 1 AND (user_name IS NULL OR user_name = '');`);
  db.exec(`UPDATE preferences SET user_prn = '246100104' WHERE id = 1 AND (user_prn IS NULL OR user_prn = '');`);
} catch (_) {}

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
// Additive columns on preferences (guarded per-column).
// ─────────────────────────────────────────────────────────────
(function addPreferencesColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(preferences)").all().map(c => c.name);

  const newCols = [
    { name: 'user_name',    sql: "ALTER TABLE preferences ADD COLUMN user_name TEXT DEFAULT 'Pranav Sawant'" },
    { name: 'user_prn',     sql: "ALTER TABLE preferences ADD COLUMN user_prn TEXT DEFAULT '246100104'" },
    { name: 'neglect_days', sql: "ALTER TABLE preferences ADD COLUMN neglect_days INTEGER DEFAULT 3" },
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column preferences.${col.name}`);
    }
  }

  // Populate user_prn and user_name if empty
  try {
    db.exec(`UPDATE preferences SET user_name = 'Pranav Sawant' WHERE id = 1 AND (user_name IS NULL OR user_name = '');`);
    db.exec(`UPDATE preferences SET user_prn = '246100104' WHERE id = 1 AND (user_prn IS NULL OR user_prn = '');`);
  } catch (_) {}
})();

// ─────────────────────────────────────────────────────────────
// Additive columns on emails (guarded per-column).
// ─────────────────────────────────────────────────────────────
(function addEmailColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(emails)").all().map(c => c.name);

  const newCols = [
    { name: 'is_personal',          sql: 'ALTER TABLE emails ADD COLUMN is_personal INTEGER DEFAULT 0' },
    { name: 'importance_category', sql: "ALTER TABLE emails ADD COLUMN importance_category TEXT DEFAULT 'general'" },
    { name: 'relevance_score',      sql: 'ALTER TABLE emails ADD COLUMN relevance_score REAL DEFAULT 0' },
    { name: 'action_required',      sql: 'ALTER TABLE emails ADD COLUMN action_required INTEGER DEFAULT 0' },
    { name: 'matched_identity',    sql: 'ALTER TABLE emails ADD COLUMN matched_identity TEXT NULL' },
    { name: 'user_feedback',        sql: 'ALTER TABLE emails ADD COLUMN user_feedback TEXT NULL' },
    { name: 'reviewed',             sql: 'ALTER TABLE emails ADD COLUMN reviewed INTEGER DEFAULT 0' },
    { name: 'dismissed',            sql: 'ALTER TABLE emails ADD COLUMN dismissed INTEGER DEFAULT 0' },
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column emails.${col.name}`);
    }
  }
})();

// ─────────────────────────────────────────────────────────────
// Additive columns on goal_progress_log (guarded per-column).
// ─────────────────────────────────────────────────────────────
(function addGoalProgressLogColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(goal_progress_log)").all().map(c => c.name);

  const newCols = [
    { name: 'chat_message_id', sql: 'ALTER TABLE goal_progress_log ADD COLUMN chat_message_id INTEGER NULL' }
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column goal_progress_log.${col.name}`);
    }
  }
})();

// ─────────────────────────────────────────────────────────────
// Phase 2 Additive columns on goals (guarded per-column)
// ─────────────────────────────────────────────────────────────
(function addGoalsColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(goals)").all().map(c => c.name);

  const newCols = [
    {
      name: 'is_paused',
      sql: "ALTER TABLE goals ADD COLUMN is_paused INTEGER DEFAULT 0 CHECK(is_paused IN (0, 1) AND (is_paused = 0 OR status = 'active'))"
    },
    {
      name: 'paused_at',
      sql: 'ALTER TABLE goals ADD COLUMN paused_at TEXT NULL'
    },
    {
      name: 'total_paused_days',
      sql: 'ALTER TABLE goals ADD COLUMN total_paused_days INTEGER DEFAULT 0'
    }
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column goals.${col.name}`);
    }
  }
})();

// ─────────────────────────────────────────────────────────────
// Phase 2 Additive columns on goal_steps (guarded per-column)
// ─────────────────────────────────────────────────────────────
(function addGoalStepsColumnsIfMissing() {
  const existingCols = db.prepare("PRAGMA table_info(goal_steps)").all().map(c => c.name);

  const newCols = [
    {
      name: 'is_deleted',
      sql: 'ALTER TABLE goal_steps ADD COLUMN is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1))'
    }
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  📐 Added column goal_steps.${col.name}`);
    }
  }
})();

// ─────────────────────────────────────────────────────────────
// Phase 10 — Session-Scoped Idempotency & Device Security Schema
// Executed atomically inside a transaction; safe to run on every boot.
// ─────────────────────────────────────────────────────────────
(function initPhase10IdempotencySchema() {
  const applyMigration = db.transaction(() => {
    // 1. user_devices: Trusted backend device registry with token hashing at rest
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_devices (
        device_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_prn TEXT NOT NULL,
        device_key TEXT NOT NULL,
        device_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME NULL,
        UNIQUE(user_prn, device_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices(token_hash);
    `);

    // 2. idempotency_requests: Request envelope with fencing tokens and lease owners
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_requests (
        session_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
        response_json TEXT NULL,
        lease_owner TEXT NOT NULL,
        lease_token INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, client_request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_idemp_req_lookup 
        ON idempotency_requests(session_id, client_request_id);
    `);

    // 3. idempotency_actions: Granular action execution table with composite foreign key
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_actions (
        session_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        action_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
        result_json TEXT NULL,
        lease_token INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, client_request_id, action_index),
        FOREIGN KEY (session_id, client_request_id) 
          REFERENCES idempotency_requests(session_id, client_request_id) 
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_idemp_actions_lookup 
        ON idempotency_actions(session_id, client_request_id);
    `);
  });

  applyMigration();
})();

// ─────────────────────────────────────────────────────────────
// Phase 3 tables — Weekly Timetable, Entries, Exceptions
// ─────────────────────────────────────────────────────────────
(function initPhase3TimetableTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Default Weekly Timetable',
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timetable_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timetable_id INTEGER NOT NULL,
      day_of_week TEXT NOT NULL CHECK(day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      event_type TEXT DEFAULT 'class',
      location TEXT NULL,
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      FOREIGN KEY(timetable_id) REFERENCES weekly_timetable(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS timetable_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      entry_id INTEGER NULL,
      action TEXT NOT NULL CHECK(action IN ('cancel_all', 'cancel_entry', 'add_override', 'reschedule')),
      subject TEXT NULL,
      start_time TEXT NULL,
      end_time TEXT NULL,
      note TEXT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(entry_id) REFERENCES timetable_entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_timetable_entries_lookup
      ON timetable_entries(timetable_id, day_of_week, is_active);

    CREATE INDEX IF NOT EXISTS idx_timetable_exceptions_date
      ON timetable_exceptions(date);
  `);

  // Data migration: if weekly_timetable is empty but legacy timetable has rows, populate it
  try {
    const wtCount = db.prepare('SELECT COUNT(*) as count FROM weekly_timetable').get().count;
    if (wtCount === 0) {
      const legacyRows = db.prepare('SELECT day_of_week, subject, start_time, end_time FROM timetable').all();
      if (legacyRows.length > 0) {
        const insWt = db.prepare("INSERT INTO weekly_timetable (name, is_active) VALUES ('Imported College Schedule', 1)").run();
        const wtId = insWt.lastInsertRowid;
        const insEntry = db.prepare(`
          INSERT INTO timetable_entries (timetable_id, day_of_week, title, start_time, end_time, event_type, is_active)
          VALUES (?, ?, ?, ?, ?, 'class', 1)
        `);
        for (const row of legacyRows) {
          insEntry.run(wtId, row.day_of_week, row.subject, row.start_time, row.end_time);
        }
        console.log(`  📐 Phase 3: Migrated ${legacyRows.length} legacy timetable rows into weekly_timetable & timetable_entries.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Phase 3 timetable migration notice:', err.message);
  }
})();

console.log('✅ SQLite Database initialized and all SEVA tables created in seva.db');

module.exports = db;
