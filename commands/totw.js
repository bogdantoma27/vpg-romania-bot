'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTOTWImage } = require('../generators/totw');
const { getNowInTimezoneMeta } = require('../lib/date-utils');
const {
  fetchCurrentSeason, fetchCurrentWeek, fetchAllLeaderboards,
  resolvePositions, fetchLeagueLogos, POSITIONS,
} = require('../lib/totw-client');

const TIMEZONE = 'Europe/Bucharest';
const TICK_MS  = 60 * 1000;
const SCHEDULE = { hour: Number(process.env.TOTW_HOUR) || 18, days: [3] };

const { config: channelConfig } = require('../lib/channel-config');
const CH_TOTW = () => channelConfig.totwChannelId;

const runLog  = new Set();
let tickTimer  = null;
let nextRunAt  = null;
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

async function tick(client) {
  const meta = getNowInTimezoneMeta(TIMEZONE);
  if (!SCHEDULE.days.includes(meta.weekday) || meta.hour !== SCHEDULE.hour) return;
  const slotKey = `${meta.dayKey}:${SCHEDULE.hour}:totw`;
  if (runLog.has(slotKey)) return;
  runLog.add(slotKey);
  console.log(`[TOTW] Scheduled fire at ${meta.dayKey} ${SCHEDULE.hour}:00`);
  await buildAndPost(client).catch(err => console.error('[TOTW] Tick error:', err.message));
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
      nextRunAt = new Date(Date.now() + TICK_MS).toISOString();
      tickTimer = setInterval(() => { nextRunAt = new Date(Date.now() + TICK_MS).toISOString(); tick(interaction.client).catch(console.error); }, TICK_MS);
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
      nextRunAt = null;
      return interaction.reply({ content: '🛑 TOTW monitoring stopped.', ephemeral: true });
    }

    if (sub === 'post') {
      await interaction.deferReply({ ephemeral: true });
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
    nextRunAt = new Date(Date.now() + TICK_MS).toISOString();
    tickTimer = setInterval(() => { nextRunAt = new Date(Date.now() + TICK_MS).toISOString(); tick(client).catch(console.error); }, TICK_MS);
    console.log('[TOTW] Auto-started monitoring (Wednesday 18:00 Bucharest).');
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
