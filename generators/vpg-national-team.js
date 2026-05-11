'use strict';

const path = require('path');
const { promises: fs } = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const VPG_IMAGE_BASE = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';

// ── Design system (mirrors the Angular frontend theme) ────────────────────────
const BG     = '#07090E';
const CARD   = '#0E1118';
const BORDER = '#1C2235';
const TEXT   = '#E2E8F0';
const TEXTD  = '#94A3B8';
const TEXTM  = '#6B7280';
const RO_B   = '#002B7F';
const RO_Y   = '#FCD116';
const RO_R   = '#CE1126';
const GD_POS = '#4ADE80';
const GD_NEG = '#F87171';
const FONT   = 'Arial, Verdana, sans-serif';

const W    = 1400;
const PAD  = 40;
const FLAG = 5;
const CR   = 12;

// Standings layout — 8 cols: P W D L GF GA GD PTS
const ST_ROW    = 90;
const ST_LOG    = 52;
const ST_HDR    = 58;
const STAT_COLS = ['P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'PTS'];
const STAT_W    = 78;
const STATS_R   = W - PAD;
const STATS_L   = STATS_R - STAT_COLS.length * STAT_W;
const C_RANK    = PAD + 22;
const C_LOGO    = PAD + 60;
const C_NAME    = PAD + 124;
const C_NAME_MAX = STATS_L - C_NAME - 14;
const statCX    = (i) => STATS_L + i * STAT_W + STAT_W / 2;

// Match row layout
const MR_ROW  = 106;
const MR_LOG  = 68;
const MR_SPAD = 100;

// Section bar height
const SEC_H = 46;

// ── Utilities ─────────────────────────────────────────────────────────────────

function getLogoUrl(logoId) {
  if (!logoId) return null;
  return `${VPG_IMAGE_BASE}/${logoId}/smThumb`;
}

function isRomania(name) {
  return /^romania/i.test(String(name || '').trim());
}

function getRoundName(roundNum, totalRounds) {
  const rem = totalRounds - roundNum + 1;
  if (rem === 1) return 'Final';
  if (rem === 2) return 'Semi-Finals';
  if (rem === 3) return 'Quarter-Finals';
  if (rem === 4) return 'Round of 16';
  return `Round ${roundNum}`;
}

async function tryLoad(url) {
  if (!url) return null;
  try { return await loadImage(url); } catch { return null; }
}

function clamp(ctx, text, maxW) {
  if (!text) return '';
  const s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

async function ensureOutputDir() {
  const dir = path.resolve('output');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ── Drawing primitives ────────────────────────────────────────────────────────

function drawBackground(ctx, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const lg = ctx.createRadialGradient(0, H * 0.45, 0, 0, H * 0.45, W * 0.65);
  lg.addColorStop(0, 'rgba(0,43,127,0.22)'); lg.addColorStop(1, 'rgba(0,43,127,0)');
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);

  const rg = ctx.createRadialGradient(W, H * 0.55, 0, W, H * 0.55, W * 0.65);
  rg.addColorStop(0, 'rgba(206,17,38,0.18)'); rg.addColorStop(1, 'rgba(206,17,38,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

  const tg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.4);
  tg.addColorStop(0, 'rgba(252,209,22,0.07)'); tg.addColorStop(1, 'rgba(252,209,22,0)');
  ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H);
}

function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

async function drawLogo(ctx, url, name, x, y, size) {
  const img = await tryLoad(url);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else if (isRomania(name)) {
    const sw = size / 3;
    ctx.fillStyle = RO_B; ctx.fillRect(x,          y, sw,            size);
    ctx.fillStyle = RO_Y; ctx.fillRect(x + sw,     y, sw,            size);
    ctx.fillStyle = RO_R; ctx.fillRect(x + sw * 2, y, size - sw * 2, size);
  } else {
    ctx.fillStyle = BORDER; ctx.fill();
    ctx.font = `bold ${Math.round(size * 0.32)}px ${FONT}`;
    ctx.fillStyle = TEXTD;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').slice(0, 3).toUpperCase(), x + size / 2, y + size / 2);
  }
  ctx.restore();
}

// ── Page header — returns Y where card content starts ─────────────────────────

async function drawPageHeader(ctx, title, subtitle, leagueLogoUrl, communityLogoUrl) {
  const AREA = 140;
  const LS   = 76;
  const cy   = FLAG + (AREA - FLAG) / 2;

  if (leagueLogoUrl)    await drawLogo(ctx, leagueLogoUrl,    '', PAD,           cy - LS / 2, LS);
  if (communityLogoUrl) await drawLogo(ctx, communityLogoUrl, '', W - PAD - LS,  cy - LS / 2, LS);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold 44px ${FONT}`; ctx.fillStyle = TEXT;
  ctx.fillText(title, W / 2, cy - 18);
  ctx.font = `24px ${FONT}`; ctx.fillStyle = TEXTD;
  ctx.fillText(subtitle, W / 2, cy + 22);

  return AREA + FLAG;
}

// ── Section label bar — returns Y below the bar ───────────────────────────────

function drawSectionBar(ctx, label, count, y) {
  const cw = W - 2 * PAD;
  ctx.fillStyle = 'rgba(28,34,53,0.6)';
  ctx.fillRect(PAD, y, cw, SEC_H);
  ctx.save();
  ctx.font = `bold 22px ${FONT}`; ctx.fillStyle = TEXTM;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(label, PAD + 16, y + SEC_H / 2);
  if (count != null) {
    ctx.textAlign = 'right';
    ctx.fillText(String(count), W - PAD - 16, y + SEC_H / 2);
  }
  ctx.restore();
  return y + SEC_H;
}

// ── Standings card ────────────────────────────────────────────────────────────
// rows: { team_logo (VPG id), team_name, played, wins, draws, losses, score_for, score_against, points }

async function drawStandingsCard(ctx, rows, startY) {
  const cw    = W - 2 * PAD;
  const cardH = ST_HDR + rows.length * ST_ROW;

  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.fillStyle = CARD; ctx.fill();
  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.stroke();

  const hY = startY + ST_HDR / 2;
  ctx.save();
  ctx.font = `bold 18px ${FONT}`; ctx.fillStyle = TEXTM;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('#', C_RANK, hY);
  ctx.textAlign = 'left'; ctx.fillText('TEAM', C_NAME, hY);
  ctx.textAlign = 'center';
  STAT_COLS.forEach((l, i) => ctx.fillText(l, statCX(i), hY));
  ctx.restore();

  ctx.fillStyle = BORDER;
  ctx.fillRect(PAD + 1, startY + ST_HDR, cw - 2, 1);

  for (let i = 0; i < rows.length; i++) {
    const r    = rows[i];
    const rowY = startY + ST_HDR + i * ST_ROW;
    const cy   = rowY + ST_ROW / 2;
    const hl   = isRomania(r.team_name);
    const last = i === rows.length - 1;

    if (hl) {
      ctx.fillStyle = 'rgba(252,209,22,0.07)';
      ctx.fillRect(PAD + 1, rowY, cw - 2, ST_ROW);
    } else if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(PAD + 1, rowY, cw - 2, ST_ROW);
    }

    if (!last) {
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = BORDER;
      ctx.fillRect(PAD + 1, rowY + ST_ROW, cw - 2, 1);
      ctx.restore();
    }

    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold 20px ${FONT}`; ctx.fillStyle = hl ? RO_Y : TEXTD;
    ctx.fillText(String(i + 1), C_RANK, cy);
    ctx.restore();

    await drawLogo(ctx, getLogoUrl(r.team_logo), r.team_name, C_LOGO, cy - ST_LOG / 2, ST_LOG);

    ctx.save();
    ctx.font = `${hl ? 'bold ' : ''}20px ${FONT}`;
    ctx.fillStyle = hl ? RO_Y : TEXT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(clamp(ctx, r.team_name || '', C_NAME_MAX), C_NAME, cy);
    ctx.restore();

    const gd    = (Number(r.score_for) || 0) - (Number(r.score_against) || 0);
    const gdStr = gd > 0 ? `+${gd}` : String(gd);
    const vals  = [r.played ?? 0, r.wins ?? 0, r.draws ?? 0, r.losses ?? 0,
                   r.score_for ?? 0, r.score_against ?? 0, gdStr, r.points ?? 0];
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    vals.forEach((v, vi) => {
      const isPts = vi === 7, isGd = vi === 6;
      ctx.font      = isPts ? `bold 20px ${FONT}` : `18px ${FONT}`;
      ctx.fillStyle = hl    ? RO_Y
        : isPts             ? TEXT
        : isGd              ? (gd > 0 ? GD_POS : gd < 0 ? GD_NEG : TEXTM)
        : TEXTD;
      ctx.fillText(String(v), statCX(vi), cy);
    });
    ctx.restore();
  }

  return startY + cardH;
}

