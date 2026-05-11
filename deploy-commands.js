require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

// CLIENT_ID is only needed here for command registration — not required at bot runtime.
// Find it in Discord Developer Portal → General Information → Application ID.
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  throw new Error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
}

const commands = [];

function collectCommands(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectCommands(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.js')) {
      const command = require(path.join(dir, entry.name));
      if ('data' in command) {
        commands.push(command.data.toJSON());
      }
    }
  }
}

collectCommands(path.join(__dirname, 'commands'));

const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }
})();
