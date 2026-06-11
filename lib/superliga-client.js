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

module.exports = {
  fetchCurrentSeason,
  fetchAllLeaderboards,
  resolvePositions,
  fetchLeagueLogos,
  POSITIONS,
};
