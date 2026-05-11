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

module.exports = { getNowInTimezoneMeta, shouldRunForSchedule, normalizeToDayKey, formatDayKeyForDisplay };
