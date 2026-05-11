'use strict';

const path = require('path');
const { promises: fs } = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const VPG_CDN = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';

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

// Standings layout — 8 cols: J V E Î GM GÎ GD PCT
const ST_ROW    = 90;
const ST_LOG    = 52;
const ST_HDR    = 58;
const STAT_COLS = ['J', 'V', 'E', 'Î', 'GM', 'GÎ', 'GD', 'PCT'];
const STAT_W    = 78;
const STATS_R   = W - PAD;
const STATS_L   = STATS_R - STAT_COLS.length * STAT_W;
const C_RANK    = PAD + 22;
const C_LOGO    = PAD + 60;
const C_NAME    = PAD + 124;
// FORMA (last 5 results) — right of team name, left of stat columns
const FORMA_DOTS = 5;
const FORMA_SZ   = 26;
const FORMA_GAP  = 5;
const FORMA_PX   = FORMA_DOTS * FORMA_SZ + (FORMA_DOTS - 1) * FORMA_GAP; // 150px
const FORMA_R    = STATS_L - 16;
const FORMA_L    = FORMA_R - FORMA_PX;
const FORMA_CX   = (FORMA_L + FORMA_R) / 2;
const C_NAME_MAX = FORMA_L - C_NAME - 16;
const statCX    = (i) => STATS_L + i * STAT_W + STAT_W / 2;

// Match row layout
const MR_ROW  = 106;
const MR_LOG  = 68;
const MR_SPAD = 100;

// ── Utilities ─────────────────────────────────────────────────────────────────

const MONTHS_RO = ['IANUARIE', 'FEBRUARIE', 'MARTIE', 'APRILIE', 'MAI', 'IUNIE',
                   'IULIE', 'AUGUST', 'SEPTEMBRIE', 'OCTOMBRIE', 'NOIEMBRIE', 'DECEMBRIE'];

function formatDateRo(datetimeStr) {
  if (!datetimeStr) return '';
  try {
    const d   = new Date(datetimeStr);
    const fmt = (o) => new Intl.DateTimeFormat('en', { timeZone: 'Europe/Bucharest', ...o }).format(d);
    return `${fmt({ day: 'numeric' })} ${MONTHS_RO[Number(fmt({ month: 'numeric' })) - 1]} ORA ${fmt({ hour: '2-digit', minute: '2-digit', hour12: false })}`;
  } catch { return ''; }
}

async function tryLoad(id) {
  if (!id) return null;
  try { return await loadImage(`${VPG_CDN}/${id}/smThumb`); } catch { return null; }
}

async function tryLoadUrl(url) {
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

async function drawLogo(ctx, id, name, x, y, size) {
  const img = await tryLoad(id);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = BORDER; ctx.fill();
    ctx.font = `bold ${Math.round(size * 0.32)}px ${FONT}`;
    ctx.fillStyle = TEXTD;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').slice(0, 3).toUpperCase(), x + size / 2, y + size / 2);
  }
  ctx.restore();
}

async function drawLogoFromUrl(ctx, url, name, x, y, size) {
  const img = await tryLoadUrl(url);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
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

  if (leagueLogoUrl)    await drawLogoFromUrl(ctx, leagueLogoUrl,    '', PAD,           cy - LS / 2, LS);
  if (communityLogoUrl) await drawLogoFromUrl(ctx, communityLogoUrl, '', W - PAD - LS,  cy - LS / 2, LS);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold 44px ${FONT}`; ctx.fillStyle = TEXT;
  ctx.fillText(title, W / 2, cy - 18);
  ctx.font = `24px ${FONT}`; ctx.fillStyle = TEXTD;
  ctx.fillText(subtitle, W / 2, cy + 22);

  return AREA + FLAG;
}

// ── Date decoration ───────────────────────────────────────────────────────────

function drawDateDecoration(ctx, label, y) {
  ctx.font = `bold 30px ${FONT}`;
  const halfGap = ctx.measureText(label).width / 2 + 28;
  const cx      = W / 2;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = RO_B; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(cx - halfGap, y); ctx.stroke();
  ctx.strokeStyle = RO_R;
  ctx.beginPath(); ctx.moveTo(cx + halfGap, y); ctx.lineTo(W - PAD, y); ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold 30px ${FONT}`; ctx.fillStyle = RO_Y;
  ctx.fillText(label, cx, y);
  ctx.restore();
}

