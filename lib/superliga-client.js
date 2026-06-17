'use strict';

const API_BASE       = 'https://api.virtualprogaming.com/public/leagues/Superliga-Romania';
const VPG_IMAGE_BASE = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';

const POSITIONS = ['gk', 'cb', 'cdm', 'cam', 'wingers', 'strikers'];

const LEADERBOARD_NAMES = {
  gk:      'top_gk',
  cb:      'top_cb',
  cdm:     'top_cdm',
  cam:     'top_cam',
  wingers: 'top_wingers',
  strikers:'top_strikers',
};

// Higher index = more attacking = preferred when two positions share the same rank
const POS_PRIORITY = { gk: 0, cb: 1, cdm: 2, cam: 3, wingers: 4, strikers: 5 };

// ── API helpers ────────────────────────────────────────────────────────────────

async function vpgGet(urlPath) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    headers: { 'User-Agent': 'VPGRomaniaBot/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${API_BASE}${urlPath}`);
  return res.json();
}

// Number of match sessions (game slots) per calendar week.
// The leaderboard API's `week` field counts sessions, not calendar weeks.
// With 2 session days per week, the raw value is always double the real week.
const SESSIONS_PER_CALENDAR_WEEK = 2;

async function fetchCurrentSeason() {
  const seasons = await vpgGet('/seasons/');
  const arr = Array.isArray(seasons) ? seasons.map(Number).sort((a, b) => b - a) : [];
  if (!arr.length) throw new Error('No seasons found for Superliga-Romania');
  return arr[0];
}

async function fetchLeaderboard(position, season, weekly) {
  const lbName = LEADERBOARD_NAMES[position];
  if (!lbName) return { entries: [], week: null };
  const url = `${API_BASE}/leaderboard/?leaderboard=${lbName}&weekly=${weekly}&season=${season}&limit=20&offset=0`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VPGRomaniaBot/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { entries: [], week: null };
    const data = await res.json();
    return {
      entries: Array.isArray(data?.data) ? data.data : [],
      week: data?.week ?? null,
    };
  } catch { return { entries: [], week: null }; }
}

async function fetchAllLeaderboards(season, weekly) {
  const results = await Promise.allSettled(
    POSITIONS.map(pos => fetchLeaderboard(pos, season, weekly)),
  );
  const lb = {};
  let week = null;
  POSITIONS.forEach((pos, i) => {
    if (results[i].status === 'fulfilled') {
      lb[pos] = results[i].value.entries;
      if (week === null && results[i].value.week != null) week = results[i].value.week;
    } else {
      lb[pos] = [];
    }
  });
  return { leaderboards: lb, week };
}

// ── Multi-position resolution ──────────────────────────────────────────────────
// Rule: a player's position = the leaderboard where their rank is lowest (best).
// Tie on rank: prefer the more attacking position (higher POS_PRIORITY).

function resolvePositions(leaderboards) {
  const bestFor = new Map(); // username → { pos, rank }
  for (const pos of POSITIONS) {
    (leaderboards[pos] || []).forEach((player, idx) => {
      const rank     = idx + 1;
      const existing = bestFor.get(player.username);
      if (!existing
          || rank < existing.rank
          || (rank === existing.rank && POS_PRIORITY[pos] > POS_PRIORITY[existing.pos])) {
        bestFor.set(player.username, { pos, rank });
      }
    });
  }

  const used   = new Set();
  const result = { gk: [], cb: [], cdm: [], cam: [], lm: [], rm: [], st: [] };

  function fill(resultKey, sourcePos, count) {
    const list = leaderboards[sourcePos] || [];
    for (const p of list) {
      if (result[resultKey].length >= count) break;
      if (used.has(p.username)) continue;
      if (bestFor.get(p.username)?.pos === sourcePos) {
        result[resultKey].push(p);
        used.add(p.username);
      }
    }
    for (const p of list) {
      if (result[resultKey].length >= count) break;
      if (used.has(p.username)) continue;
      result[resultKey].push(p);
      used.add(p.username);
    }
  }

  fill('gk',  'gk',      1);
  fill('cb',  'cb',      3);
  fill('cdm', 'cdm',     2);
  fill('cam', 'cam',     1);
  fill('lm',  'wingers', 1);
  fill('rm',  'wingers', 1);
  fill('st',  'strikers', 2);

  // Phase 3 — rescue unplaced multi-leaderboard players
  // A player who appears in 2+ leaderboards may have been skipped in all of them
  // (Pass A skipped because bestFor was elsewhere; Pass B skipped because slot was full).
  // For each such player, find the formation slot where they rank better than the
  // worst currently-placed player, then swap them in.
  const rankIn = new Map(); // username → { pos: rank, ... }
  for (const pos of POSITIONS) {
    (leaderboards[pos] || []).forEach((p, i) => {
      if (!rankIn.has(p.username)) rankIn.set(p.username, {});
      rankIn.get(p.username)[pos] = i + 1;
    });
  }

  const SLOT_DEFS = [
    { resultKey: 'gk',  sourcePos: 'gk',      cap: 1 },
    { resultKey: 'cb',  sourcePos: 'cb',       cap: 3 },
    { resultKey: 'cdm', sourcePos: 'cdm',      cap: 2 },
    { resultKey: 'cam', sourcePos: 'cam',      cap: 1 },
    { resultKey: 'lm',  sourcePos: 'wingers',  cap: 1 },
    { resultKey: 'rm',  sourcePos: 'wingers',  cap: 1 },
    { resultKey: 'st',  sourcePos: 'strikers', cap: 2 },
  ];

  const unplaced = [...rankIn.entries()].filter(
    ([username, posRanks]) => !used.has(username) && Object.keys(posRanks).length >= 2,
  );

  for (const [username, posRanks] of unplaced) {
    let bestSwap = null;
    for (const def of SLOT_DEFS) {
      const myRank = posRanks[def.sourcePos];
      if (myRank === undefined) continue;
      const placed = result[def.resultKey];
      if (!placed.length) continue;
      let worstRank = -1, worstIdx = -1;
      placed.forEach((p, i) => {
        const r = rankIn.get(p.username)?.[def.sourcePos] ?? 9999;
        if (r > worstRank) { worstRank = r; worstIdx = i; }
      });
      if (worstIdx === -1 || myRank >= worstRank) continue;
      if (!bestSwap || myRank < bestSwap.myRank) {
        bestSwap = { def, myRank, worstIdx };
      }
    }
    if (bestSwap) {
      const lb = leaderboards[bestSwap.def.sourcePos] || [];
      const playerData = lb.find(p => p.username === username);
      if (!playerData) continue;
      const displaced = result[bestSwap.def.resultKey][bestSwap.worstIdx];
      used.delete(displaced.username);
      result[bestSwap.def.resultKey][bestSwap.worstIdx] = playerData;
      used.add(username);
    }
  }

  return result;
}

