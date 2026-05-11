'use strict';

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');

const { config: channelConfig, loadFromFirestore } = require('./lib/channel-config');

const token    = process.env.DISCORD_TOKEN;
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';

let isDiscordReady    = false;
let lastInteractionAt = null;

if (!token) throw new Error('Missing DISCORD_TOKEN in environment variables.');

// ── Self-ping ──────────────────────────────────────────────────────────────────

const selfPingUrl = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/healthz`
  : process.env.SELF_PING_URL || null;
if (selfPingUrl) {
  setInterval(() => { fetch(selfPingUrl, { signal: AbortSignal.timeout(10000) }).catch(() => {}); }, 10 * 60 * 1000);
  console.log(`Self-ping enabled → ${selfPingUrl} (every 10 min)`);
}

// ── Activity log (last 50 entries, in-memory) ──────────────────────────────────

const activityLog = [];
function logActivity(monitor, action, detail = '') {
  activityLog.unshift({ ts: new Date().toISOString(), monitor, action, detail });
  if (activityLog.length > 50) activityLog.pop();
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── API route handler ──────────────────────────────────────────────────────────

async function handleApi(req, res, client) {
  const routePath = req.url.split('?')[0];
  const { method } = req;

  // GET /api/status
  if (routePath === '/api/status' && method === 'GET') {
    const superliga    = client.commands.get('superliga');
    const nationalTeam = client.commands.get('national-team');
    const totw         = client.commands.get('totw');
    const toty         = client.commands.get('toty');
    return json(res, 200, {
      bot: 'vpg-romania-bot',
      discordReady: isDiscordReady,
      uptimeSeconds: Math.floor(process.uptime()),
      lastInteractionAt,
      monitors: {
        superliga:    superliga?.getStatus?.()    ?? null,
        nationalTeam: nationalTeam?.getStatus?.() ?? null,
        totw:         totw?.getStatus?.()         ?? null,
        toty:         toty?.getStatus?.()         ?? null,
      },
    });
  }

  // GET /api/activity
  if (routePath === '/api/activity' && method === 'GET') {
    return json(res, 200, { activity: activityLog });
  }

  // GET /api/config
  if (routePath === '/api/config' && method === 'GET') {
    return json(res, 200, { config: channelConfig });
  }

  if (method !== 'POST') return json(res, 404, { error: 'Not found' });

  const body = await readBody(req);

  // POST /api/superliga/start|stop|post
  if (routePath === '/api/superliga/start') {
    const cmd = client.commands.get('superliga');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const started = cmd.startMonitoring(client);
    if (started) logActivity('superliga', 'start', 'via admin panel');
    return json(res, 200, { ok: true, alreadyRunning: !started });
  }
  if (routePath === '/api/superliga/stop') {
    const cmd = client.commands.get('superliga');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const stopped = cmd.stopMonitoring();
    if (stopped) logActivity('superliga', 'stop', 'via admin panel');
    return json(res, 200, { ok: true, wasRunning: stopped });
  }
  if (routePath === '/api/superliga/post') {
    if (!isDiscordReady) return json(res, 503, { error: 'Discord not ready' });
    const targets = body.targets ? String(body.targets).split(',') : ['scheduled', 'results', 'clasament'];
    logActivity('superliga', 'post', `targets: ${targets.join(',')}`);
    // Fire-and-forget; status comes from activity log
    client.commands.get('superliga')?.execute?.({
      options: { getSubcommand: () => 'post', getString: () => targets.join(',') },
      client,
      deferReply: async () => {},
      editReply: async () => {},
    }).catch(err => logActivity('superliga', 'error', err.message));
    return json(res, 202, { ok: true, targets });
  }

  // POST /api/national-team/start|stop|post
  if (routePath === '/api/national-team/start') {
    const cmd = client.commands.get('national-team');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const started = cmd.startMonitoring(client);
    if (started) logActivity('national-team', 'start', 'via admin panel');
    return json(res, 200, { ok: true, alreadyRunning: !started });
  }
  if (routePath === '/api/national-team/stop') {
    const cmd = client.commands.get('national-team');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const stopped = cmd.stopMonitoring();
    if (stopped) logActivity('national-team', 'stop', 'via admin panel');
    return json(res, 200, { ok: true, wasRunning: stopped });
  }
  if (routePath === '/api/national-team/post') {
    if (!isDiscordReady) return json(res, 503, { error: 'Discord not ready' });
    logActivity('national-team', 'post', 'force post via admin panel');
    client.commands.get('national-team')?.execute?.({
      options: { getSubcommand: () => 'post' },
      client,
      deferReply: async () => {},
      editReply: async () => {},
    }).catch(err => logActivity('national-team', 'error', err.message));
    return json(res, 202, { ok: true });
  }

  // POST /api/totw/start|stop|post
  if (routePath === '/api/totw/start') {
    const cmd = client.commands.get('totw');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const started = cmd.startMonitoring(client);
    if (started) logActivity('totw', 'start', 'via admin panel');
    return json(res, 200, { ok: true, alreadyRunning: !started });
  }
  if (routePath === '/api/totw/stop') {
    const cmd = client.commands.get('totw');
    if (!cmd) return json(res, 503, { error: 'Command not loaded' });
    const stopped = cmd.stopMonitoring();
    if (stopped) logActivity('totw', 'stop', 'via admin panel');
    return json(res, 200, { ok: true, wasRunning: stopped });
  }
  if (routePath === '/api/totw/post') {
    if (!isDiscordReady) return json(res, 503, { error: 'Discord not ready' });
    logActivity('totw', 'post', 'force post via admin panel');
    client.commands.get('totw')?.execute?.({
      options: { getSubcommand: () => 'post' },
      client,
      deferReply: async () => {},
      editReply: async () => {},
    }).catch(err => logActivity('totw', 'error', err.message));
    return json(res, 202, { ok: true });
  }

  // POST /api/toty/post
  if (routePath === '/api/toty/post') {
    if (!isDiscordReady) return json(res, 503, { error: 'Discord not ready' });
    logActivity('toty', 'post', 'force post via admin panel');
    client.commands.get('toty')?.execute?.({
      options: { getSubcommand: () => 'post' },
      client,
      deferReply: async () => {},
      editReply: async () => {},
    }).catch(err => logActivity('toty', 'error', err.message));
    return json(res, 202, { ok: true });
  }

  // POST /api/config/reload
  if (routePath === '/api/config/reload') {
    const ok = await loadFromFirestore();
    if (isDiscordReady) {
      const superliga    = client.commands.get('superliga');
      const nationalTeam = client.commands.get('national-team');
      const totw         = client.commands.get('totw');
      if ((channelConfig.superligaScheduleChannelId || channelConfig.superligaResultsChannelId || channelConfig.superligaClasamentChannelId) && superliga?.getStatus?.().running === false)
        superliga.startMonitoring(client);
      if (channelConfig.nationalTeamChannelId && nationalTeam?.getStatus?.().running === false)
        nationalTeam.startMonitoring(client);
      if (channelConfig.totwChannelId && totw?.getStatus?.().running === false)
        totw.startMonitoring(client);
    }
    logActivity('config', 'reload', ok ? 'reloaded from Firestore' : 'Firestore unavailable, kept current');
    return json(res, 200, { ok, config: channelConfig });
  }

  return json(res, 404, { error: 'Not found' });
}

// ── HTTP server ────────────────────────────────────────────────────────────────

if (process.env.PORT) {
  const server = http.createServer(async (req, res) => {
    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end('ok'); return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, discordReady: isDiscordReady, lastInteractionAt, uptimeSeconds: Math.floor(process.uptime()) }));
      return;
    }

    if (req.url.startsWith('/api/')) {
      if (!ADMIN_KEY || req.headers['authorization'] !== `Bearer ${ADMIN_KEY}`) {
        json(res, 401, { error: 'Unauthorized' }); return;
      }
      try {
        await handleApi(req, res, client);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('VPG Romania bot is running.');
  });
  server.listen(process.env.PORT, () => console.log(`Health server listening on port ${process.env.PORT}`));
}

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

client.once(Events.ClientReady, async readyClient => {
  isDiscordReady = true;
  console.log(`[VPG Romania] Logged in as ${readyClient.user.tag}`);

  await loadFromFirestore();
  setInterval(() => loadFromFirestore().catch(() => {}), 5 * 60 * 1000);

  const superliga    = client.commands.get('superliga');
  const nationalTeam = client.commands.get('national-team');
  const totw         = client.commands.get('totw');

  if (channelConfig.superligaScheduleChannelId || channelConfig.superligaResultsChannelId || channelConfig.superligaClasamentChannelId) {
    if (superliga?.startMonitoring) superliga.startMonitoring(readyClient);
  }
  if (channelConfig.nationalTeamChannelId) {
    if (nationalTeam?.startMonitoring) nationalTeam.startMonitoring(readyClient);
  }
  if (channelConfig.totwChannelId) {
    if (totw?.startMonitoring) totw.startMonitoring(readyClient);
  }
});

client.on(Events.ShardDisconnect, event => { isDiscordReady = false; console.warn(`Discord shard disconnected. Code=${event.code}`); });
client.on(Events.ShardResume,     ()    => { isDiscordReady = true;  console.log('Discord shard resumed.'); });
client.on(Events.Error,      err => console.error('Discord client error:', err));
client.on(Events.ShardError, err => console.error('Discord shard error:', err));

client.on(Events.InteractionCreate, async interaction => {
  lastInteractionAt = new Date().toISOString();
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
