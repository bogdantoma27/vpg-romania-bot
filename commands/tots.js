'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { generateTOTWImage } = require('../generators/totw');
const {
  fetchCurrentSeason, fetchAllLeaderboards, resolvePositions, fetchLeagueLogos,
} = require('../lib/superliga-client');

const { config: channelConfig } = require('../lib/channel-config');
// Falls back to totwChannelId if a dedicated TOTS channel is not configured
const CH_TOTS = () => channelConfig.totsChannelId || channelConfig.totwChannelId || '';

const TIMEZONE = 'Europe/Bucharest';

let lastPostAt = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const season                = await fetchCurrentSeason();
  const { leaderboards }      = await fetchAllLeaderboards(season, false); // weekly=false → full season stats
  const players               = resolvePositions(leaderboards);
  const { leagueLogoUrl, communityLogoUrl } = await fetchLeagueLogos();

  const imgPath = await generateTOTWImage({
    players, season, week: null, leagueLogoUrl, communityLogoUrl, isToty: true,
  });

  const ch = channel ?? await getChannel(client, CH_TOTS());
  if (ch) {
    await postAndClean(ch, imgPath);
    lastPostAt = new Date().toISOString();
    console.log(`[TOTS] Posted TOTS S${season}.`);
  } else {
    console.warn('[TOTS] No channel configured (set TOTS_CHANNEL_ID or TOTW_CHANNEL_ID).');
    try { await fs.promises.unlink(imgPath); } catch { /* ignore */ }
  }
  return { season };
}

// ── Slash command ──────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('tots')
  .setDescription('Team of the Season — Superliga România (manual post only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('post').setDescription('Post TOTS right now (full-season leaderboard)'),
  );

module.exports = {
  data,

  getStatus: () => ({ lastPostAt }),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'post') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await buildAndPost(interaction.client, interaction.channel);
        await interaction.editReply(`✅ Posted TOTS S${result.season}.`);
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },
};
