const db = require('../database/db');
const today = new Date().toISOString().slice(0, 10);

// Insert sample emails for screenshot demonstration
const insertEmail = db.prepare(
  'INSERT OR IGNORE INTO emails (gmail_message_id, subject, sender, body_preview, event_type, priority, summary, date, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

insertEmail.run('msg001', 'MSE Model Answers Released', 'RAVINDRA RATHOD (Classroom) <no-reply@classroom.google.com>', 'MSE Model Answers for Database Engineering have been posted. Check the classroom portal.', 'general', 'high', 'MSE model answers for Database Engineering posted on classroom portal.', today, 0);
insertEmail.run('msg002', 'NPTEL Registration Closing Soon', 'NPTEL <onlinecourses@nptel.iitm.ac.in>', 'Registration for Deep Dive into Battery Cell Technology from IIT Madras closes soon.', 'opportunity', 'high', 'Registration closing for IIT Madras battery technology course.', today, 0);
insertEmail.run('msg003', 'New Announcement: Core Programming Book PDF', 'sharvari solapure (Classroom) <no-reply@classroom.google.com>', 'Core programming book PDF reference shared in TY-IT 2026-27 Sem I Class A.', 'general', 'medium', 'Core programming book PDF for reference shared in classroom.', today, 0);
insertEmail.run('msg004', 'SWAYAM Plus: Course Discontinuation Notice', 'SWAYAM Plus Announcements <swayam-plus-announcements@swayam2.ac.in>', 'Select courses on SWAYAM Plus will be discontinued effective September 29, 2026.', 'general', 'medium', 'Courses discontinued on SWAYAM Plus effective September 29, 2026.', today, 1);

const count = db.prepare('SELECT count(*) as c FROM emails').get();
console.log('Inserted sample emails. Total in DB:', count.c, '(' + today + ')');

const pending = db.prepare("SELECT count(*) as c FROM emails WHERE accepted = 0").get();
const processed = db.prepare("SELECT count(*) as c FROM emails WHERE accepted != 0").get();
console.log('Pending:', pending.c, '| Processed:', processed.c);
