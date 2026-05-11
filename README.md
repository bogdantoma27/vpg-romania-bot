# vpg-romania-bot

Standalone Discord bot for VPG Romania community content. Posts Superliga România fixtures, results and standings, national team tournament reports, and Team of the Week / Team of the Year images on automated schedules.

---

## What it does

- Posts Superliga România fixture images (Monday), results images, and standings images (Wednesday).
- Monitors VPG World Cup and Internationals tournaments and posts Romania national team report images when new results appear.
- Posts a Team of the Week image every Wednesday at 18:00 from weekly Superliga leaderboards.
- Supports a manual Team of the Year post using full-season leaderboard data.
- Auto-starts all monitors on bot ready if their channels are configured — no manual `/start` needed after each deploy.
- Self-pings its own `/healthz` endpoint every 10 minutes to prevent Render free-tier spin-down.

---

## Commands

### `/superliga`

Monitors VPG Superliga România. Posts fixtures, results, and standings to three configurable channels.

| Subcommand | Description |
|---|---|
| `start` | Start automatic monitoring |
| `stop` | Stop monitoring |
| `post` | Force a run now (all content or specific subset) |

| Content | Channel env var | Schedule |
|---|---|---|
| Fixture images (upcoming matchday) | `SUPERLIGA_SCHEDULE_CHANNEL_ID` | Monday 10:00 Bucharest |
| Results images (previous matchday) | `SUPERLIGA_RESULTS_CHANNEL_ID` | Wednesday 10:00 Bucharest |
| Standings image | `SUPERLIGA_CLASAMENT_CHANNEL_ID` | Wednesday 10:00 Bucharest |

Auto-starts on bot ready if at least one `SUPERLIGA_*_CHANNEL_ID` is set.

#### How it works internally

**Season detection:** `lib/totw-client.js`'s `fetchCurrentSeason()` calls `GET /leagues/Superliga-Romania/seasons/` and returns the numerically highest season. This is called fresh on every poll cycle — no hardcoded season number anywhere.

**Matchday detection:** After fetching the standings table, `fetchCurrentWeek(season)` finds the maximum `played` value across all teams and divides by 2 (each round, each team plays one match). This gives the current matchday round number without needing a dedicated "current round" endpoint.

**Images:** `generators/vpg-superliga.js` renders all three image types using `@napi-rs/canvas`. Fixtures and results are generated per-match; the standings image shows the full league table.

**Change detection:** The last-posted matchday is cached in memory. If the current matchday hasn't changed since the last run, posting is skipped to avoid duplicates. On `/post` (force run), the cache is bypassed.

---

### `/national-team`

Monitors VPG World Cup and Internationals tournaments. Generates and posts Romania national team report images (group standings + recent match history) when new results are detected.

| Subcommand | Description |
|---|---|
| `start` | Start automatic monitoring |
| `stop` | Stop monitoring |
| `post` | Force-post now (even without new data) |

Schedule: Monday, Tuesday, Wednesday at **12:00 Bucharest time**.

Auto-starts on bot ready if `VPG_NATIONAL_TEAM_CHANNEL_ID` is set.

#### How it works internally

**Tournament configuration** (`TOURNAMENTS` array at the top of the file):

```js
{ slug: 'World-Esports-Cup',        name: 'VPG World Cup',      baseSeason: 4 },
{ slug: 'International-eLeague-KO', name: 'VPG Internationals', baseSeason: 3 },
```

Each entry has a `slug` (used in API URLs), a display `name`, and a `baseSeason` — the lowest known season number. The bot never uses `baseSeason` as the actual season; it only uses it as the starting point for season detection.

**Season detection (`detectCurrentSeason`):**

Starting from `baseSeason + 1`, the bot calls:
```
GET /tournaments/{slug}/matches/?match_status=complete&season=N&limit=1&offset=0
```
If the response contains at least one match, `N` becomes the current season and the loop continues to `N+1`. This repeats up to 15 seasons ahead. The highest season that has complete matches is returned. This guarantees no hardcoded season number is ever used.

