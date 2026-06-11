# vpg-romania-bot

Standalone Discord bot for VPG Romania community content. Posts Superliga România fixtures, results, standings, Team of the Week, Team of the Season images, and transfer news on automated or on-demand schedules.

---

## What it does

- Posts Superliga România fixture images (Monday 10:00), results images, and standings images (Wednesday 10:00).
- Posts a Team of the Week image every Saturday at 20:00 from weekly Superliga leaderboards.
- Supports a manual Team of the Season post using full-season leaderboard data.
- Polls VPG Romania transfer activity and posts embed cards whenever a new transfer is detected; warns when a player exceeds the 2-club-per-season registration limit.
- All monitors auto-start on bot ready if their channels are configured — no manual `/start` needed after each deploy.

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

#### `/superliga post` targets

| Value | Description |
|---|---|
| `all` | Fixtures + results + standings |
| `clasament` | Standings only |
| `scheduled` | Upcoming fixtures for the current Mon–Sun week |
| `results` | Results only |
| `results,clasament` | Results + standings |
| `scheduled,clasament` | Fixtures + standings |

#### How it works internally

**Season detection:** `lib/superliga-client.js`'s `fetchCurrentSeason()` calls `GET /leagues/Superliga-Romania/seasons/` and returns the numerically highest season.

**Matchday detection:** After fetching the standings table, the maximum `played` value across all teams gives the current matchday round number.

**Images:** `generators/superliga.js` renders all three image types using `@napi-rs/canvas`.

**Change detection:** The last-posted matchday is cached in memory. If the current matchday hasn't changed since the last run, posting is skipped. On `/post` (force run), the cache is bypassed.

**Week-aware fixtures (rescheduled games):** The auto-scheduled Monday tick always queries for ALL scheduled games within the current **Mon–Sun calendar week**, anchored to the Monday of that week. This means if a game is rescheduled from Tuesday to Thursday of the same week, the Monday fixtures post still includes every game for that week — nothing is missed. The `/post` slash command uses the same anchor-week logic.

---

### `/totw`

Posts the Team of the Week for Superliga România. Fetches weekly leaderboards for each position, resolves the best 11 players into a 3-5-2 formation, and generates a pitch image.

| Subcommand | Description |
|---|---|
| `start` | Start automatic Wednesday posting |
| `stop` | Stop monitoring |
| `post` | Force-post right now |

Schedule: Every **Saturday at 20:00 Bucharest time**.

Auto-starts on bot ready if `TOTW_CHANNEL_ID` is set.

---

### `/tots`

Posts the Team of the Season for Superliga România using full-season leaderboard data. Manual post only — no scheduling.

| Subcommand | Description |
|---|---|
| `post` | Post TOTS right now |

Uses `TOTS_CHANNEL_ID`; falls back to `TOTW_CHANNEL_ID` if not set.

Uses the same rendering and position-resolution pipeline as TOTW, but fetches with `weekly=false` to get season-total rather than weekly rankings.

---

### `/transfers`

Polls the VPG Romania SuperLiga transfer feed and posts an embed for every new transfer detected. Also tracks how many clubs each player has joined this season and warns when the limit is exceeded.

| Subcommand | Description |
|---|---|
| `start` | Start automatic polling |
| `stop` | Stop polling |
| `post` | Show the 10 latest transfers right now (ephemeral) |
| `club-limits` | List players at or over the 2-club-per-season registration limit |

Auto-starts on bot ready if `TRANSFERS_CHANNEL_ID` is set.

Poll interval is configurable via `TRANSFERS_POLL_MINUTES` (default: 20 min).

Club-limit warnings are posted to `TRANSFERS_CLUB_LIMIT_CHANNEL_ID`. If a player joins a 3rd (or more) club in a season, a warning embed is sent automatically after the transfer card.

---

## TOTW / TOTS position resolution

The algorithm in `lib/superliga-client.js` runs in three phases.

### Phase 1 — Determine each player's best position

Every leaderboard is scanned. For each player the position where their rank is lowest (best) is recorded. Ties are broken by preferring the more attacking position:

```
strikers > wingers > cam > cdm > cb > gk
```

### Phase 2 — Greedily fill formation slots

Slots are filled in order: GK → CB (×3) → CDM (×2) → CAM → LM → RM → ST (×2).

Each slot is filled in two passes:

- **Pass A** — only picks players whose `bestFor` position matches this slot.
- **Pass B** — falls back to any remaining unused player from the leaderboard.

### Phase 3 — Rescue unplaced multi-leaderboard players

After Phase 2, any player appearing in 2+ leaderboards but not placed anywhere is considered for a rescue swap against the worst-ranked occupant in any slot where they have a rank.

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

# /totw and /tots
TOTW_CHANNEL_ID=
TOTS_CHANNEL_ID=            # falls back to TOTW_CHANNEL_ID if not set

# /transfers
TRANSFERS_CHANNEL_ID=
TRANSFERS_CLUB_LIMIT_CHANNEL_ID=   # optional; warnings about players exceeding 2-club limit
TRANSFERS_SEASON_START=            # optional ISO date (e.g. 2025-08-01); limits club-limit history to current season
TRANSFERS_POLL_MINUTES=20          # optional; default 20

# Schedule overrides (Bucharest time, 24h integer; leave unset to use defaults)
TOTW_HOUR=20                # default: Saturday 20:00
SUPERLIGA_FIXTURES_HOUR=10  # default: Monday 10:00
SUPERLIGA_RESULTS_HOUR=10   # default: Wednesday 10:00
```

---

## Project structure

```
commands/
  superliga.js           — /superliga (auto-starts on ready)
  totw.js                — /totw (auto-starts on ready)
  tots.js                — /tots (manual post only)
  transfers.js           — /transfers (auto-starts on ready)

lib/
  date-utils.js          — Timezone-aware date helpers (Bucharest EET/EEST)
  superliga-client.js    — Season/leaderboard fetcher + position resolver
  channel-config.js      — Runtime channel config (env vars)

generators/
  totw.js                — generateTOTWImage (used for both TOTW and TOTS)
  superliga.js           — generateClasamentImage / generateEtapaImage
```

---

## Setup and deployment

```bash
npm install
cp .env.example .env   # fill in your values
npm start              # registers slash commands, then starts the bot
```

`npm start` automatically runs `node deploy-commands.js` before starting the bot, so slash commands are always up to date after each deploy. To register commands without starting the bot, run `npm run deploy`.

All monitors start automatically on bot ready — no manual `/start` commands required after a deploy.

