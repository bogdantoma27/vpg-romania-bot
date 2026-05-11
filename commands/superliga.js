'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateClasamentImage, generateEtapaImage, formatDateRo } = require('../generators/vpg-superliga');
const { getNowInTimezoneMeta } = require('../lib/date-utils');

const API_BASE       = 'https://api.virtualprogaming.com/public/leagues/Superliga-Romania';
const VPG_IMAGE_BASE = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';
const TIMEZONE       = 'Europe/Bucharest';
const TICK_MS        = 60 * 1000;

const CH_SCHEDULE  = () => process.env.SUPERLIGA_SCHEDULE_CHANNEL_ID  || '';
const CH_RESULTS   = () => process.env.SUPERLIGA_RESULTS_CHANNEL_ID   || '';
const CH_CLASAMENT = () => process.env.SUPERLIGA_CLASAMENT_CHANNEL_ID || '';

// Schedule (Bucharest time):
const SUPERLIGA_FIXTURES_HOUR = Number(process.env.SUPERLIGA_FIXTURES_HOUR) || 10;
const SUPERLIGA_RESULTS_HOUR  = Number(process.env.SUPERLIGA_RESULTS_HOUR)  || 10;

const SCHEDULES = [
  { hour: SUPERLIGA_FIXTURES_HOUR, days: [1], targets: ['scheduled'], scheduledSessionIndex: 0 },
  { hour: SUPERLIGA_RESULTS_HOUR,  days: [3], targets: ['results', 'clasament', 'scheduled'], resultsDayOffset: -1, scheduledSessionIndex: 0 },
];

const runLog  = new Set();
let tickTimer = null;
let lastPostAt = null;

function offsetDayKey(dayKey, days) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns the Monday (YYYY-MM-DD) of the calendar week containing dayKey.
function mondayOfWeek(dayKey) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - daysFromMonday);
  return monday.toISOString().slice(0, 10);
}

// League logos — cached once per process
let _logoCache = null;
async function fetchLeagueLogos() {
  if (_logoCache) return _logoCache;
  try {
    const [league, community] = await Promise.allSettled([vpgGet('/'), vpgGet('/community/')]);
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
  if (!arr.length) throw new Error('No seasons returned');
  return arr[0];
}

async function fetchAllSeasonMatches(season) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 1000; offset += limit) {
    const data  = await vpgGet(`/matches/?status=complete&season=${season}&limit=${limit}&offset=${offset}`);
    const batch = Array.isArray(data) ? data : (data?.data ?? data?.results ?? []);
    all.push(...batch);
    const total = Number(data?.count ?? all.length);
    if (!batch.length || all.length >= total) break;
  }
  const currentYear = new Date().getFullYear();
  return all.filter(m => {
    const dt = m.datetime ?? m.date ?? '';
    if (dt && new Date(dt).getFullYear() !== currentYear) return false;
    return true;
  });
}

// tableEntries: array with { team_name, played } — used to cap form to games played this season
function computeFormMap(matches, tableEntries = []) {
  const norm = s => String(s || '').trim().toLowerCase();
  const playedMap = new Map();
  for (const e of tableEntries) playedMap.set(norm(e.team_name), Number(e.played ?? 0));

  const byTeam = new Map();
  for (const m of matches) {
    const hs = m.home_score != null ? Number(m.home_score) : null;
    const as = m.away_score != null ? Number(m.away_score) : null;
    if (hs == null || as == null) continue;
    const hN = norm(m.home_name ?? m.home_team_name ?? '');
    const aN = norm(m.away_name ?? m.away_team_name ?? '');
    const dt = m.datetime ?? m.date ?? '';
    const hR = hs > as ? 'W' : hs === as ? 'D' : 'L';
    const aR = as > hs ? 'W' : hs === as ? 'D' : 'L';
    if (hN) { if (!byTeam.has(hN)) byTeam.set(hN, []); byTeam.get(hN).push({ dt, result: hR }); }
    if (aN) { if (!byTeam.has(aN)) byTeam.set(aN, []); byTeam.get(aN).push({ dt, result: aR }); }
  }
  const formMap = new Map();
  for (const [team, arr] of byTeam) {
    arr.sort((a, b) => new Date(b.dt) - new Date(a.dt));
    const played = playedMap.get(team);
    const cap    = played != null ? Math.min(played, 5) : 5;
    formMap.set(team, arr.slice(0, cap).map(r => r.result));
  }
  return formMap;
}

