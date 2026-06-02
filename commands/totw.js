'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTOTWImage } = require('../generators/totw');
const { getNowInTimezoneMeta, computeNextScheduledRunAt } = require('../lib/date-utils');
const {
  fetchCurrentSeason, fetchCurrentWeek, fetchAllLeaderboards,
  resolvePositions, fetchLeagueLogos, POSITIONS,
} = require('../lib/totw-client');

const TIMEZONE = 'Europe/Bucharest';
const TICK_MS  = 60 * 1000;
const SCHEDULE = { hour: Number(process.env.TOTW_HOUR) || 18, days: [3] };
const WAKEUP_HOUR = SCHEDULE.hour - 1; // Wake 1 hour before post time

const { config: channelConfig } = require('../lib/channel-config');
const CH_TOTW = () => channelConfig.totwChannelId;

const runLog  = new Set();
let tickTimer  = null;
let lastPostAt = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getChannel(client, id) {
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(id);
    return ch?.isTextBased() ? ch : null;
  } catch { return null; }
}

async function postAndClean(channel, imgPath) {
  await channel.send({ files: [imgPath] });
  try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
}

function getGracePeriodMs() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const getByType = (type) => parts.find(p => p.type === type)?.value;
  
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const weekday = weekdayMap[getByType('weekday')] ?? -1;
  const hour = Number(getByType('hour')) ?? -1;
  
  // Active window: Wed 17:00-18:00 (WAKEUP_HOUR to SCHEDULE.hour)
  const isInWindow = weekday === 3 && hour >= WAKEUP_HOUR && hour <= SCHEDULE.hour;
  return isInWindow ? 0 : 45000; // 45 sec grace period if sleeping
}

// ── Core build + post ──────────────────────────────────────────────────────────

async function buildAndPost(client) {
  const season       = await fetchCurrentSeason();
  const week         = await fetchCurrentWeek(season);
  const leaderboards = await fetchAllLeaderboards(season, true); // weekly=true

  const hasData = POSITIONS.some(pos =>
    (leaderboards[pos] || []).some(p => Number(p.matches_played) > 0),
  );
  if (!hasData) return null;

  const players = resolvePositions(leaderboards);
  const { leagueLogoUrl, communityLogoUrl } = await fetchLeagueLogos();

  const imgPath = await generateTOTWImage({
    players, season, week, leagueLogoUrl, communityLogoUrl, isToty: false,
  });

  const ch = await getChannel(client, CH_TOTW());
  if (!ch) {
    console.warn('[TOTW] TOTW_CHANNEL_ID not configured or channel inaccessible — image not posted.');
    try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
    return { season, week, posted: false };
  }
  await postAndClean(ch, imgPath);
  lastPostAt = new Date().toISOString();
  console.log(`[TOTW] Posted S${season} W${week}.`);
  return { season, week, posted: true };
}

// ── Schedule tick (runs every minute) ─────────────────────────────────────────
// Wakes up 1 hour before scheduled post time to keep service alive

async function tick(client) {
  const meta = getNowInTimezoneMeta(TIMEZONE);
  if (!SCHEDULE.days.includes(meta.weekday)) return;
  // Only active between wakeup and post hour (inclusive)
  if (meta.hour < WAKEUP_HOUR || meta.hour > SCHEDULE.hour) return;
  
  // Actually post at exactly SCHEDULE.hour
  if (meta.hour === SCHEDULE.hour) {
    const slotKey = `${meta.dayKey}:${SCHEDULE.hour}:totw`;
    if (runLog.has(slotKey)) return;
    runLog.add(slotKey);
    console.log(`[TOTW] Scheduled fire at ${meta.dayKey} ${SCHEDULE.hour}:00`);
    await buildAndPost(client).catch(err => console.error('[TOTW] Tick error:', err.message));
  }
}

// ── Slash command ──────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('totw')
  .setDescription('Team of the Week — Superliga România')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('start').setDescription('Start automatic Wednesday 18:00 TOTW posting'),
  )
  .addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop automatic TOTW monitoring'),
  )
  .addSubcommand(sub =>
    sub.setName('post').setDescription('Post TOTW right now (current week, or skips if no data)'),
  );

module.exports = {
  data,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') {
      if (tickTimer) {
        return interaction.reply({ content: '⚠️ TOTW monitoring is already running.', ephemeral: true });
      }
      tickTimer = setInterval(() => tick(interaction.client).catch(console.error), TICK_MS);
      return interaction.reply({
        content: '✅ TOTW monitoring started — posts every Wednesday at 18:00 Bucharest time.',
        ephemeral: true,
      });
    }

    if (sub === 'stop') {
      if (!tickTimer) {
        return interaction.reply({ content: '⚠️ TOTW monitoring is not running.', ephemeral: true });
      }
      clearInterval(tickTimer);
      tickTimer = null;
      return interaction.reply({ content: '🛑 TOTW monitoring stopped.', ephemeral: true });
    }

    if (sub === 'post') {
      const gracePeriod = getGracePeriodMs();
      if (gracePeriod > 0) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(`⏳ Service waking up — please wait ${gracePeriod / 1000 | 0} seconds...`);
        await new Promise(r => setTimeout(r, gracePeriod));
        await interaction.editReply({ content: '✅ Service ready — fetching TOTW...' });
      } else {
        await interaction.deferReply({ ephemeral: true });
      }
      try {
        const result = await buildAndPost(interaction.client);
        if (!result) {
          await interaction.editReply('⚠️ No match data available for the current week — nothing posted.');
        } else if (!result.posted) {
          await interaction.editReply('⚠️ Channel not found — make sure `TOTW_CHANNEL_ID` is set correctly and the bot has access.');
        } else {
          await interaction.editReply(`✅ Posted TOTW S${result.season} W${result.week}.`);
        }
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },

  startMonitoring(client) {
    if (tickTimer) return false;
    tickTimer = setInterval(() => tick(client).catch(console.error), TICK_MS);
    console.log('[TOTW] Auto-started monitoring (Wednesday 18:00 Bucharest).');
    return true;
  },

  stopMonitoring() {
    if (!tickTimer) return false;
    clearInterval(tickTimer);
    tickTimer = null;
    return true;
  },

  getStatus: () => ({
    running: tickTimer !== null,
    lastPostAt,
    nextRunAt: tickTimer ? computeNextScheduledRunAt([SCHEDULE], TIMEZONE) : null,
  }),
};
