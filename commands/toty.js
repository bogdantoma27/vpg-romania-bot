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
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await buildAndPost(interaction.client);
        await interaction.editReply(`✅ Posted TOTY S${result.season}.`);
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  },
};
