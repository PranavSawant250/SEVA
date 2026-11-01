/**
 * backend/services/emailClassifier.js
 *
 * Deterministic, personalized email relevance and importance classifier.
 * Configured identity is read dynamically from the database preferences table:
 *   user_name: 'Pranav Sawant' (or configured)
 *   user_prn:  '246100104' (or configured)
 *
 * Supports:
 *  - Strict PRN matching (guards against phone numbers, timestamps, transaction IDs)
 *  - Name variations ('Pranav Sawant', 'Sawant Pranav', spacing, case-insensitive)
 *  - Defaulter lists and attendance report parsing
 *  - Table parsing (plain text, CSV, tab-separated, markdown)
 *  - Attachment text scanning
 *  - Explainable category ranking (critical_personal, academic_warning, exam_deadline, etc.)
 *  - Persisted user feedback rules (learning from email_feedback table)
 *  - Actionable invitation discrimination (distinguishing calendar invites from attendance/defaulter notices)
 */

const db = require('../database/db');

// Supported importance categories
const CATEGORIES = {
  CRITICAL_PERSONAL: 'critical_personal',
  ACADEMIC_WARNING: 'academic_warning',
  EXAM_DEADLINE: 'exam_deadline',
  COLLEGE_ANNOUNCEMENT: 'college_announcement',
  PERSONAL_WORK: 'personal_work',
  ATTENDANCE_NOTIFICATION: 'attendance_notification',
  NEWSLETTER: 'newsletter',
  PROMOTIONS: 'promotions',
  SPAM: 'spam'
};

/**
 * Retrieve configured identity from preferences table
 */
function getConfiguredIdentity() {
  try {
    const prefs = db.prepare('SELECT user_name, user_prn FROM preferences WHERE id = 1').get();
    return {
      name: (prefs && prefs.user_name) ? prefs.user_name.trim() : 'Pranav Sawant',
      prn: (prefs && prefs.user_prn) ? prefs.user_prn.trim() : '246100104'
    };
  } catch (_) {
    return { name: 'Pranav Sawant', prn: '246100104' };
  }
}

/**
 * Build name variants for matching (e.g. "Pranav Sawant" -> ["pranav sawant", "sawant pranav"])
 */
function getNameVariants(fullName) {
  if (!fullName || typeof fullName !== 'string') return [];
  const clean = fullName.trim().toLowerCase();
  const parts = clean.split(/\s+/).filter(Boolean);
  const variants = [clean];

  if (parts.length === 2) {
    // Reverse variant: "Sawant Pranav"
    variants.push(`${parts[1]} ${parts[0]}`);
  }
  return variants;
}

/**
 * Check whether a text contains the user's PRN strictly without false positives.
 * Prevents false positives from:
 * - Phone numbers (e.g. "+9198246100104", "098246100104", "98246100104")
 * - Timestamps or long transaction IDs (e.g. "TXN24610010499", "1724610010400")
 */
function matchStrictPrn(text, prn) {
  if (!text || !prn || typeof text !== 'string') return false;

  const escapedPrn = prn.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // Match PRN bounded by non-alphanumeric characters
  const regex = new RegExp(`(?<![a-zA-Z0-9])${escapedPrn}(?![a-zA-Z0-9])`, 'i');

  const match = regex.exec(text);
  if (!match) return false;

  // Verify surrounding window for phone number indicators or transaction IDs
  const matchIndex = match.index;
  const startWindow = Math.max(0, matchIndex - 15);
  const endWindow = Math.min(text.length, matchIndex + prn.length + 15);
  const windowStr = text.substring(startWindow, endWindow).toLowerCase();

  // If preceded by phone number markers
  if (/(?:\+91|tel:|phone:|mob:|contact:|\bph:|\bcell:)/i.test(windowStr)) {
    // Check if directly part of a phone number
    const phoneCheck = /(?:\+91|tel:|phone:|mob:|\bph:)\s*[\d-]{8,}/i;
    if (phoneCheck.test(windowStr)) return false;
  }

  // If preceded by transaction / banking markers
  if (/(?:txn|utr|ref|transaction|order\s*id|payment\s*id)[\s#:]*[a-z0-9_-]*/i.test(windowStr)) {
    return false;
  }

  return true;
}

/**
 * Check whether a text contains the user's name (with variants, extra spaces, line breaks)
 */
function matchName(text, nameVariants) {
  if (!text || typeof text !== 'string') return false;
  // Normalize extra spaces and line breaks
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');

  for (const variant of nameVariants) {
    const escaped = variant.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\s+/g, '\\s+');
    const regex = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'i');
    if (regex.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Scan tables or structured rows (plain text table, CSV, markdown)
 */
function parseStructuredRows(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    // Check if line looks like a table row: has '|', ',', '\t', or multiple column spaces
    if (line.includes('|')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length > 1) rows.push({ raw: line, cells });
    } else if (line.includes('\t')) {
      const cells = line.split('\t').map(c => c.trim()).filter(Boolean);
      if (cells.length > 1) rows.push({ raw: line, cells });
    } else if (line.includes(',')) {
      const cells = line.split(',').map(c => c.trim()).filter(Boolean);
      if (cells.length > 1) rows.push({ raw: line, cells });
    } else {
      // Split on 2 or more spaces
      const cells = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
      if (cells.length > 1) rows.push({ raw: line, cells });
    }
  }
  return rows;
}

