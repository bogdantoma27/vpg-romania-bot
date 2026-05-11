'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a custom message as the bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),

  async execute(interaction) {
    const message = interaction.options.getString('message', true);
    const target  = interaction.options.getChannel('channel') ?? interaction.channel;

    try {
      await target.send(message);
      await interaction.reply({ content: `✅ Message sent to ${target}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `❌ Could not send message: ${err.message}`, ephemeral: true });
    }
  },
};