// ── Matches card ──────────────────────────────────────────────────────────────
// matches: { home_logo (VPG id), away_logo (VPG id), home_name, away_name, home_score, away_score }

async function drawMatchesCard(ctx, matches, startY) {
  const cw    = W - 2 * PAD;
  const cardH = matches.length * MR_ROW;

  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.fillStyle = CARD; ctx.fill();
  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.stroke();

  const hlX  = PAD + 12;
  const hrX  = PAD + cw - 12 - MR_LOG;
  const scCX = PAD + cw / 2;
  const hnX  = hlX + MR_LOG + 14;
  const hnR  = scCX - MR_SPAD;
  const anL  = scCX + MR_SPAD;
  const anR  = hrX - 14;

  for (let i = 0; i < matches.length; i++) {
    const m    = matches[i];
    const rowY = startY + i * MR_ROW;
    const cy   = rowY + MR_ROW / 2;
    const last = i === matches.length - 1;
    const hHL  = isRomania(m.home_name);
    const aHL  = isRomania(m.away_name);

    if (hHL || aHL) {
      ctx.fillStyle = 'rgba(252,209,22,0.05)';
      ctx.fillRect(PAD + 1, rowY, cw - 2, MR_ROW);
    } else if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(PAD + 1, rowY, cw - 2, MR_ROW);
    }

    if (!last) {
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = BORDER;
      ctx.fillRect(PAD + 1, rowY + MR_ROW, cw - 2, 1);
      ctx.restore();
    }

    await drawLogo(ctx, getLogoUrl(m.home_logo), m.home_name, hlX, cy - MR_LOG / 2, MR_LOG);
    await drawLogo(ctx, getLogoUrl(m.away_logo), m.away_name, hrX, cy - MR_LOG / 2, MR_LOG);

    const hs = m.home_score;
    const as = m.away_score;

    ctx.save();
    ctx.textBaseline = 'middle';

    ctx.font = `${hHL ? 'bold ' : ''}22px ${FONT}`; ctx.fillStyle = hHL ? RO_Y : TEXT;
    ctx.textAlign = 'left';
    ctx.fillText(clamp(ctx, m.home_name || '', hnR - hnX - 8), hnX, cy);

    if (hs != null && as != null) {
      ctx.font = `bold 36px ${FONT}`; ctx.fillStyle = TEXT; ctx.textAlign = 'center';
      ctx.fillText(`${hs}  –  ${as}`, scCX, cy);
    } else {
      ctx.font = `bold 28px ${FONT}`; ctx.fillStyle = TEXTM; ctx.textAlign = 'center';
      ctx.fillText('VS', scCX, cy);
    }

    ctx.font = `${aHL ? 'bold ' : ''}22px ${FONT}`; ctx.fillStyle = aHL ? RO_Y : TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(clamp(ctx, m.away_name || '', anR - anL), anR, cy);
    ctx.restore();
  }

  return startY + cardH;
}