/**
 * Check if sender or content has academic context
 */
function isAcademicContext(text, sender = '') {
  const academicTerms = [
    'attendance', 'defaulter', 'detained', 'debarred', 'semester', 'exam', 'examination',
    'submission', 'hall ticket', 'internal assessment', 'viva', 'practical', 'assignment',
    'college', 'university', 'department', 'faculty', 'hod', 'dean', 'syllabus', 'credits',
    'prn', 'roll no', 'division', 'batch', 'academic'
  ];

  const fullStr = `${sender} ${text}`.toLowerCase();
  const hits = academicTerms.filter(term => fullStr.includes(term));
  return hits.length >= 2 || (sender && /(?:\.edu|\.ac\.in|college|univ)/i.test(sender));
}

/**
 * Extract attendance percentage or subject if present in row or text
 */
function extractAttendanceDetails(text) {
  let attendancePct = null;
  let subject = null;
  let deadline = null;

  // Find all percentage matches in text; prioritize student percentage over cutoff thresholds like "below 75%"
  const pctRegex = /(?:(below|under|less\s+than)\s+)?(\d{1,2}(?:\.\d+)?)\s*%/gi;
  let match;
  let fallbackThreshold = null;

  while ((match = pctRegex.exec(text)) !== null) {
    const isThreshold = Boolean(match[1]);
    const val = parseFloat(match[2]);
    if (val >= 0 && val <= 100) {
      if (!isThreshold) {
        attendancePct = `${val}%`;
        break;
      } else if (!fallbackThreshold) {
        fallbackThreshold = `${val}%`;
      }
    }
  }

  if (!attendancePct && fallbackThreshold) {
    attendancePct = fallbackThreshold;
  }

  // Match subject patterns like "in Operating Systems", "Subject: Data Structures" or "[CS301] Operating Systems"
  const subjMatch = text.match(/(?:subject|course|paper)[\s:]+([A-Za-z0-9\s&-]{3,30})/i);
  const inSubjectMatch = text.match(/\bin\s+([A-Za-z0-9\s&-]{3,30})(?:\.|$|,)/i);
  if (subjMatch) {
    subject = subjMatch[1].trim();
  } else if (inSubjectMatch) {
    subject = inSubjectMatch[1].trim();
  }

  // Match deadline like "submit by Friday", "before 5 PM", "by 30th October"
  const deadlineMatch = text.match(/(?:deadline|submit\s+by|before|last\s+date)[\s:]+([A-Za-z0-9\s,:-]{4,40})/i);
  if (deadlineMatch) {
    deadline = deadlineMatch[1].trim();
  }

  return { attendancePct, subject, deadline };
}

/**
 * Determine if message is a genuine actionable calendar/event invitation
 */
function isActionableInvitation(email) {
  const combined = `${email.subject || ''} ${email.body_preview || ''} ${email.sender || ''}`.toLowerCase();

  // Defaulter notices and attendance lists are NEVER invitations
  if (/defaulter|attendance|detained|debarred|hall\s*ticket|eligibility/i.test(combined)) {
    return false;
  }

  // Must have clear calendar invite or meeting markers
  const hasInviteKeywords = (
    combined.includes('calendar invite') ||
    combined.includes('invitation:') ||
    combined.includes('invited you to') ||
    combined.includes('google meet') ||
    combined.includes('zoom meeting') ||
    combined.includes('microsoft teams meeting') ||
    combined.includes('webinar invitation') ||
    (email.event_type === 'meeting' && /(?:rsvp|join|meeting link)/i.test(combined))
  );

  return Boolean(hasInviteKeywords);
}