**API response normalisation (`normalizeArray`):**

The VPG tournament API can return results in multiple shapes depending on the endpoint and version:
- Direct array: `[...]`
- Wrapped: `{ data: [...] }`
- Wrapped: `{ results: [...] }`

Every response that should be an array passes through `normalizeArray(data)` before use. Without this, a shape change would silently return an empty list, causing season detection to fall back to `baseSeason` and groups/matches to appear empty.

**Groups (`fetchGroups`):**

```
GET /tournaments/{slug}/groups/?season={season}
```

The season parameter is always included so that group data aligns with the detected season. After fetching, `findRomaniaGroups(rawGroups)` normalises the response (unwrapping any envelope), then scans every group for a team whose name matches `/^romania/i`. Each matching group is returned with its group number.

**Match fetching (`fetchAllGroupMatches`):**

Paginates through:
```
GET /tournaments/{slug}/matches/?match_status=complete&season={season}&limit=25&offset=N
```
until all complete matches are collected. Uses `normalizeArray` for the batch and reads `data.count` (if present) for early-exit optimisation.

**Knockout phase:** `fetchTotalKnockoutRounds` checks if a knockout stage exists for the season. If it does, all rounds are fetched (`GET /knockout/matches/?round_num=N&season={season}`) and complete matches are added to the match list alongside group matches.

**Romania team matching:**

`isRomania(name)` tests `/^romania/i` against the team name. This matches `Romania`, `Romania U21`, `Romania B`, etc. Each matching team in each Romania-containing group gets its own independent image.

**Hash-based deduplication:**

Before posting, a `teamHash` is computed from:
- The full group standings (team name, points, played, wins, draws, losses, goals for/against)
- All match IDs for that team

On the first run, the hash is stored without posting (seeding). Subsequent runs only post if the hash has changed. This means images are only posted when new match results appear. `/post` (force run) bypasses the hash check.

**Image generation:**

`generators/vpg-national-team.js` renders a canvas image (1400px wide) showing:
- Page header with tournament logo, community logo, team name, season, and group label
- Group standings table with all teams, with the Romania team highlighted in yellow
- Completed matches section (all group + knockout matches involving Romania)

The image is written to `output/vpg-report-{name}-{timestamp}.png`, posted via Discord's file attachment API, then deleted.

**Multiple Romania teams:** If multiple Romania teams are in different groups (e.g. Romania and Romania U21), each gets a separate image posted independently.

---

### `/totw`

Posts the Team of the Week for Superliga România. Fetches weekly leaderboards for each position, resolves the best 11 players into a 3-5-2 formation using a three-phase algorithm (see below), and generates a pitch image.

| Subcommand | Description |
|---|---|
| `start` | Start automatic Wednesday posting |
| `stop` | Stop monitoring |
| `post` | Force-post right now |

Schedule: Every **Wednesday at 18:00 Bucharest time**.

Auto-starts on bot ready if `TOTW_CHANNEL_ID` is set.

#### How it works internally

`lib/totw-client.js` coordinates data fetching and player resolution.

**Season and week detection:** `fetchCurrentSeason()` calls `GET /leagues/Superliga-Romania/seasons/` and returns the highest season number. `fetchCurrentWeek(season)` reads the standings table and derives the current round from the maximum `played` value.

**Leaderboard fetching:** Six per-position leaderboards are fetched in parallel:
```
GET /leagues/Superliga-Romania/leaderboard/?leaderboard={pos}&weekly=true&season={season}&limit=20
```
Positions: `top_gk`, `top_cb`, `top_cdm`, `top_cam`, `top_wingers`, `top_strikers`.

**Player resolution:** The three-phase algorithm below.

**Image:** `generators/totw.js` renders a football pitch with 11 player cards positioned in the 3-5-2 formation layout.

---