// ── Standings card ────────────────────────────────────────────────────────────
// entries: { team_logo (VPG id), team_name, wins, draws, losses, score_for, score_against, points }

async function drawStandingsCard(ctx, entries, startY, formMap) {
  const norm  = s => String(s || '').trim().toLowerCase();
  const cw    = W - 2 * PAD;
  const cardH = ST_HDR + entries.length * ST_ROW;

  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.fillStyle = CARD; ctx.fill();
  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.stroke();

  const hY = startY + ST_HDR / 2;
  ctx.save();
  ctx.font = `bold 18px ${FONT}`; ctx.fillStyle = TEXTM;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('#', C_RANK, hY);
  ctx.textAlign = 'left'; ctx.fillText('ECHIPĂ', C_NAME, hY);
  ctx.textAlign = 'center';
  ctx.fillText('FORMA', FORMA_CX, hY);
  STAT_COLS.forEach((l, i) => ctx.fillText(l, statCX(i), hY));
  ctx.restore();

  ctx.fillStyle = BORDER;
  ctx.fillRect(PAD + 1, startY + ST_HDR, cw - 2, 1);

  for (let i = 0; i < entries.length; i++) {
    const e    = entries[i];
    const rowY = startY + ST_HDR + i * ST_ROW;
    const cy   = rowY + ST_ROW / 2;
    const hl   = false;
    const last = i === entries.length - 1;

    if (i % 2 === 1) {
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

    await drawLogo(ctx, e.team_logo, e.team_name, C_LOGO, cy - ST_LOG / 2, ST_LOG);

    ctx.save();
    ctx.font = `20px ${FONT}`;
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(clamp(ctx, e.team_name || '', C_NAME_MAX), C_NAME, cy);
    ctx.restore();

    // FORMA indicators — right-aligned: rightmost slot = most recent result
    const form = formMap ? (formMap.get(norm(e.team_name)) || []) : [];
    for (let fi = 0; fi < FORMA_DOTS; fi++) {
      const result = form[FORMA_DOTS - 1 - fi];
      const fx = FORMA_L + fi * (FORMA_SZ + FORMA_GAP);
      const fy = cy - FORMA_SZ / 2;
      rrPath(ctx, fx, fy, FORMA_SZ, FORMA_SZ, 4);
      if (!result) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      } else {
        ctx.fillStyle = result === 'W' ? GD_POS : result === 'D' ? RO_Y : GD_NEG;
        ctx.fill();
        ctx.save();
        ctx.font = `bold ${Math.round(FORMA_SZ * 0.58)}px ${FONT}`;
        ctx.fillStyle = BG;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(result, fx + FORMA_SZ / 2, cy);
        ctx.restore();
      }
    }

    const gd    = (Number(e.score_for) || 0) - (Number(e.score_against) || 0);
    const gdStr = gd > 0 ? `+${gd}` : String(gd);
    const vals  = [e.played ?? 0, e.wins ?? 0, e.draws ?? 0, e.losses ?? 0,
                   e.score_for ?? 0, e.score_against ?? 0, gdStr, e.points ?? 0];
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    vals.forEach((v, vi) => {
      const isPts = vi === 7, isGd = vi === 6;
      ctx.font      = isPts ? `bold 20px ${FONT}` : `18px ${FONT}`;
      ctx.fillStyle = isPts ? TEXT
        : isGd       ? (gd > 0 ? GD_POS : gd < 0 ? GD_NEG : TEXTM)
        : TEXTD;
      ctx.fillText(String(v), statCX(vi), cy);
    });
    ctx.restore();
  }

  return startY + cardH;
}

// ── Matches card ──────────────────────────────────────────────────────────────
// matches: { home_logo (VPG id), away_logo (VPG id), home_name, away_name, home_score, away_score }