/**
 * Retrieve user feedback rules to bias classification
 */
function getFeedbackAdjustments(sender, subject) {
  try {
    const rules = db.prepare('SELECT * FROM email_feedback').all();
    let scoreDelta = 0;
    let forceImportant = false;
    let forceUnimportant = false;

    for (const r of rules) {
      const matchesSender = r.sender && sender && sender.toLowerCase().includes(r.sender.toLowerCase());
      const matchesPattern = r.subject_pattern && subject && subject.toLowerCase().includes(r.subject_pattern.toLowerCase());

      if (matchesSender || matchesPattern) {
        if (r.feedback_type === 'important' || r.feedback_type === 'personal') {
          scoreDelta += 2.0;
          forceImportant = true;
        } else if (r.feedback_type === 'not_important' || r.feedback_type === 'not_personal') {
          scoreDelta -= 2.0;
          forceUnimportant = true;
        }
      }
    }

    return { scoreDelta, forceImportant, forceUnimportant };
  } catch (_) {
    return { scoreDelta: 0, forceImportant: false, forceUnimportant: false };
  }
}

/**
 * Main classification function
 * Evaluates an email object: { subject, sender, body_preview, event_type, date, attachments }
 */
function classifyEmail(email, options = {}) {
  const { name, prn } = getConfiguredIdentity();
  const nameVariants = getNameVariants(name);

  const subject = email.subject || '';
  const sender = email.sender || '';
  const body = email.body_preview || '';
  const attachmentText = (email.attachments && Array.isArray(email.attachments))
    ? email.attachments.map(a => typeof a === 'string' ? a : (a.text || a.content || a.filename || '')).join(' ')
    : (typeof email.attachment_text === 'string' ? email.attachment_text : '');

  const combinedContent = `${subject}\n${body}\n${attachmentText}`;
  const feedback = getFeedbackAdjustments(sender, subject);

  // Check structured rows for table-based matching
  const structuredRows = parseStructuredRows(combinedContent);
  let matchedInRow = false;
  let matchingRowContent = '';

  for (const row of structuredRows) {
    const rowStr = row.raw;
    const prnHit = matchStrictPrn(rowStr, prn);
    const nameHit = matchName(rowStr, nameVariants);
    if (prnHit || nameHit) {
      matchedInRow = true;
      matchingRowContent = rowStr;
      break;
    }
  }

  // 1. Strict identity detection
  const hasPrnMatch = matchStrictPrn(combinedContent, prn);
  const hasNameMatch = matchName(combinedContent, nameVariants);
  const hasAcademic = isAcademicContext(combinedContent, sender);

  // Defaulter / attendance alert indicators
  const isDefaulterContent = /(?:attendance\s+below\s+75%|defaulter\s*list|low\s+attendance|shortage\s+of\s+attendance|detained|debarred|hall\s*ticket\s*withheld)/i.test(combinedContent);
  const isAttendanceContent = /(?:attendance|timetable|schedule\s+update)/i.test(combinedContent);
  const isExamContent = /(?:exam|examination|hall\s*ticket|viva|practical|submission|assignment\s+due)/i.test(combinedContent);

  let isPersonal = 0;
  let matchedIdentity = null;
  let category = CATEGORIES.COLLEGE_ANNOUNCEMENT;
  let priority = 'medium';
  let relevanceScore = 1.0;
  let actionRequired = 0;
  let summary = email.summary || subject;

  // 2. Personal relevance determination
  if (hasPrnMatch) {
    isPersonal = 1;
    matchedIdentity = `PRN match (${prn})`;
    if (isDefaulterContent) {
      category = CATEGORIES.ACADEMIC_WARNING;
      priority = 'high';
      relevanceScore = 5.0;
      actionRequired = 1;
      const details = extractAttendanceDetails(matchingRowContent || combinedContent);
      let detailMsg = 'Your PRN appears in the college attendance defaulter list.';
      if (details.attendancePct) detailMsg += ` Reported attendance: ${details.attendancePct}.`;
      if (details.subject) detailMsg += ` Subject: ${details.subject}.`;
      if (details.deadline) detailMsg += ` Action deadline: ${details.deadline}.`;
      detailMsg += ' Check the listed subject and attendance details.';
      summary = `Important: ${detailMsg}`;
    } else if (isExamContent) {
      category = CATEGORIES.EXAM_DEADLINE;
      priority = 'high';
      relevanceScore = 4.5;
      actionRequired = 1;
      summary = `Academic Notice: Your PRN is listed regarding examinations/submissions. Action required.`;
    } else {
      category = CATEGORIES.CRITICAL_PERSONAL;
      priority = 'high';
      relevanceScore = 4.0;
      summary = `Personal Notice: Your PRN (${prn}) was identified in this message.`;
    }
  } else if (hasNameMatch && hasAcademic) {
    // Name matched in clear academic context even if PRN is absent
    isPersonal = 1;
    matchedIdentity = `Name match (${name})`;
    if (isDefaulterContent) {
      category = CATEGORIES.ACADEMIC_WARNING;
      priority = 'high';
      relevanceScore = 4.5;
      actionRequired = 1;
      const details = extractAttendanceDetails(matchingRowContent || combinedContent);
      let detailMsg = 'Your name appears in the college attendance defaulter list.';
      if (details.attendancePct) detailMsg += ` Reported attendance: ${details.attendancePct}.`;
      if (details.subject) detailMsg += ` Subject: ${details.subject}.`;
      if (details.deadline) detailMsg += ` Action deadline: ${details.deadline}.`;
      detailMsg += ' Check the listed subject and attendance details.';
      summary = `Important: ${detailMsg}`;
    } else if (isExamContent) {
      category = CATEGORIES.EXAM_DEADLINE;
      priority = 'high';
      relevanceScore = 4.0;
      actionRequired = 1;
      summary = `Academic Notice: Your name is listed regarding examination/submission deadlines.`;
    } else {
      category = CATEGORIES.CRITICAL_PERSONAL;
      priority = 'high';
      relevanceScore = 3.5;
      summary = `Personal College Notice: Contains reference to your name in academic records.`;
    }
  } else if (hasAcademic) {
    // Academic context without user identity
    isPersonal = 0;
    if (isDefaulterContent || isExamContent) {
      category = CATEGORIES.COLLEGE_ANNOUNCEMENT;
      priority = 'medium';
      relevanceScore = 2.5;
      summary = `College Announcement: General notice (no personal identity match detected).`;
    } else {
      category = CATEGORIES.COLLEGE_ANNOUNCEMENT;
      priority = 'medium';
      relevanceScore = 2.0;
    }
  } else {
    // Non-academic or routine
    const lowerSender = sender.toLowerCase();
    const lowerSubj = subject.toLowerCase();

    if (/promo|offer|discount|deal|marketing|no-reply@store|shopping/i.test(lowerSender + ' ' + lowerSubj)) {
      category = CATEGORIES.PROMOTIONS;
      priority = 'low';
      relevanceScore = 0.2;
    } else if (/newsletter|digest|weekly\s+update|roundup/i.test(lowerSubj)) {
      category = CATEGORIES.NEWSLETTER;
      priority = 'low';
      relevanceScore = 0.5;
    } else if (/spam|lottery|winner|claim\s+prize|crypto/i.test(lowerSubj)) {
      category = CATEGORIES.SPAM;
      priority = 'low';
      relevanceScore = 0.0;
    } else {
      category = CATEGORIES.PERSONAL_WORK;
      priority = 'medium';
      relevanceScore = 1.0;
    }
  }

  // 3. Apply user feedback biasing
  relevanceScore += feedback.scoreDelta;
  if (feedback.forceImportant) {
    if (priority === 'low') priority = 'medium';
    relevanceScore = Math.max(relevanceScore, 3.0);
  }
  if (feedback.forceUnimportant) {
    if (priority === 'high') priority = 'medium';
    if (!isPersonal) priority = 'low';
    relevanceScore = Math.min(relevanceScore, 0.8);
  }

  // Determine if genuine actionable calendar/event invitation
  const isInvitation = isActionableInvitation(email);

  return {
    is_personal: isPersonal,
    importance_category: category,
    priority,
    relevance_score: Math.max(0, parseFloat(relevanceScore.toFixed(2))),
    action_required: actionRequired,
    matched_identity: matchedIdentity,
    summary,
    is_invitation: isInvitation
  };
}

module.exports = {
  CATEGORIES,
  getConfiguredIdentity,
  getNameVariants,
  matchStrictPrn,
  matchName,
  parseStructuredRows,
  extractAttendanceDetails,
  isActionableInvitation,
  classifyEmail
};