### `/toty`

Posts the Team of the Year for Superliga România using full-season leaderboard data. Manual post only — no scheduling.

| Subcommand | Description |
|---|---|
| `post` | Post TOTY right now |

Falls back to `TOTW_CHANNEL_ID` if `TOTY_CHANNEL_ID` is not set.

Uses the same rendering and position-resolution pipeline as TOTW, but fetches with `weekly=false` to get season-total rather than weekly rankings.

---

## TOTW / TOTY position resolution

Resolving which 11 players appear in the Team of the Week is non-trivial because a player can rank highly in multiple position leaderboards (e.g. rank 2 in both CDM and CAM). The algorithm in `lib/totw-client.js` runs in three phases.

### Phase 1 — Determine each player's best position

Every leaderboard is scanned. For each player the position where their rank is lowest (best) is recorded. Ties are broken by preferring the more attacking position:

```
strikers > wingers > cam > cdm > cb > gk
```

This produces a `bestFor` map: `username → { pos, rank }`.

### Phase 2 — Greedily fill formation slots

Slots are filled in order: GK → CB (×3) → CDM (×2) → CAM → LM → RM → ST (×2).

Each slot is filled in two passes:

- **Pass A** — only picks players whose `bestFor` position matches this slot, so the "rightful owner" of a spot gets priority.
- **Pass B** — falls back to any remaining unused player from the leaderboard to fill remaining vacancies.

**The gap this creates:** A player ranked 2nd in CDM and 2nd in CAM will have `bestFor = cam` (more attacking wins ties). During `fill('cdm')`, Pass A skips them. If two native CDM players fill both slots before Pass B runs, this player is skipped entirely. Then `fill('cam')` takes the rank-1 CAM player, and this multi-position player ends up unplaced despite ranking 2nd in two leaderboards.

### Phase 3 — Rescue unplaced multi-leaderboard players

After Phase 2, any player appearing in 2 or more leaderboards but not placed anywhere is considered for a rescue swap:

1. For each unplaced multi-position player, check every formation slot where they have a rank.
2. Find the worst-ranked player currently occupying that slot.
3. If the unplaced player ranks better than that worst player, record this as a candidate swap.
4. Among all candidate swaps, pick the one where the unplaced player's rank is best.
5. Perform the swap: remove the displaced player, insert the rescued player.

---

## Admin API

The bot exposes a REST API for the web admin panel. All `/api/*` routes require:

```
Authorization: Bearer <ADMIN_API_KEY>
```

Set `ADMIN_API_KEY` in the bot's environment variables. The same value must be set as `adminApiKey` in the Angular frontend's `environment.ts`.

All responses are JSON. CORS headers are included on every response, so the Angular frontend can call directly from the browser.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Bot status + per-monitor state (running, lastPostAt) |
| `GET` | `/api/activity` | Last 50 admin-panel-triggered actions |
| `POST` | `/api/superliga/start` | Start Superliga monitoring |
| `POST` | `/api/superliga/stop` | Stop Superliga monitoring |
| `POST` | `/api/superliga/post` | Force-post Superliga content. Body: `{ "targets": "all\|clasament\|scheduled\|results" }` |
| `POST` | `/api/national-team/start` | Start national team monitoring |
| `POST` | `/api/national-team/stop` | Stop national team monitoring |
| `POST` | `/api/national-team/post` | Force-post national team reports |
| `POST` | `/api/totw/start` | Start TOTW monitoring |
| `POST` | `/api/totw/stop` | Stop TOTW monitoring |
| `POST` | `/api/totw/post` | Force-post TOTW |
| `POST` | `/api/toty/post` | Force-post TOTY |
| `GET` | `/api/config` | Current channel config (Firestore values merged with env vars) |
| `POST` | `/api/config/reload` | Reload config from Firestore and auto-start stopped monitors that now have a channel |

**`GET /api/status` response shape:**

