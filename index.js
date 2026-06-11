'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');

const { config: channelConfig } = require('./lib/channel-config');

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Missing DISCORD_TOKEN in environment variables.');

let isDiscordReady = false;

// ── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

function isInteractionAckError(err) { return err?.code === 10062 || err?.code === 40060; }

function loadCommands(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { loadCommands(path.join(dir, entry.name)); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const filePath = path.join(dir, entry.name);
    const command  = require(filePath);
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.warn(`[WARNING] Command at ${filePath} is missing data or execute.`);
    }
  }
}
loadCommands(path.join(__dirname, 'commands'));

// ── Discord events ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, readyClient => {
  isDiscordReady = true;
  console.log(`[VPG Romania] Logged in as ${readyClient.user.tag}`);

  const superliga = client.commands.get('superliga');
  const totw       = client.commands.get('totw');
  const transfers  = client.commands.get('transfers');

  if (channelConfig.superligaScheduleChannelId || channelConfig.superligaResultsChannelId || channelConfig.superligaClasamentChannelId) {
    if (superliga?.startMonitoring) superliga.startMonitoring(readyClient);
  }
  if (channelConfig.totwChannelId) {
    if (totw?.startMonitoring) totw.startMonitoring(readyClient);
  }
  if (channelConfig.transfersChannelId) {
    if (transfers?.startMonitoring) transfers.startMonitoring(readyClient);
  }
});

client.on(Events.ShardDisconnect, event => { isDiscordReady = false; console.warn(`Discord shard disconnected. Code=${event.code}`); });
client.on(Events.ShardResume,     ()    => { isDiscordReady = true;  console.log('Discord shard resumed.'); });
client.on(Events.Error,      err => console.error('Discord client error:', err));
client.on(Events.ShardError, err => console.error('Discord shard error:', err));

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  console.log(`Command /${interaction.commandName} by ${interaction.user.tag} in guild ${interaction.guildId} channel ${interaction.channelId}`);

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const msg = 'There was an error while executing this command.';
    try {
      if (interaction.deferred || interaction.replied) { await interaction.editReply({ content: msg, files: [] }); return; }
      await interaction.reply({ content: msg, ephemeral: true });
    } catch (responseError) {
      if (responseError?.code !== 10062 && responseError?.code !== 40060) console.error(responseError);
    }
  }
});

client.login(token);
