'use strict';

function formatInTimeZone(date, timezone, options) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...options }).format(date);
}

function getNowInTimezoneMeta(timezone) {
  const now = new Date();
  const weekdayShort = formatInTimeZone(now, timezone, { weekday: 'short' });
  const hour  = Number(formatInTimeZone(now, timezone, { hour: '2-digit', hour12: false }));
  const dayKey = formatInTimeZone(now, timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/').reverse().join('-');

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { now, weekday: weekdayMap[weekdayShort], hour, dayKey };
}

function shouldRunForSchedule({ timezone, targetHour, targetDays }) {
  const meta = getNowInTimezoneMeta(timezone);
  return { ...meta, shouldRun: targetDays.includes(meta.weekday) && meta.hour === targetHour };
}

function normalizeToDayKey(value, timezone) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatInTimeZone(date, timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/').reverse().join('-');
}

function formatDayKeyForDisplay(dayKey, timezone) {
  if (!dayKey) return '';
  const date = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return formatInTimeZone(date, timezone, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Returns the ISO string of the nearest upcoming scheduled run given an array of
 * { hour, days } slots (days: weekday numbers 0=Sun … 6=Sat) in `timezone`.
 * Returns null if schedules is empty or monitor is stopped.
 */
function computeNextScheduledRunAt(schedules, timezone) {
  const now = new Date();
  const toWeekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const fmt = (d, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...opts }).format(d);
  const localHour    = d => Number(fmt(d, { hour: '2-digit', hour12: false }));
  const localDateStr = d => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); // DD/MM/YYYY

  const curWeekday = toWeekday[fmt(now, { weekday: 'short' })];
  const curHour    = localHour(now);
  let nearest = null;

  for (const slot of [].concat(schedules)) {
    for (const targetDay of slot.days) {
      let daysAhead = (targetDay - curWeekday + 7) % 7;
      if (daysAhead === 0 && curHour >= slot.hour) daysAhead = 7;

      const targetBase    = new Date(now.getTime() + daysAhead * 86400000);
      const targetDateStr = localDateStr(targetBase); // DD/MM/YYYY
      const [dd, mm, yyyy] = targetDateStr.split('/').map(Number);

      // Find UTC hour where local time = slot.hour on that local calendar date.
      // Tries deltas -5…+1 which covers UTC+0 through UTC+3 (and most other zones).
      let candidate = null;
      for (let delta = -5; delta <= 1; delta++) {
        const utcH  = ((slot.hour + delta) % 24 + 24) % 24;
        const probe = new Date(Date.UTC(yyyy, mm - 1, dd, utcH, 0, 0, 0));
        if (localHour(probe) === slot.hour && localDateStr(probe) === targetDateStr) {
          candidate = probe;
          break;
        }
      }

      if (candidate && (!nearest || candidate < nearest)) nearest = candidate;
    }
  }

  return nearest ? nearest.toISOString() : null;
}

module.exports = { getNowInTimezoneMeta, shouldRunForSchedule, normalizeToDayKey, formatDayKeyForDisplay, computeNextScheduledRunAt };