```json
{
  "bot": "vpg-romania-bot",
  "discordReady": true,
  "uptimeSeconds": 3600,
  "lastInteractionAt": "2026-05-11T10:00:00.000Z",
  "monitors": {
    "superliga":    { "running": true,  "lastPostAt": "2026-05-11T10:00:00.000Z" },
    "nationalTeam": { "running": true,  "lastPostAt": null },
    "totw":         { "running": true,  "lastPostAt": "2026-05-07T18:00:00.000Z" },
    "toty":         { "lastPostAt": null }
  }
}
```

**POST routes return `202 Accepted`** for force-post actions (fire-and-forget; the actual Discord post happens asynchronously). Start/stop routes return `200` immediately.

**Activity log entries** (`GET /api/activity`):

```json
{
  "activity": [
    { "ts": "2026-05-11T10:05:00.000Z", "monitor": "superliga", "action": "post", "detail": "targets: clasament" },
    { "ts": "2026-05-11T09:00:00.000Z", "monitor": "totw",      "action": "start", "detail": "via admin panel" }
  ]
}
```

---

## Environment variables

```env
# Discord credentials
DISCORD_TOKEN=
CLIENT_ID=

# /superliga
SUPERLIGA_SCHEDULE_CHANNEL_ID=
SUPERLIGA_RESULTS_CHANNEL_ID=
SUPERLIGA_CLASAMENT_CHANNEL_ID=

# /national-team
VPG_NATIONAL_TEAM_CHANNEL_ID=

# /totw and /toty
TOTW_CHANNEL_ID=
TOTY_CHANNEL_ID=            # falls back to TOTW_CHANNEL_ID if not set

# Schedule overrides (Bucharest time, 24h integer; leave unset to use defaults)
TOTW_HOUR=18                # default: Wednesday 18:00
VPG_NATIONAL_TEAM_HOUR=12   # default: Mon/Tue/Wed 12:00
SUPERLIGA_FIXTURES_HOUR=10  # default: Monday 10:00
SUPERLIGA_RESULTS_HOUR=10   # default: Wednesday 10:00

# Admin API key — must match adminApiKey in the Angular frontend environment.ts
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ADMIN_API_KEY=

# Firebase project ID — enables the bot to read channel config from Firestore.
# Set to your Firebase project ID (e.g. vpg-romania).
# If unset, the bot uses only the env vars above for channel IDs.
FIREBASE_PROJECT_ID=

# Set automatically by Render; used for self-ping to prevent spin-down
RENDER_EXTERNAL_URL=
# Alternative if not hosted on Render
SELF_PING_URL=
```

---

## Project structure

```
commands/
  superliga.js           — /superliga
  national-team.js       — /national-team
  totw.js                — /totw
  toty.js                — /toty

lib/                     — Shared utilities
  date-utils.js          — Timezone-aware date helpers (Bucharest EET/EEST)
  totw-client.js         — TOTW/TOTY leaderboard fetcher + position resolver
  channel-config.js      — Runtime channel config: reads env vars, overlaid by Firestore at startup

generators/              — Canvas image renderers (no Discord logic)
  totw.js                — generateTOTWImage (used for both TOTW and TOTY)
  vpg-national-team.js   — generateTeamReportImage
  vpg-superliga.js       — generateClasamentImage / generateEtapaImage
```

---

## Setup and deployment

```bash
npm install
cp .env.example .env   # fill in your values
npm start              # registers slash commands, then starts the bot
```

`npm start` automatically runs `node deploy-commands.js` before starting the bot, so commands are always up to date after each deploy. To deploy commands without starting the bot, run `npm run deploy`.

### Health endpoints

| Endpoint | Description |
|---|---|
| `GET /healthz` | Liveness check — returns `ok` |
| `GET /health` | JSON: `discordReady`, `uptimeSeconds` |

Ping `/healthz` every 5 minutes from an external monitor (e.g. UptimeRobot) to keep the Render free-tier service alive.
