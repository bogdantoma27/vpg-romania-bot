'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTOTWImage } = require('../generators/totw');
const { getNowInTimezoneMeta, computeNextScheduledRunAt } = require('../lib/date-utils');
const {
  fetchCurrentSeason, fetchAllLeaderboards,
  resolvePositions, fetchLeagueLogos, POSITIONS,
} = require('../lib/superliga-client');

const TIMEZONE = 'Europe/Bucharest';
const TICK_MS  = 60 * 1000;
const SCHEDULE = { hour: Number(process.env.TOTW_HOUR) || 20, days: [6] };

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

// ── Core build + post ──────────────────────────────────────────────────────────

async function buildAndPost(client, channel = null) {
  const season                    = await fetchCurrentSeason();
  const { leaderboards, week: lbWeek } = await fetchAllLeaderboards(season, true); // weekly=true
  // Use week from the API response (authoritative); fall back to 1 if omitted.
  const week = lbWeek ?? 1;

  const hasData = POSITIONS.some(pos =>
    (leaderboards[pos] || []).some(p => Number(p.matches_played) > 0),
  );
  if (!hasData) return null;

  const players = resolvePositions(leaderboards);
  const { leagueLogoUrl, communityLogoUrl } = await fetchLeagueLogos();

  const imgPath = await generateTOTWImage({
    players, season, week, leagueLogoUrl, communityLogoUrl, isToty: false,
  });

  const ch = channel ?? await getChannel(client, CH_TOTW());
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
  if (meta.hour !== SCHEDULE.hour) return;
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
    sub.setName('start').setDescription('Start automatic Saturday 20:00 TOTW posting'),
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
        content: '✅ TOTW monitoring started — posts every Saturday at 20:00 Bucharest time.',
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
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await buildAndPost(interaction.client, interaction.channel);
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
    console.log('[TOTW] Auto-started monitoring (Saturday 20:00 Bucharest).');
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
