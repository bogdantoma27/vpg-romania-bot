'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTeamReportImage, isRomania } = require('../generators/vpg-national-team');
const { getNowInTimezoneMeta } = require('../lib/date-utils');

const TOURNAMENTS = [
  { slug: 'World-Esports-Cup',        name: 'VPG World Cup',      baseSeason: 4 },
  { slug: 'International-eLeague-KO', name: 'VPG Internationals', baseSeason: 3 },
];

const VPG_API_BASE   = 'https://api.virtualprogaming.com/public';
const VPG_IMAGE_BASE = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';
const { config: channelConfig } = require('../lib/channel-config');
const TIMEZONE       = 'Europe/Bucharest';
const TICK_MS        = 60 * 1000;

const SCHEDULES = [
  { hour: Number(process.env.VPG_NATIONAL_TEAM_HOUR) || 12, days: [1, 2, 3] },
];

// Tournament logo cache — process-wide, logos don't change
const _tournamentLogos = new Map();

// Poll state
const lastReportHashByTeam = new Map();
const seededTeams          = new Set();
const runLog               = new Set();
let tickTimer              = null;
let lastPostAt             = null;
let nextRunAt              = null;

// ── API helpers ────────────────────────────────────────────────────────────────

async function vpgGet(urlPath) {
  const res = await fetch(`${VPG_API_BASE}${urlPath}`, {
    headers: { 'User-Agent': 'VPGRomaniaBot/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${VPG_API_BASE}${urlPath}`);
  return res.json();
}

async function fetchTournamentLogos(slug) {
  if (_tournamentLogos.has(slug)) return _tournamentLogos.get(slug);
  try {
    const [t, c] = await Promise.allSettled([
      vpgGet(`/tournaments/${encodeURIComponent(slug)}/`),
      vpgGet(`/tournaments/${encodeURIComponent(slug)}/community/`),
    ]);
    const lid = t.status === 'fulfilled' ? (t.value?.logo_id || '') : '';
    const cid = c.status === 'fulfilled' ? (c.value?.logo_id || '') : '';
    const result = {
      leagueLogoUrl:    lid ? `${VPG_IMAGE_BASE}/${lid}/public` : '',
      communityLogoUrl: cid ? `${VPG_IMAGE_BASE}/${cid}/public` : '',
    };
    _tournamentLogos.set(slug, result);
    return result;
  } catch {
    const result = { leagueLogoUrl: '', communityLogoUrl: '' };
    _tournamentLogos.set(slug, result);
    return result;
  }
}

// Normalises the many shapes the VPG tournament API can return:
//   direct array, { data: [...] }, { results: [...] }
function normalizeArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function detectCurrentSeason(slug, baseSeason) {
  let current = baseSeason;
  for (let s = baseSeason + 1; s <= baseSeason + 15; s++) {
    try {
      const data = await vpgGet(`/tournaments/${encodeURIComponent(slug)}/matches/?match_status=complete&season=${s}&limit=1&offset=0`);
      if (normalizeArray(data).length > 0) current = s;
      else break;
    } catch { break; }
  }
  return current;
}

async function fetchGroups(slug, season) {
  return vpgGet(`/tournaments/${encodeURIComponent(slug)}/groups/?season=${season}`);
}

async function fetchAllGroupMatches(slug, season) {
  const all = []; let offset = 0; const limit = 25;
  while (true) {
    const data  = await vpgGet(`/tournaments/${encodeURIComponent(slug)}/matches/?match_status=complete&season=${season}&limit=${limit}&offset=${offset}`);
    const total = Number(data?.count) || 0;
    const batch = normalizeArray(data);
    all.push(...batch);
    if (!batch.length) break;
    if (total > 0 && all.length >= total) break;
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

async function fetchTotalKnockoutRounds(slug, season) {
  try {
    const data = await vpgGet(`/tournaments/${encodeURIComponent(slug)}/knockout/total_rounds/?season=${season}`);
    return Number(data.total_rounds) || 0;
  } catch { return 0; }
}

async function fetchKnockoutMatches(slug, season, round) {
  const data = await vpgGet(`/tournaments/${encodeURIComponent(slug)}/knockout/matches/?round_num=${round}&season=${season}`);
  return normalizeArray(data);
}

function findRomaniaGroups(rawGroups) {
  const groups = normalizeArray(rawGroups);
  const found = [];
  for (let i = 0; i < groups.length; i++) {
    const g = Array.isArray(groups[i]) ? groups[i] : normalizeArray(groups[i]);
    if (g.some(t => isRomania(t.team_name))) found.push({ group: g, groupNumber: i + 1 });
  }
  return found;
}

function teamHash(group, matchIds) {
  return JSON.stringify({
    standings: group.map(t => ({ n: t.team_name, pts: t.points, p: t.played, w: t.wins, d: t.draws, l: t.losses, gf: t.score_for, ga: t.score_against })),
    matchIds: [...matchIds].sort(),
  });
}

async function postAndClean(channel, imagePath) {
  await channel.send({ files: [imagePath] });
  try { await fs.promises.unlink(imagePath); } catch { /* ignore */ }
}

// ── Poll cycle ─────────────────────────────────────────────────────────────────

async function runPollCycle(client, { force = false } = {}) {
  if (!channelConfig.nationalTeamChannelId) {
    console.warn('[NationalTeam] nationalTeamChannelId not set — skipping.');
    return;
  }
  let channel;
  try {
    channel = await client.channels.fetch(channelConfig.nationalTeamChannelId);
    if (!channel?.isTextBased()) { console.error('[NationalTeam] Channel not found or not text-based.'); return; }
  } catch (err) { console.error('[NationalTeam] Could not fetch channel:', err.message); return; }

  for (const tournament of TOURNAMENTS) {
    try { await processTournament(tournament, channel, { force }); }
    catch (err) { console.error(`[NationalTeam][${tournament.slug}]`, err.message); }
  }
}

async function processTournament({ slug, name, baseSeason }, channel, { force = false } = {}) {
  console.log(`[NationalTeam] Processing: ${slug}`);
  const [season, logos] = await Promise.all([detectCurrentSeason(slug, baseSeason), fetchTournamentLogos(slug)]);
  console.log(`[NationalTeam] ${slug} → season ${season}`);

  let groups;
  try { groups = await fetchGroups(slug, season); }
  catch (err) { console.warn(`[NationalTeam] Could not fetch groups (${slug}):`, err.message); return; }

  const romaniaGroups = findRomaniaGroups(groups);
  if (!romaniaGroups.length) { console.log(`[NationalTeam] No Romania teams in ${slug}`); return; }

  let allGroupMatches = [];
  try { allGroupMatches = await fetchAllGroupMatches(slug, season); }
  catch (err) { console.warn('[NationalTeam] Could not fetch group matches:', err.message); }

  const allKoMatches = [];
  try {
    const totalRounds = await fetchTotalKnockoutRounds(slug, season);
    for (let round = 1; round <= totalRounds; round++) {
      try {
        const m = await fetchKnockoutMatches(slug, season, round);
        allKoMatches.push(...m.filter(x => x.status === 'complete'));
      } catch { /* skip */ }
    }
  } catch { /* no knockout yet */ }

  const norm = s => String(s || '').trim().toLowerCase();

  for (const { group, groupNumber } of romaniaGroups) {
    for (const teamRow of group.filter(t => isRomania(t.team_name))) {
      const romaniaTeam = teamRow.team_name;
      const teamKey     = `${slug}:${romaniaTeam}`;
      const teamNorm    = norm(romaniaTeam);
      const teamMatches = [
        ...allGroupMatches.filter(m => norm(m.home_name) === teamNorm || norm(m.away_name) === teamNorm),
        ...allKoMatches.filter(m => norm(m.home_name) === teamNorm || norm(m.away_name) === teamNorm),
      ];
      const hash = teamHash(group, teamMatches.map(m => m.id));

      if (!force) {
        if (!seededTeams.has(teamKey)) {
          lastReportHashByTeam.set(teamKey, hash);
          seededTeams.add(teamKey);
          console.log(`[NationalTeam] Seeded ${romaniaTeam} — ${teamMatches.length} match(es)`);
          continue;
        }
        if (hash === lastReportHashByTeam.get(teamKey)) continue;
      }

      lastReportHashByTeam.set(teamKey, hash);
      seededTeams.add(teamKey);

      try {
        const imgPath = await generateTeamReportImage({
          tournamentName: name, season, romaniaTeamName: romaniaTeam,
          group, groupNumber, matches: teamMatches,
          leagueLogoUrl: logos.leagueLogoUrl, communityLogoUrl: logos.communityLogoUrl,
        });
        await postAndClean(channel, imgPath);
        lastPostAt = new Date().toISOString();
        console.log(`[NationalTeam] Posted: ${romaniaTeam} (${slug}), ${teamMatches.length} match(es)`);
      } catch (err) {
        console.error(`[NationalTeam] Image error for ${romaniaTeam}:`, err.message);
      }
    }
  }
}

// ── Tick (minute-level schedule check) ────────────────────────────────────────

async function tick(client) {
  const { weekday, hour, dayKey } = getNowInTimezoneMeta(TIMEZONE);
  for (const slot of SCHEDULES) {
    if (!slot.days.includes(weekday)) continue;
    if (slot.hour !== hour) continue;
    const key = `${dayKey}:${slot.hour}`;
    if (runLog.has(key)) continue;
    runLog.add(key);
    await runPollCycle(client).catch(err => console.error('[NationalTeam] Poll error:', err.message));
  }
}

// ── Slash command ──────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('national-team')
  .setDescription('Manage VPG Romania national team results auto-posting')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('start').setDescription('Start automatic monitoring (Mon/Tue/Wed at 12:00 Bucharest time)'))
  .addSubcommand(s => s.setName('stop').setDescription('Stop automatic monitoring'))
  .addSubcommand(s => s.setName('post').setDescription('Trigger a check right now'));

module.exports = {
  data,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      if (tickTimer) {
        await interaction.reply({ content: 'VPG national team monitoring is already running.', ephemeral: true });
        return;
      }
      nextRunAt = new Date(Date.now() + TICK_MS).toISOString();
      tickTimer = setInterval(() => { nextRunAt = new Date(Date.now() + TICK_MS).toISOString(); tick(interaction.client).catch(console.error); }, TICK_MS);
      await interaction.reply({ content: '✅ Started VPG Romania national team monitoring (Mon/Tue/Wed at 12:00 Bucharest time).', ephemeral: true });
      return;
    }

    if (sub === 'stop') {
      if (!tickTimer) {
        await interaction.reply({ content: 'VPG national team monitoring is not running.', ephemeral: true });
        return;
      }
      clearInterval(tickTimer);
      tickTimer = null;
      nextRunAt = null;
      await interaction.reply({ content: '🛑 Stopped VPG Romania national team monitoring.', ephemeral: true });
      return;
    }

    if (sub === 'post') {
      await interaction.deferReply({ ephemeral: true });
      try {
        await runPollCycle(interaction.client, { force: true });
        await interaction.editReply('✅ VPG Romania national team results posted.');
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },

  startMonitoring(client) {
    if (tickTimer) return false;
    nextRunAt = new Date(Date.now() + TICK_MS).toISOString();
    tickTimer = setInterval(() => { nextRunAt = new Date(Date.now() + TICK_MS).toISOString(); tick(client).catch(console.error); }, TICK_MS);
    console.log('[NationalTeam] Auto-started monitoring (Mon/Tue/Wed at 12:00 Bucharest time).');
    return true;
  },

  stopMonitoring() {
    if (!tickTimer) return false;
    clearInterval(tickTimer);
    tickTimer = null;
    nextRunAt = null;
    return true;
  },

  getStatus: () => ({ running: tickTimer !== null, lastPostAt, nextRunAt }),
};
