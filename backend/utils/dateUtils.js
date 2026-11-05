/**
 * backend/utils/dateUtils.js
 *
 * Centralized date and time utility functions for SEVA.
 * Ensures all dates (YYYY-MM-DD) are computed in the server's LOCAL timezone,
 * avoiding UTC offset shifts around midnight IST (+05:30).
 *
 * Rule: NEVER use toISOString() for dates. All functions use local Date methods.
 */

const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Returns today's date (or date for given Date object) formatted as YYYY-MM-DD
 * in Asia/Kolkata timezone regardless of host machine timezone.
 * @param {Date} [dateObj=new Date()] Optional Date object
 * @returns {string} "YYYY-MM-DD"
 */
function getTodayDate(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Returns day of week name (e.g. "Monday") for any YYYY-MM-DD string or Date object.
 * @param {string|Date} [dateInput=new Date()]
 * @returns {string} Full day name
 */
function getDayOfWeek(dateInput = new Date()) {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const [y, m, d] = dateInput.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dateObj.getUTCDay()];
  }
  return getTodayDayOfWeek(dateInput);
}

/**
 * Returns today's day of week name (e.g., "Monday") in Asia/Kolkata timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} Full day name
 */
function getTodayDayOfWeek(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'long'
  }).format(d);
}

/**
 * Returns yesterday's date formatted as YYYY-MM-DD in Asia/Kolkata timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD"
 */
function getYesterdayDate(dateObj = new Date()) {
  const d = dateObj instanceof Date ? new Date(dateObj.getTime()) : new Date(dateObj);
  d.setTime(d.getTime() - 24 * 60 * 60 * 1000);
  return getTodayDate(d);
}

/**
 * Returns tomorrow's date formatted as YYYY-MM-DD in Asia/Kolkata timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD"
 */
function getTomorrowDate(dateObj = new Date()) {
  const d = dateObj instanceof Date ? new Date(dateObj.getTime()) : new Date(dateObj);
  d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
  return getTodayDate(d);
}

/**
 * Returns tomorrow's day of week name (e.g., "Tuesday") in Asia/Kolkata timezone.
 * Used by the nightly check-in to build tomorrow's outline.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} Full day name
 */
function getTomorrowDayOfWeek(dateObj = new Date()) {
  const d = dateObj instanceof Date ? new Date(dateObj.getTime()) : new Date(dateObj);
  d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
  return getTodayDayOfWeek(d);
}

/**
 * Converts "H:MM AM/PM", "H AM/PM", or "HAM/PM" to minutes since midnight.
 * Moved here from routes/timetable.js so the scheduler and other services
 * can use it without importing a route file.
 * @param {string} timeStr e.g. "9AM", "9 AM", "9:00 AM", "3:30 PM"
 * @returns {number|null} Minutes since midnight, or null if unparseable
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  const period = match[3].toUpperCase();
  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

/**
 * Converts minutes since midnight to "H:MM AM/PM" display string.
 * Inverse of parseTimeToMinutes. Used by the scheduler for plan item times.
 * @param {number} totalMinutes 0-1439
 * @returns {string} e.g. "9:00 AM", "1:30 PM"
 */
function minutesToTimeString(totalMinutes) {
  if (typeof totalMinutes !== 'number' || isNaN(totalMinutes) || totalMinutes < 0) return 'unknown';
  const clipped = Math.min(Math.floor(totalMinutes), 1439);
  const h24 = Math.floor(clipped / 60);
  const m = clipped % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Returns the Monday of the week containing dateObj, as YYYY-MM-DD in Asia/Kolkata.
 * Used by frequency goals to compute days_this_week.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD" of Monday in this week
 */
function getWeekMondayDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  const dowStr = new Intl.DateTimeFormat('en-US', { timeZone: IST_TIMEZONE, weekday: 'short' }).format(d);
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[dowStr] !== undefined ? dowMap[dowStr] : 1;
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setTime(d.getTime() + diff * 24 * 60 * 60 * 1000);
  return getTodayDate(d);
}

/**
 * Returns the Sunday of the week containing dateObj, as YYYY-MM-DD in Asia/Kolkata.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD" of Sunday in this week
 */
function getWeekSundayDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  const dowStr = new Intl.DateTimeFormat('en-US', { timeZone: IST_TIMEZONE, weekday: 'short' }).format(d);
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[dowStr] !== undefined ? dowMap[dowStr] : 0;
  const diff = dow === 0 ? 0 : 7 - dow;
  d.setTime(d.getTime() + diff * 24 * 60 * 60 * 1000);
  return getTodayDate(d);
}

/**
 * Counts calendar days between two "YYYY-MM-DD" strings.
 * Positive if end > start. Uses local midnight arithmetic, never toISOString.
 * @param {string} startDateStr
 * @param {string} endDateStr
 * @returns {number}
 */
function daysBetween(startDateStr, endDateStr) {
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const startMs = new Date(sy, sm - 1, sd).getTime();
  const endMs   = new Date(ey, em - 1, ed).getTime();
  return Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));
}

/**
 * Shared computation for days_since_activity used across goalsService,
 * schedulerService (scoring + neglect floor), and reminders.
 * days_since_activity = days since the last log, else since created_date.
 * Never returns 999 or negative values.
 * @param {object} goalOrDates { last_log_date?, last_activity_date?, created_date?, days_since_activity? }
 * @param {string} [todayDateStr] "YYYY-MM-DD"
 * @returns {number}
 */
function computeDaysSinceActivity(goalOrDates, todayDateStr) {
  if (!goalOrDates) return 0;
  const anchor = goalOrDates.last_log_date || goalOrDates.last_activity_date || goalOrDates.created_date || null;
  if (anchor && todayDateStr) {
    return Math.max(0, daysBetween(anchor, todayDateStr));
  }
  if (typeof goalOrDates.days_since_activity === 'number' && !isNaN(goalOrDates.days_since_activity)) {
    const val = Math.max(0, Math.floor(goalOrDates.days_since_activity));
    return val >= 999 ? 0 : val;
  }
  return 0;
}

/**
 * Adds an integer number of days to a "YYYY-MM-DD" date string in Asia/Kolkata.
 * Positive numDays moves forward; negative moves backward.
 * @param {string} dateStr "YYYY-MM-DD"
 * @param {number} numDays Integer days to add
 * @returns {string} "YYYY-MM-DD"
 */
function addDaysToDate(dateStr, numDays) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(numDays || 0));
  return getTodayDate(dt);
}

module.exports = {
  getDayOfWeek,
  getTodayDate,
  getTodayDayOfWeek,
  getYesterdayDate,
  getTomorrowDate,
  getTomorrowDayOfWeek,
  parseTimeToMinutes,
  minutesToTimeString,
  getWeekMondayDate,
  getWeekSundayDate,
  daysBetween,
  addDaysToDate,
  computeDaysSinceActivity
};