// ── Main generator ────────────────────────────────────────────────────────────

async function generateTeamReportImage({
  tournamentName, season, romaniaTeamName,
  group, groupNumber, matches,
  leagueLogoUrl, communityLogoUrl,
}) {
  const groupLabel = groupNumber != null ? `Grupa ${groupNumber}` : 'Faza Grupelor';
  const sub        = [tournamentName, `Season ${season}`, groupLabel].filter(Boolean).join(' · ');

  const standingsH = ST_HDR + group.length * ST_ROW;
  const matchesH   = matches.length > 0 ? matches.length * MR_ROW : 48;
  const H = FLAG + 140               // flag + header
          + 16 + standingsH          // gap + standings card
          + 16 + SEC_H + 8           // gap + section bar + gap
          + matchesH + PAD + FLAG;   // matches + bottom padding + flag

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  drawBackground(ctx, H);

  let y = await drawPageHeader(ctx, romaniaTeamName || tournamentName, sub, leagueLogoUrl, communityLogoUrl);
  y += 16;

  y = await drawStandingsCard(ctx, group, y);
  y += 16;

  const matchLabel = `${matches.length} meci${matches.length !== 1 ? 'uri' : ''} juca${matches.length !== 1 ? 'te' : 't'}`;
  y = drawSectionBar(ctx, 'MECIURI JUCATE', matchLabel, y);
  y += 8;

  if (matches.length === 0) {
    ctx.textAlign = 'center'; ctx.fillStyle = TEXTM;
    ctx.font = `20px ${FONT}`; ctx.textBaseline = 'middle';
    ctx.fillText('Nu există meciuri jucate', W / 2, y + 24);
  } else {
    await drawMatchesCard(ctx, matches, y);
  }

  const dir      = await ensureOutputDir();
  const safeName = String(romaniaTeamName || 'romania').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const out      = path.join(dir, `vpg-report-${safeName}-${Date.now()}.png`);
  await fs.writeFile(out, canvas.toBuffer('image/png'));
  return out;
}

module.exports = { generateTeamReportImage, isRomania, getLogoUrl, getRoundName };