async function drawMatchesCard(ctx, matches, startY, showScore) {
  const cw    = W - 2 * PAD;
  const cardH = matches.length * MR_ROW;

  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.fillStyle = CARD; ctx.fill();
  rrPath(ctx, PAD, startY, cw, cardH, CR);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.stroke();

  const hlX = PAD + 12;
  const hrX = PAD + cw - 12 - MR_LOG;
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

    if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(PAD + 1, rowY, cw - 2, MR_ROW);
    }

    if (!last) {
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = BORDER;
      ctx.fillRect(PAD + 1, rowY + MR_ROW, cw - 2, 1);
      ctx.restore();
    }

    await drawLogo(ctx, m.home_logo, m.home_name, hlX, cy - MR_LOG / 2, MR_LOG);
    await drawLogo(ctx, m.away_logo, m.away_name, hrX, cy - MR_LOG / 2, MR_LOG);

    ctx.save();
    ctx.textBaseline = 'middle';

    ctx.font = `22px ${FONT}`; ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.fillText(clamp(ctx, m.home_name || '', hnR - hnX - 8), hnX, cy);

    const hs = m.home_score;
    const as = m.away_score;
    if (showScore && hs != null && as != null) {
      ctx.font = `bold 36px ${FONT}`; ctx.fillStyle = TEXT; ctx.textAlign = 'center';
      ctx.fillText(`${hs}  –  ${as}`, scCX, cy);
    } else {
      ctx.font = `bold 28px ${FONT}`; ctx.fillStyle = TEXTM; ctx.textAlign = 'center';
      ctx.fillText('VS', scCX, cy);
    }

    ctx.font = `22px ${FONT}`; ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(clamp(ctx, m.away_name || '', anR - anL), anR, cy);
    ctx.restore();
  }

  return startY + cardH;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function generateClasamentImage({ entries, seasonLabel, leagueLogoUrl, communityLogoUrl, formMap }) {
  const hdrH = 140 + FLAG + 16;
  const H    = hdrH + ST_HDR + entries.length * ST_ROW + PAD + FLAG;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  drawBackground(ctx, H);

  let y = await drawPageHeader(ctx, 'CLASAMENT SUPERLIGA', seasonLabel ? String(seasonLabel).toUpperCase() : 'SUPERLIGA ROMÂNIEI', leagueLogoUrl, communityLogoUrl);
  y += 16;

  await drawStandingsCard(ctx, entries, y, formMap);

  const dir = await ensureOutputDir();
  const out = path.join(dir, `superliga-clasament-${Date.now()}.png`);
  await fs.writeFile(out, canvas.toBuffer('image/png'));
  return out;
}

async function generateEtapaImage({ matches, etapaNumber, dateLabel, isResults = false, leagueLogoUrl, communityLogoUrl }) {
  const dateH = dateLabel ? 72 : 0;
  const hdrH  = 140 + FLAG + 8 + dateH + 16;
  const H     = hdrH + matches.length * MR_ROW + PAD + FLAG;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  drawBackground(ctx, H);

  const title = isResults
    ? (etapaNumber != null ? `REZULTATE ETAPA ${etapaNumber}` : 'REZULTATE')
    : (etapaNumber != null ? `ETAPA ${etapaNumber}` : 'MECIURI');

  let y = await drawPageHeader(ctx, title, 'SUPERLIGA ROMÂNIEI', leagueLogoUrl, communityLogoUrl);
  y += 8;

  if (dateLabel) {
    drawDateDecoration(ctx, dateLabel.toUpperCase(), y + 16);
    y += dateH;
  }

  y += 16;
  await drawMatchesCard(ctx, matches, y, isResults);

  const dir    = await ensureOutputDir();
  const suffix = isResults ? 'results' : 'scheduled';
  const out    = path.join(dir, `superliga-etapa-${etapaNumber ?? 'x'}-${suffix}-${Date.now()}.png`);
  await fs.writeFile(out, canvas.toBuffer('image/png'));
  return out;
}

module.exports = { generateClasamentImage, generateEtapaImage, formatDateRo };