// ── League / community logos ───────────────────────────────────────────────────

let _logoCache = null;
async function fetchLeagueLogos() {
  if (_logoCache) return _logoCache;
  try {
    const [league, community] = await Promise.allSettled([
      vpgGet('/'),
      vpgGet('/community/'),
    ]);
    const lid = league.status    === 'fulfilled' ? (league.value?.logo_id    || '') : '';
    const cid = community.status === 'fulfilled' ? (community.value?.logo_id || '') : '';
    _logoCache = {
      leagueLogoUrl:    lid ? `${VPG_IMAGE_BASE}/${lid}/public` : '',
      communityLogoUrl: cid ? `${VPG_IMAGE_BASE}/${cid}/public` : '',
    };
  } catch {
    _logoCache = { leagueLogoUrl: '', communityLogoUrl: '' };
  }
  return _logoCache;
}

/**
 * Convert a raw session-week number from the leaderboard API to a calendar week.
 * The API's `week` field counts individual match sessions since season start.
 * Dividing by SESSIONS_PER_CALENDAR_WEEK corrects the value.
 *
 * @param {number} sessionWeek - Raw `week` value from the API.
 * @returns {number} Calendar week number (>= 1).
 */
function toCalendarWeek(sessionWeek) {
  return Math.max(1, Math.ceil(sessionWeek / SESSIONS_PER_CALENDAR_WEEK));
}

/**
 * Convert a datetime string to its YYYY-MM-DD day key in Bucharest time.
 *
 * @param {string} datetime
 * @returns {string}
 */
function matchDayKey(datetime) {
  try {
    const d   = new Date(datetime);
    const fmt = new Intl.DateTimeFormat('en', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(d);
    const get   = t => parts.find(p => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return ''; }
}

/**
 * Compute the 1-based etapa (season week) number for a given calendar week.
 * Counts all distinct calendar weeks that contain any match (completed or scheduled)
 * and returns the chronological rank of `targetWeekMonday`.
 *
 * This replaces the old session-count approach and correctly handles any number
 * of matches per week and rescheduled games.
 *
 * @param {number} season           - Season number.
 * @param {string} targetWeekMonday - "YYYY-MM-DD" Monday of the target week.
 * @returns {Promise<number>} 1-based etapa number (>= 1).
 */
async function computeSeasonWeekNumber(season, targetWeekMonday) {
  const PAGE = 100;

  async function fetchAll(status) {
    const all = [];
    for (let offset = 0; offset < 2000; offset += PAGE) {
      const data  = await vpgGet(`/matches/?status=${status}&season=${season}&limit=${PAGE}&offset=${offset}`);
      const batch = Array.isArray(data) ? data : (data?.data ?? data?.results ?? []);
      all.push(...batch);
      const total = Number(data?.count ?? all.length);
      if (!batch.length || all.length >= total) break;
    }
    return all;
  }

  const [comp, sched] = await Promise.allSettled([fetchAll('complete'), fetchAll('scheduled')]);
  const all = [
    ...(comp.status  === 'fulfilled' ? comp.value  : []),
    ...(sched.status === 'fulfilled' ? sched.value : []),
  ];

  const weekSet = new Set();
  for (const m of all) {
    const dt = m.datetime ?? m.date ?? '';
    if (!dt) continue;
    const dk  = matchDayKey(dt);
    if (!dk) continue;
    const d   = new Date(`${dk}T12:00:00Z`);
    const dow = d.getUTCDay();
    const diff = dow === 0 ? 6 : dow - 1;
    const mon  = new Date(d);
    mon.setUTCDate(d.getUTCDate() - diff);
    weekSet.add(mon.toISOString().slice(0, 10));
  }

  const sorted = [...weekSet].sort();
  const idx    = sorted.indexOf(targetWeekMonday);
  if (idx >= 0) return idx + 1;
  return [...sorted, targetWeekMonday].sort().indexOf(targetWeekMonday) + 1;
}

module.exports = {
  fetchCurrentSeason,
  fetchAllLeaderboards,
  resolvePositions,
  fetchLeagueLogos,
  toCalendarWeek,
  computeSeasonWeekNumber,
  matchDayKey,
  POSITIONS,
};
