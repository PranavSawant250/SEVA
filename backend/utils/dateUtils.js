/**
 * backend/utils/dateUtils.js
 *
 * Centralized date utility functions for SEVA.
 * Ensures all dates (YYYY-MM-DD) are computed in the server's LOCAL timezone,
 * avoiding UTC offset shifts around midnight IST (+05:30).
 */

/**
 * Returns today's date (or date for given Date object) formatted as YYYY-MM-DD
 * in local server timezone.
 *
 * @param {Date} [dateObj=new Date()] Optional Date object
 * @returns {string} Date formatted as "YYYY-MM-DD"
 */
function getTodayDate(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns today's day of week name (e.g., "Monday", "Saturday") in local timezone.
 *
 * @param {Date} [dateObj=new Date()] Optional Date object
 * @returns {string} Full day name
 */
function getTodayDayOfWeek(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

module.exports = {
  getTodayDate,
  getTodayDayOfWeek
};
