'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const VPG_API_BASE         = 'https://api.virtualprogaming.com/public';
const MOVEMENT_BASE        = `${VPG_API_BASE}/communities/VPGRoPS5/movement/`;
const POLL_INTERVAL_MS     = (Number(process.env.TRANSFERS_POLL_MINUTES) || 20) * 60 * 1000;
const { config: channelConfig } = require('../lib/channel-config');
const VPG_CDN              = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';
const MAX_CLUBS_PER_SEASON = 2;
const SEASON_START         = process.env.TRANSFERS_SEASON_START ? new Date(process.env.TRANSFERS_SEASON_START) : null;

let lastTransferId = null;
let pollTimer      = null;
let nextRunAt      = null;
let communityId    = null;
let lastPostAt     = null;

// username → Set<clubName> — only VPGRoPS5 community clubs, current season
const playerClubHistory = new Map();
// username → Set<team_slug> — contracts cache for VPGRoPS5 community
const contractCache = new Map();
// username → Set<from_slug> — clubs the player departed from this season (departure = confirmed presence)
const playerFromSlugs = new Map();

function logoUrl(id) {
  return id ? `${VPG_CDN}/${id}/smThumb` : null;
}

function formatFee(amount) {
  if (!amount) return 'Free Transfer';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

function formatDate(dt) {
  try {
    const formatted = new Date(dt).toLocaleString('ro-RO', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `${formatted} (ora României)`;
  } catch { return dt; }
}

function makeEmbed(t) {
  const embed = new EmbedBuilder()
    .setColor(0x1f8b4c)
    .setTitle('⚽ HERE WE GO')
    .addFields(
      { name: '👤 Player', value: t.username   || 'Unknown Player', inline: false },
      { name: '🏟️ From',  value: t.from_name  || 'Free Agent',     inline: true  },
      { name: '➡️ To',    value: t.to_name    || 'Free Agent',     inline: true  },
      { name: '💰 Fee',   value: formatFee(t.amount),              inline: false },
      { name: '📅 Date',  value: formatDate(t.datetime),           inline: false },
    )
    .setTimestamp();
  const from = logoUrl(t.from_logo);
  const to   = logoUrl(t.to_logo);
  if (from) embed.setAuthor({ name: t.from_name || 'Free Agent', iconURL: from });
  if (to)   embed.setThumbnail(to);
  else if (from) embed.setThumbnail(from);
  return embed;
}

function isRealClub(name) {
  return typeof name === 'string' && name.trim() !== '' && name.toLowerCase() !== 'free agent';
}

async function fetchCommunityId() {
  const res = await fetch(`${VPG_API_BASE}/communities/VPGRoPS5/`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  communityId = data.id;
  console.log(`[Transfers] VPGRoPS5 community_id = ${communityId}`);
}

async function fetchUserVPGRoSlugs(username) {
  if (contractCache.has(username)) return contractCache.get(username);
  try {
    const res  = await fetch(`${VPG_API_BASE}/users/${encodeURIComponent(username)}/contracts/`, { signal: AbortSignal.timeout(15000) });
    const data = res.ok ? await res.json() : [];
    const list = Array.isArray(data) ? data : (data?.data ?? []);
    const slugs = new Set(
      list.filter(c => c.community_id === communityId && c.team_slug).map(c => c.team_slug)
    );
    contractCache.set(username, slugs);
    return slugs;
  } catch {
    contractCache.set(username, new Set());
    return new Set();
  }
}

async function isVPGRoClub(username, toSlug) {
  if (!communityId || !username || !toSlug) return false;
  const slugs = await fetchUserVPGRoSlugs(username);
  if (slugs.has(toSlug)) return true;
  return (playerFromSlugs.get(username) ?? new Set()).has(toSlug);
}

async function recordTransferHistory(t) {
  const { username, to_name, to_slug } = t;
  if (!username || !to_slug || !isRealClub(to_name)) return;
  if (!await isVPGRoClub(username, to_slug)) return;
  if (!playerClubHistory.has(username)) playerClubHistory.set(username, new Set());
  playerClubHistory.get(username).add(to_name);
}

async function checkClubLimit(t) {
  const { username, to_name, to_slug } = t;
  if (!username || !to_slug || !isRealClub(to_name)) return null;
  if (!await isVPGRoClub(username, to_slug)) return null;

  const existing = new Set(playerClubHistory.get(username) || []);
  if (existing.has(to_name)) return null;

  const newCount = existing.size + 1;
  if (newCount <= MAX_CLUBS_PER_SEASON) return null;
  return { username, toClub: to_name, newCount, clubs: [...existing, to_name] };
}

async function postClubWarning(client, { username, toClub, newCount, clubs }) {
  if (!channelConfig.clubLimitChannelId) return;
  try {
    const ch = await client.channels.fetch(channelConfig.clubLimitChannelId);
    if (!ch?.isTextBased()) return;
    const clubList = clubs.map(c => `**${c}**`).join(', ');
    const ordinal  = newCount === 2 ? '2nd' : newCount === 3 ? '3rd' : `${newCount}th`;
    const content  = newCount === MAX_CLUBS_PER_SEASON + 1
      ? `⚠️ **Club Limit Exceeded** — **${username}** joined **${toClub}** (their ${ordinal} club this season: ${clubList}).\nThis player has exceeded the ${MAX_CLUBS_PER_SEASON}-club limit — they **cannot** be registered for another team.`
      : `🚨 **Club Limit Exceeded Again** — **${username}** is joining **${toClub}** (their ${ordinal} club this season: ${clubList}).\nThis player is **already ineligible** for further transfers this season!`;
    await ch.send({ content });
  } catch (err) {
    console.error('[Transfers] Club warning error:', err.message);
  }
}

async function fetchTransfers(limit = 12) {
  const res = await fetch(`${MOVEMENT_BASE}?limit=${limit}&offset=0`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchAllTransfers() {
  const PAGE = 100;
  const all  = [];
  let offset = 0;
  while (true) {
    const res  = await fetch(`${MOVEMENT_BASE}?limit=${PAGE}&offset=${offset}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const page = Array.isArray(data.data) ? data.data : [];
    if (!page.length) break;
    all.push(...page);
    offset += page.length;
  }
  return all;
}

async function seedHistory() {
  await fetchCommunityId();
  const ts = await fetchAllTransfers();
  if (!ts.length) return;
  ts.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  lastTransferId = Math.max(...ts.map(t => t.id));
  const season = SEASON_START ? ts.filter(t => new Date(t.datetime) >= SEASON_START) : ts;
  for (const t of season) {
    if (!t.username || !t.from_slug) continue;
    if (!playerFromSlugs.has(t.username)) playerFromSlugs.set(t.username, new Set());
    playerFromSlugs.get(t.username).add(t.from_slug);
  }
  const uniqueUsers = [...new Set(season.filter(t => t.username).map(t => t.username))];
  const BATCH = 10;
  for (let i = 0; i < uniqueUsers.length; i += BATCH) {
    await Promise.allSettled(uniqueUsers.slice(i, i + BATCH).map(u => fetchUserVPGRoSlugs(u)));
  }
  for (const t of season) await recordTransferHistory(t);
  console.log(`[Transfers] Seeded lastTransferId=${lastTransferId}, tracked ${playerClubHistory.size} players.`);
}

async function poll(client) {
  if (!channelConfig.transfersChannelId) return;
  try {
    const transfers = await fetchTransfers();
    if (!transfers.length) return;
    transfers.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    const fresh = lastTransferId
      ? transfers.filter(t => t.id > lastTransferId)
      : [transfers[0]];
    if (!fresh.length) return;
    const ch = await client.channels.fetch(channelConfig.transfersChannelId);
    if (!ch?.isTextBased()) return;
    for (const t of fresh.reverse()) {
      const warning = await checkClubLimit(t);
      await recordTransferHistory(t);
      await ch.send({ embeds: [makeEmbed(t)] });
      if (warning) await postClubWarning(client, warning);
    }
    lastTransferId = Math.max(...transfers.map(t => t.id));
    lastPostAt = new Date().toISOString();
    console.log(`[Transfers] Posted ${fresh.length} transfer(s).`);
  } catch (err) {
    console.error('[Transfers] Poll error:', err.message);
  }
}

const data = new SlashCommandBuilder()
  .setName('transfers')
  .setDescription('Manage VPG Romania transfer news auto-posting')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('start').setDescription('Start auto-posting transfers'))
  .addSubcommand(s => s.setName('stop').setDescription('Stop auto-posting transfers'))
  .addSubcommand(s => s.setName('post').setDescription('Post the latest transfers right now'))
  .addSubcommand(s => s.setName('club-limits').setDescription('List players who have reached or exceeded the club registration limit'));

module.exports = {
  data,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      if (pollTimer) {
        await interaction.reply({ content: 'Transfer monitoring is already running.', ephemeral: true });
        return;
      }
      nextRunAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
      pollTimer = setInterval(() => { nextRunAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString(); poll(interaction.client); }, POLL_INTERVAL_MS);
      seedHistory().catch(err => console.error('[Transfers] Seed error:', err.message));
      await interaction.reply({ content: `✅ Started transfer monitoring (checks every ${Number(process.env.TRANSFERS_POLL_MINUTES) || 20} min).`, ephemeral: true });
      return;
    }

    if (sub === 'stop') {
      if (!pollTimer) {
        await interaction.reply({ content: 'Transfer monitoring is not running.', ephemeral: true });
        return;
      }
      clearInterval(pollTimer);
      pollTimer = null;
      nextRunAt = null;
      await interaction.reply({ content: '🛑 Stopped transfer monitoring.', ephemeral: true });
      return;
    }

    if (sub === 'post') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const transfers = await fetchTransfers();
        if (!transfers.length) { await interaction.editReply('No transfers found.'); return; }
        const latest = transfers.sort((a, b) => new Date(b.datetime) - new Date(a.datetime)).slice(0, 10);
        await interaction.editReply({ content: '📋 **Latest transfers from VPG Romania SuperLiga**', embeds: latest.map(makeEmbed) });
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      return;
    }

    if (sub === 'club-limits') {
      const overLimit = [];
      const atLimit   = [];
      for (const [username, clubs] of playerClubHistory) {
        if (clubs.size > MAX_CLUBS_PER_SEASON) overLimit.push({ username, clubs: [...clubs] });
        else if (clubs.size === MAX_CLUBS_PER_SEASON) atLimit.push({ username, clubs: [...clubs] });
      }

      if (!overLimit.length && !atLimit.length) {
        const hint = playerClubHistory.size === 0 ? ' Transfer history not yet loaded — run `/transfers start` first.' : '';
        await interaction.reply({ content: `✅ No transfer limit issues found.${hint}`, ephemeral: true });
        return;
      }

      const lines = [];
      if (overLimit.length) {
        lines.push(`**🚨 Exceeded limit (>${MAX_CLUBS_PER_SEASON} clubs — ineligible for further transfers):**`);
        for (const { username, clubs } of overLimit)
          lines.push(`• **${username}** — ${clubs.map(c => `**${c}**`).join(', ')} (${clubs.length} clubs)`);
      }
      if (atLimit.length) {
        lines.push(`**⚠️ At limit (${MAX_CLUBS_PER_SEASON} clubs — cannot register for another team):**`);
        for (const { username, clubs } of atLimit)
          lines.push(`• **${username}** — ${clubs.map(c => `**${c}**`).join(', ')}`);
      }
      await interaction.reply({ content: lines.join('\n') });
      return;
    }
  },

  startMonitoring(client) {
    if (pollTimer) return false;
    seedHistory().catch(err => console.error('[Transfers] Seed error:', err.message));
    nextRunAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
    pollTimer = setInterval(() => { nextRunAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString(); poll(client); }, POLL_INTERVAL_MS);
    console.log('[Transfers] Auto-started monitoring.');
    return true;
  },

  stopMonitoring() {
    if (!pollTimer) return false;
    clearInterval(pollTimer);
    pollTimer = null;
    nextRunAt = null;
    return true;
  },

  getStatus: () => ({ running: pollTimer !== null, lastPostAt, nextRunAt }),
};