async function fetchTable(season) {
  const raw  = await vpgGet(`/table/?season=${season}&is_history=false`);
  const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.results ?? []);
  return list.map((r, i) => ({
    position:        Number(r.position      ?? i + 1),
    team_name:       String(r.team_name     ?? r.name         ?? ''),
    team_abbr:       String(r.team_abbr     ?? r.abbreviation ?? ''),
    team_logo:       String(r.team_logo     ?? r.logo         ?? ''),
    played:          Number(r.played        ?? 0),
    wins:            Number(r.wins          ?? 0),
    draws:           Number(r.draws         ?? 0),
    losses:          Number(r.losses        ?? 0),
    score_for:       Number(r.score_for     ?? 0),
    score_against:   Number(r.score_against ?? 0),
    goal_difference: Number(r.goal_difference ?? (Number(r.score_for ?? 0) - Number(r.score_against ?? 0))),
    points:          Number(r.points        ?? 0),
  }));
}

function matchDayKey(datetime) {
  try {
    const d    = new Date(datetime);
    const fmt  = new Intl.DateTimeFormat('en', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(d);
    const get  = t => parts.find(p => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return ''; }
}

function mapMatch(r) {
  return {
    id:         Number(r.id),
    match_day:  Number(r.match_day  ?? r.round           ?? 0),
    home_name:  String(r.home_name  ?? r.home_team_name  ?? ''),
    home_logo:  String(r.home_logo  ?? r.home_team_logo  ?? ''),
    away_name:  String(r.away_name  ?? r.away_team_name  ?? ''),
    away_logo:  String(r.away_logo  ?? r.away_team_logo  ?? ''),
    home_score: r.home_score != null ? Number(r.home_score) : null,
    away_score: r.away_score != null ? Number(r.away_score) : null,
    datetime:   String(r.datetime   ?? r.date            ?? ''),
  };
}

// Fetch scheduled matches for a game week by session index.
// Groups all scheduled matches by their Mon–Sun calendar week, sorts ascending,
// and returns the week at sessionIndex (0 = nearest upcoming, 1 = one beyond, …).
async function fetchScheduledByGameWeek(season, sessionIndex = 0) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const data  = await vpgGet(`/matches/?status=scheduled&season=${season}&limit=${limit}&offset=${offset}`);
    const batch = Array.isArray(data) ? data : (data?.data ?? data?.results ?? []);
    all.push(...batch);
    const total = Number(data?.count ?? all.length);
    if (!batch.length || all.length >= total) break;
  }
  const byWeek = new Map();
  for (const m of all.map(mapMatch)) {
    const dk = matchDayKey(m.datetime);
    if (!dk) continue;
    const wk = mondayOfWeek(dk);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(m);
  }
  const sortedWeeks = [...byWeek.keys()].sort();
  if (sessionIndex >= sortedWeeks.length) return [];
  return (byWeek.get(sortedWeeks[sessionIndex]) ?? [])
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

async function fetchMatchesForDay(season, status, dayKey) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const data  = await vpgGet(`/matches/?status=${status}&season=${season}&limit=${limit}&offset=${offset}`);
    const batch = Array.isArray(data) ? data : (data?.data ?? data?.results ?? []);
    all.push(...batch);
    const total = Number(data?.count ?? all.length);
    if (!batch.length || all.length >= total) break;
  }
  return all
    .map(mapMatch)
    .filter(m => m.datetime && matchDayKey(m.datetime) === dayKey)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// Fetch the latest completed session's matches — used for results force-post.
async function fetchLatestEtapaMatches(season) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const data  = await vpgGet(`/matches/?status=complete&season=${season}&limit=${limit}&offset=${offset}`);
    const batch = Array.isArray(data) ? data : (data?.data ?? data?.results ?? []);
    all.push(...batch);
    const total = Number(data?.count ?? all.length);
    if (!batch.length || all.length >= total) break;
  }
  const currentYear = new Date().getFullYear();
  const mapped = all
    .filter(r => { const dt = r.datetime ?? r.date ?? ''; return dt && new Date(dt).getFullYear() === currentYear; })
    .map(mapMatch);
  if (!mapped.length) return [];
  const sorted     = [...mapped].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const sessionDay = matchDayKey(sorted[sorted.length - 1].datetime);
  return mapped
    .filter(m => matchDayKey(m.datetime) === sessionDay)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// ── Posting helpers ────────────────────────────────────────────────────────────

async function postAndClean(channel, imgPath) {
  await channel.send({ files: [imgPath] });
  try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
}

