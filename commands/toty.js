'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTOTWImage } = require('../generators/totw');
const {
  fetchCurrentSeason, fetchAllLeaderboards, resolvePositions, fetchLeagueLogos,
} = require('../lib/totw-client');

const { config: channelConfig } = require('../lib/channel-config');
// Falls back to totwChannelId if a dedicated TOTY channel is not configured
const CH_TOTY = () => channelConfig.totyChannelId || channelConfig.totwChannelId || '';

const TIMEZONE = 'Europe/Bucharest';

let lastPostAt = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getChannel(client, id) {
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(id);
    return ch?.isTextBased() ? ch : null;
  } catch { return null; }
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
  
  // Active windows: Superliga (Mon/Wed 09-10), National-Team (Mon/Tue/Wed 11-12), TOTW (Wed 17-18)
  const inSuperligaWindow = [1, 3].includes(weekday) && hour >= 9 && hour <= 10;
  const inNationalTeamWindow = [1, 2, 3].includes(weekday) && hour >= 11 && hour <= 12;
  const inTotwWindow = weekday === 3 && hour >= 17 && hour <= 18;
  const isInWindow = inSuperligaWindow || inNationalTeamWindow || inTotwWindow;
  return isInWindow ? 0 : 45000; // 45 sec grace period if sleeping
}

async function postAndClean(channel, imgPath) {
  await channel.send({ files: [imgPath] });
  try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
}

// ── Core build + post ──────────────────────────────────────────────────────────

async function buildAndPost(client) {
  const season       = await fetchCurrentSeason();
  const leaderboards = await fetchAllLeaderboards(season, false); // weekly=false → full season stats
  const players      = resolvePositions(leaderboards);
  const { leagueLogoUrl, communityLogoUrl } = await fetchLeagueLogos();

  const imgPath = await generateTOTWImage({
    players, season, week: null, leagueLogoUrl, communityLogoUrl, isToty: true,
  });

  const ch = await getChannel(client, CH_TOTY());
  if (ch) {
    await postAndClean(ch, imgPath);
    lastPostAt = new Date().toISOString();
    console.log(`[TOTY] Posted TOTY S${season}.`);
  } else {
    console.warn('[TOTY] No channel configured (set TOTY_CHANNEL_ID or TOTW_CHANNEL_ID).');
    try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
  }
  return { season };
}

// ── Slash command ──────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('toty')
  .setDescription('Team of the Year — Superliga România (manual post only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('post').setDescription('Post TOTY right now (full-season leaderboard)'),
  );

module.exports = {
  data,

  getStatus: () => ({ lastPostAt }),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'post') {
      const gracePeriod = getGracePeriodMs();
      if (gracePeriod > 0) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(`⏳ Service waking up — please wait ${gracePeriod / 1000 | 0} seconds...`);
        await new Promise(r => setTimeout(r, gracePeriod));
        await interaction.editReply({ content: '✅ Service ready — generating TOTY...' });
      } else {
        await interaction.deferReply({ ephemeral: true });
      }
      try {
        const result = await buildAndPost(interaction.client);
        await interaction.editReply(`✅ Posted TOTY S${result.season}.`);
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },
};
