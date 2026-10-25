/**
 * backend/utils/dateUtils.js
 *
 * Centralized date and time utility functions for SEVA.
 * Ensures all dates (YYYY-MM-DD) are computed in the server's LOCAL timezone,
 * avoiding UTC offset shifts around midnight IST (+05:30).
 *
 * Rule: NEVER use toISOString() for dates. All functions use local Date methods.
 */

/**
 * Returns today's date (or date for given Date object) formatted as YYYY-MM-DD
 * in local server timezone.
 * @param {Date} [dateObj=new Date()] Optional Date object
 * @returns {string} "YYYY-MM-DD"
 */
function getTodayDate(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns today's day of week name (e.g., "Monday") in local timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} Full day name
 */
function getTodayDayOfWeek(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

/**
 * Returns yesterday's date formatted as YYYY-MM-DD in local timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD"
 */
function getYesterdayDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  d.setDate(d.getDate() - 1);
  return getTodayDate(d);
}

/**
 * Returns tomorrow's date formatted as YYYY-MM-DD in local timezone.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD"
 */
function getTomorrowDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  d.setDate(d.getDate() + 1);
  return getTodayDate(d);
}

/**
 * Returns tomorrow's day of week name (e.g., "Tuesday") in local timezone.
 * Used by the nightly check-in to build tomorrow's outline.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} Full day name
 */
function getTomorrowDayOfWeek(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

/**
 * Converts "H:MM AM/PM" to minutes since midnight.
 * Moved here from routes/timetable.js so the scheduler and other services
 * can use it without importing a route file.
 * @param {string} timeStr e.g. "9:00 AM", "1:30 PM"
 * @returns {number|null} Minutes since midnight, or null if unparseable
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
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
 * Returns the Monday of the week containing dateObj, as YYYY-MM-DD (local).
 * Used by frequency goals to compute days_this_week.
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD" of Monday in this week
 */
function getWeekMondayDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  const dow = d.getDay(); // 0=Sun 1=Mon ... 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return getTodayDate(d);
}

/**
 * Returns the Sunday of the week containing dateObj, as YYYY-MM-DD (local).
 * @param {Date} [dateObj=new Date()]
 * @returns {string} "YYYY-MM-DD" of Sunday in this week
 */
function getWeekSundayDate(dateObj = new Date()) {
  const d = new Date(dateObj instanceof Date ? dateObj.getTime() : new Date(dateObj).getTime());
  const dow = d.getDay();
  const diff = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + diff);
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

module.exports = {
  getTodayDate,
  getTodayDayOfWeek,
  getYesterdayDate,
  getTomorrowDate,
  getTomorrowDayOfWeek,
  parseTimeToMinutes,
  minutesToTimeString,
  getWeekMondayDate,
  getWeekSundayDate,
  daysBetween
};