async function getChannel(client, id) {
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(id);
    return ch?.isTextBased() ? ch : null;
  } catch { return null; }
}

// ── Run targets ────────────────────────────────────────────────────────────────

async function runTargets(client, targets, dayKey, { force = false, resultsDayKey, scheduledSessionIndex = 0 } = {}) {
  const targetSet = new Set(targets);
  let posted = 0;
  let season;
  try { season = await fetchCurrentSeason(); }
  catch (err) { console.error('[Superliga] Could not fetch season:', err.message); return { posted: 0, warnings: ['Could not fetch season'] }; }

  const { leagueLogoUrl, communityLogoUrl } = await fetchLeagueLogos();

  const warnings = [];
  let allCompleted = [], entries = [];
  try {
    [allCompleted, entries] = await Promise.all([
      fetchAllSeasonMatches(season),
      fetchTable(season),
    ]);
  } catch (err) { console.error('[Superliga] Failed to fetch base data:', err.message); }

  const formMap   = computeFormMap(allCompleted, entries);
  const maxPlayed = entries.reduce((m, e) => Math.max(m, e.played ?? 0), 0);

  if (targetSet.has('clasament')) {
    try {
      if (entries.length) {
        const imgPath = await generateClasamentImage({ entries, seasonLabel: `Sezon ${season}`, leagueLogoUrl, communityLogoUrl, formMap });
        const ch = await getChannel(client, CH_CLASAMENT());
        if (ch) { await postAndClean(ch, imgPath); posted++; console.log('[Superliga] Posted clasament.'); }
        else { warnings.push('No clasament channel configured (SUPERLIGA_CLASAMENT_CHANNEL_ID).'); console.warn('[Superliga] No clasament channel configured.'); }
      } else { warnings.push('Clasament table empty — nothing to post.'); }
    } catch (err) { warnings.push(`Clasament error: ${err.message}`); console.error('[Superliga] Clasament error:', err.message); }
  }

  for (const target of ['scheduled', 'results']) {
    if (!targetSet.has(target)) continue;
    const channelId = target === 'results' ? CH_RESULTS() : CH_SCHEDULE();
    try {
      let matches;

      if (target === 'scheduled') {
        matches = await fetchScheduledByGameWeek(season, scheduledSessionIndex);
        if (!matches.length) {
          const label = scheduledSessionIndex === 0 ? 'nearest upcoming' : `+${scheduledSessionIndex} game week(s)`;
          const msg   = `No scheduled matches found (${label}).`;
          warnings.push(msg);
          console.log(`[Superliga] ${msg}`);
          continue;
        }
      } else {
        const effectiveDay = resultsDayKey || dayKey;
        matches = force
          ? await fetchLatestEtapaMatches(season)
          : await fetchMatchesForDay(season, 'complete', effectiveDay);
        if (!matches.length) {
          const msg = force ? 'No completed matches found.' : `No results for ${effectiveDay}.`;
          warnings.push(msg);
          console.log(`[Superliga] ${msg}`);
          continue;
        }
      }

      const byMatchDay      = new Map();
      for (const m of matches) {
        if (!byMatchDay.has(m.match_day)) byMatchDay.set(m.match_day, []);
        byMatchDay.get(m.match_day).push(m);
      }
      const sortedMatchDays = [...byMatchDay.keys()].sort((a, b) => a - b);
      const sessionSize     = sortedMatchDays.length;

      for (let idx = 0; idx < sessionSize; idx++) {
        const absDay     = sortedMatchDays[idx];
        const dayMatches = byMatchDay.get(absDay);
        const etapaNumber = target === 'results'
          ? maxPlayed - (sessionSize - 1 - idx)
          : maxPlayed + idx + 1;
        const dateLabel  = formatDateRo(dayMatches[0].datetime);
        const imgPath    = await generateEtapaImage({ matches: dayMatches, etapaNumber, dateLabel, isResults: target === 'results', leagueLogoUrl, communityLogoUrl });
        const ch         = await getChannel(client, channelId);
        if (ch) { await postAndClean(ch, imgPath); posted++; console.log(`[Superliga] Posted ${target} etapa ${etapaNumber} (${dayMatches.length} match(es)).`); }
        else { warnings.push(`No channel for ${target} (SUPERLIGA_${target === 'results' ? 'RESULTS' : 'SCHEDULE'}_CHANNEL_ID not set).`); console.warn(`[Superliga] No channel for ${target}.`); }
      }
    } catch (err) { warnings.push(`${target} error: ${err.message}`); console.error(`[Superliga] ${target} error:`, err.message); }
  }
  if (posted > 0) lastPostAt = new Date().toISOString();
  return { posted, warnings };
}

// ── Schedule tick ──────────────────────────────────────────────────────────────

async function tick(client) {
  const meta = getNowInTimezoneMeta(TIMEZONE);
  for (const sched of SCHEDULES) {
    if (!sched.days.includes(meta.weekday)) continue;
    if (meta.hour !== sched.hour) continue;
    const slotKey = `${meta.dayKey}:${sched.hour}:superliga`;
    if (runLog.has(slotKey)) continue;
    runLog.add(slotKey);
    const resultsDayKey        = sched.resultsDayOffset ? offsetDayKey(meta.dayKey, sched.resultsDayOffset) : meta.dayKey;
    const scheduledSessionIndex = sched.scheduledSessionIndex ?? 0;
    console.log(`[Superliga] Firing schedule hour=${sched.hour} targets=${sched.targets.join(',')} day=${meta.dayKey}`);
    await runTargets(client, sched.targets, meta.dayKey, { resultsDayKey, scheduledSessionIndex }).catch(err => console.error('[Superliga] Tick error:', err.message));
  }
}

// ── Slash command ──────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('superliga')
  .setDescription('Manage VPG Superliga România auto-posting')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub.setName('start').setDescription('Start automatic schedule monitoring'))
  .addSubcommand(sub => sub.setName('stop').setDescription('Stop automatic schedule monitoring'))
  .addSubcommand(sub =>
    sub.setName('post')
      .setDescription('Force-post right now')
      .addStringOption(opt =>
        opt.setName('targets')
          .setDescription('What to post (default: all)')
          .addChoices(
            { name: 'All',                              value: 'all'                      },
            { name: 'Clasament only',                   value: 'clasament'                },
            { name: 'Meciuri programate (sapt. viit.)', value: 'scheduled'                },
            { name: 'Meciuri programate (sapt. cur.)',  value: 'scheduled_current'        },
            { name: 'Rezultate',                        value: 'results'                  },
            { name: 'Rezultate + Clasament',            value: 'results,clasament'        },
            { name: 'Programate + Clasament',           value: 'scheduled,clasament'      },
          )
      )
  );

module.exports = {
  data,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      if (tickTimer) {
        await interaction.reply({ content: 'Superliga monitoring is already running.', ephemeral: true });
        return;
      }
      tickTimer = setInterval(() => tick(interaction.client).catch(console.error), TICK_MS);
      await interaction.reply({ content: '✅ Started Superliga România monitoring (checks every minute).', ephemeral: true });
      return;
    }

    if (sub === 'stop') {
      if (!tickTimer) {
        await interaction.reply({ content: 'Superliga monitoring is not running.', ephemeral: true });
        return;
      }
      clearInterval(tickTimer);
      tickTimer = null;
      await interaction.reply({ content: '🛑 Stopped Superliga România monitoring.', ephemeral: true });
      return;
    }

    if (sub === 'post') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const raw  = interaction.options.getString('targets') || 'all';
        const meta = getNowInTimezoneMeta(TIMEZONE);
        const isCurrentWeek        = raw === 'scheduled_current' || raw.includes('scheduled_current');
        const scheduledSessionIndex = isCurrentWeek ? 0 : 1;
        const targets = raw === 'all'
          ? ['scheduled', 'results', 'clasament']
          : raw.split(',').map(t => t === 'scheduled_current' ? 'scheduled' : t);
        const { posted, warnings } = await runTargets(interaction.client, targets, meta.dayKey, { force: true, scheduledSessionIndex });
        const lines = [];
        if (posted > 0) lines.push(`✅ Posted ${posted} image(s) (targets: ${targets.join(', ')}).`);
        else lines.push(`⚠️ No images posted (targets: ${targets.join(', ')}).`);
        if (warnings.length) lines.push(...warnings.map(w => `• ${w}`));
        await interaction.editReply(lines.join('\n'));
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },

  startMonitoring(client) {
    if (tickTimer) return false;
    tickTimer = setInterval(() => tick(client).catch(console.error), TICK_MS);
    console.log('[Superliga] Auto-started monitoring.');
    return true;
  },

  stopMonitoring() {
    if (!tickTimer) return false;
    clearInterval(tickTimer);
    tickTimer = null;
    return true;
  },

  getStatus: () => ({ running: tickTimer !== null, lastPostAt }),
};
