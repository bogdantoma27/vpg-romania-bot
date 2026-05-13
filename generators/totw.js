'use strict';

const path = require('path');
const { promises: fs } = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const VPG_CDN  = 'https://virtualprogaming.com/cdn-cgi/imagedelivery/cl8ocWLdmZDs72LEaQYaYw';
const FLAG_CDN = 'https://flagcdn.com/w40';
const FONT     = 'Verdana';

// ── Canvas layout ──────────────────────────────────────────────────────────────
const W        = 1400;
const H        = 1720;
const PITCH_L  = 50;
const PITCH_W  = W - PITCH_L * 2;   // 1300
const PITCH_T  = 165;
const PITCH_H  = 1430;
const FOOTER_T = PITCH_T + PITCH_H; // 1595
const FOOTER_H = H - FOOTER_T;      // 125
const FLAG_BAR = 5;                 // Romanian tricolour bar thickness at top

// ── Pitch inner bounds (used for clamping player elements) ─────────────────────
const PITCH_INS  = 20;  // inset from PITCH_L/PITCH_T to the drawn lines
const PITCH_XMIN = PITCH_L + PITCH_INS;                    // 70
const PITCH_XMAX = PITCH_L + PITCH_W - PITCH_INS;          // 1330

// ── Card dimensions ────────────────────────────────────────────────────────────
const AR       = 72;   // avatar radius
const CARD_W   = 220;  // name-bar width
const BAR_H    = 46;   // name-bar height
const LOGO_R   = 36;   // team-logo circle radius (mostly outside bar, left)
const LOGO_OVL = 6;    // pixels logo overlaps INTO bar on the left
const FLAG_W   = 54;   // nationality flag width
const FLAG_H   = 36;   // nationality flag height
const FLAG_OVL = 6;    // pixels flag overlaps INTO bar on the right
const PILL_W   = 62;   // position pill width (below bar)
const PILL_H   = 26;   // position pill height
const PILL_GAP = 5;    // gap between bar bottom and pill

// ── Formation: relX 0=left→1=right, relY 0=top(attack)→1=bottom(defend) ──────
const FORMATION = [
  { slot: 'gk',  label: 'GK',  relX: 0.500, relY: 0.875 },
  { slot: 'cb',  label: 'CB',  relX: 0.200, relY: 0.680 },
  { slot: 'cb',  label: 'CB',  relX: 0.500, relY: 0.680 },
  { slot: 'cb',  label: 'CB',  relX: 0.800, relY: 0.680 },
  { slot: 'lm',  label: 'LM',  relX: 0.155, relY: 0.330 },
  { slot: 'cdm', label: 'CDM', relX: 0.308, relY: 0.510 },
  { slot: 'cam', label: 'CAM', relX: 0.500, relY: 0.265 },
  { slot: 'cdm', label: 'CDM', relX: 0.692, relY: 0.510 },
  { slot: 'rm',  label: 'RM',  relX: 0.845, relY: 0.330 },
  { slot: 'st',  label: 'ST',  relX: 0.355, relY: 0.075 },
  { slot: 'st',  label: 'ST',  relX: 0.645, relY: 0.075 },
];

// ── Design theme — Cyan Neon ───────────────────────────────────────────────────
const THEME = {
  pitchFill:     'rgba(5,20,12,0.65)',
  pitchStripe:   'rgba(8,26,16,0.65)',
  lineColor:     '#00E5FF',
  lineGlow:      'rgba(0,229,255,0.65)',
  lineWidth:      2,
  avatarBorder:  '#00E5FF',
  cardBg:        'rgba(3,10,20,0.82)',
  cardBorder:    'rgba(0,229,255,0.35)',
  posBg:         '#005f7f',
  posText:       '#ffffff',
  playerName:    '#ffffff',
  titleColor:    '#ffffff',
  subtitleColor: '#00E5FF',
  footerBg:      'rgba(3,5,10,0.75)',
  footerHash:    '#00E5FF',
};

// ── Utilities ──────────────────────────────────────────────────────────────────

async function tryLoadUrl(url) {
  if (!url) return null;
  try { return await loadImage(url); } catch { return null; }
}

async function tryLoadById(id, variant = 'smThumb') {
  if (!id) return null;
  return tryLoadUrl(`${VPG_CDN}/${id}/${variant}`);
}

async function tryLoadFlag(cc) {
  if (!cc || cc.length < 2) return null;
  return tryLoadUrl(`${FLAG_CDN}/${String(cc).slice(0, 2).toLowerCase()}.png`);
}

function clamp(ctx, text, maxW) {
  if (!text) return '';
  const s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
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

async function ensureOutputDir() {
  const dir = path.resolve('output');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ── Background ─────────────────────────────────────────────────────────────────

function drawBackground(ctx) {
  ctx.fillStyle = '#07090E';
  ctx.fillRect(0, 0, W, H);

  const lg = ctx.createRadialGradient(0, H * 0.45, 0, 0, H * 0.45, W * 0.65);
  lg.addColorStop(0, 'rgba(0,43,127,0.22)');
  lg.addColorStop(1, 'rgba(0,43,127,0)');
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);

  const rg = ctx.createRadialGradient(W, H * 0.55, 0, W, H * 0.55, W * 0.65);
  rg.addColorStop(0, 'rgba(206,17,38,0.18)');
  rg.addColorStop(1, 'rgba(206,17,38,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

  const tg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.4);
  tg.addColorStop(0, 'rgba(252,209,22,0.07)');
  tg.addColorStop(1, 'rgba(252,209,22,0)');
  ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H);
}

// ── Romanian flag bar ──────────────────────────────────────────────────────────

function drawFlagBar(ctx) {
  const t = W / 3;
  ctx.fillStyle = '#002B7F'; ctx.fillRect(0,     0, t,          FLAG_BAR);
  ctx.fillStyle = '#FCD116'; ctx.fillRect(t,     0, t,          FLAG_BAR);
  ctx.fillStyle = '#CE1126'; ctx.fillRect(t * 2, 0, W - t * 2, FLAG_BAR);
}

// ── Pitch ──────────────────────────────────────────────────────────────────────

function drawPitch(ctx, theme) {
  const pl = PITCH_L, pt = PITCH_T, pw = PITCH_W, ph = PITCH_H;
  const ins = PITCH_INS;
  const pW  = pw - ins * 2;
  const pH  = ph - ins * 2;
  const midX = pl + ins + pW / 2;
  const midY = pt + ins + pH / 2;

  ctx.fillStyle = theme.pitchFill;
  ctx.fillRect(pl, pt, pw, ph);
  if (theme.pitchStripe) {
    const sh = ph / 14;
    ctx.fillStyle = theme.pitchStripe;
    for (let i = 0; i < 14; i += 2) ctx.fillRect(pl, pt + i * sh, pw, sh);
  }

  ctx.save();
  ctx.shadowColor = theme.lineGlow;
  ctx.shadowBlur  = 10;
  ctx.strokeStyle = theme.lineColor;
  ctx.lineWidth   = theme.lineWidth;

  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); };
  const arc  = (x, y, r, sa, ea) => { ctx.beginPath(); ctx.arc(x,y,r,sa,ea); ctx.stroke(); };

  ctx.strokeRect(pl + ins, pt + ins, pW, pH);
  line(pl + ins, midY, pl + ins + pW, midY);

  const cr = pW * 0.062;
  arc(midX, midY, cr, 0, Math.PI * 2);
  ctx.fillStyle = theme.lineColor;
  ctx.beginPath(); ctx.arc(midX, midY, 4, 0, Math.PI * 2); ctx.fill();

  const paD = pH * 0.175, paW = pW * 0.55, paX = midX - paW / 2;
  ctx.strokeRect(paX, pt + ins,            paW, paD);
  ctx.strokeRect(paX, pt + ins + pH - paD, paW, paD);

  const gbD = pH * 0.075, gbW = pW * 0.29, gbX = midX - gbW / 2;
  ctx.strokeRect(gbX, pt + ins,            gbW, gbD);
  ctx.strokeRect(gbX, pt + ins + pH - gbD, gbW, gbD);

  ctx.fillStyle = theme.lineColor;
  ctx.beginPath(); ctx.arc(midX, pt + ins + pH * 0.12, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(midX, pt + ins + pH * 0.88, 4, 0, Math.PI * 2); ctx.fill();

  const cR = pW * 0.016;
  arc(pl + ins,      pt + ins,      cR, 0,             Math.PI / 2);
  arc(pl + ins + pW, pt + ins,      cR, Math.PI / 2,   Math.PI);
  arc(pl + ins + pW, pt + ins + pH, cR, Math.PI,       1.5 * Math.PI);
  arc(pl + ins,      pt + ins + pH, cR, 1.5 * Math.PI, 2 * Math.PI);

  ctx.restore();
}

// ── Header ─────────────────────────────────────────────────────────────────────

function drawHeader(ctx, title, subtitle, theme) {
  const cy = FLAG_BAR + (PITCH_T - FLAG_BAR) / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  ctx.font = `bold 58px ${FONT}`;
  ctx.fillStyle = theme.titleColor;
  ctx.shadowColor = 'rgba(0,0,0,0.95)'; ctx.shadowBlur = 12;
  ctx.fillText(title, W / 2, cy - 22);

  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = theme.subtitleColor;
  ctx.shadowBlur = 5;
  ctx.fillText(subtitle, W / 2, cy + 30);
  ctx.shadowBlur = 0;
}

// ── Footer ─────────────────────────────────────────────────────────────────────

async function drawFooter(ctx, leagueLogoUrl, communityLogoUrl, theme) {
  const ft = FOOTER_T, fh = FOOTER_H;

  if (theme.footerBg) {
    ctx.fillStyle = theme.footerBg;
    ctx.fillRect(0, ft, W, fh);
  }

  const logoCy  = ft + fh / 2;
  const logoSz  = 96;
  const logoPad = 40;

  const commImg = communityLogoUrl ? await tryLoadUrl(communityLogoUrl) : null;
  ctx.save();
  ctx.beginPath();
  ctx.arc(logoPad + logoSz / 2, logoCy, logoSz / 2, 0, Math.PI * 2);
  ctx.clip();
  if (commImg) { ctx.drawImage(commImg, logoPad, logoCy - logoSz / 2, logoSz, logoSz); }
  else         { ctx.fillStyle = '#1C2235'; ctx.fill(); }
  ctx.restore();

  const leagImg = leagueLogoUrl ? await tryLoadUrl(leagueLogoUrl) : null;
  const lx = W - logoPad - logoSz;
  ctx.save();
  ctx.beginPath();
  ctx.arc(lx + logoSz / 2, logoCy, logoSz / 2, 0, Math.PI * 2);
  ctx.clip();
  if (leagImg) { ctx.drawImage(leagImg, lx, logoCy - logoSz / 2, logoSz, logoSz); }
  else         { ctx.fillStyle = '#1C2235'; ctx.fill(); }
  ctx.restore();

  const textLeft  = logoPad + logoSz + 10;
  const textRight = lx - 10;
  const textCx    = (textLeft + textRight) / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font      = `bold 30px ${FONT}`;
  ctx.fillStyle = theme.footerHash || '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
  ctx.fillText('#totipentruromania', textCx, logoCy - 16);
  ctx.shadowBlur = 0;
}

// ── Player card ────────────────────────────────────────────────────────────────

async function drawPlayerCard(ctx, player, posLabel, cx, cy, theme) {
  if (!player) return;

  const avatarImg = player.user_avatar ? await tryLoadById(player.user_avatar, 'public') : null;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, AR, 0, Math.PI * 2);
  ctx.fillStyle = '#0E1118'; ctx.fill();
  if (avatarImg) {
    ctx.clip();
    ctx.drawImage(avatarImg, cx - AR, cy - AR, AR * 2, AR * 2);
  } else {
    ctx.clip();
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillStyle = theme.avatarBorder;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((player.username || '?').slice(0, 2).toUpperCase(), cx, cy);
  }
  ctx.restore();

  ctx.save();
  ctx.shadowColor = theme.lineGlow || 'rgba(255,255,255,0.3)';
  ctx.shadowBlur  = 14;
  ctx.beginPath(); ctx.arc(cx, cy, AR + 2, 0, Math.PI * 2);
  ctx.strokeStyle = theme.avatarBorder; ctx.lineWidth = 3; ctx.stroke();
  ctx.restore();

  const barTop  = cy + AR + 8;
  const barLeft = cx - CARD_W / 2;
  const barCy   = barTop + BAR_H / 2;

  rrPath(ctx, barLeft, barTop, CARD_W, BAR_H, 10);
  ctx.fillStyle = theme.cardBg; ctx.fill();
  ctx.strokeStyle = theme.cardBorder; ctx.lineWidth = 1; ctx.stroke();

  const logoCx  = barLeft - (LOGO_R - LOGO_OVL);
  const teamImg = player.team_logo ? await tryLoadById(player.team_logo, 'smThumb') : null;

  ctx.save();
  ctx.beginPath(); ctx.arc(logoCx, barCy, LOGO_R + 2, 0, Math.PI * 2);
  ctx.fillStyle = '#0B0D14'; ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.arc(logoCx, barCy, LOGO_R, 0, Math.PI * 2); ctx.clip();
  if (teamImg) {
    ctx.drawImage(teamImg, logoCx - LOGO_R, barCy - LOGO_R, LOGO_R * 2, LOGO_R * 2);
  } else {
    ctx.fillStyle = '#1C2235'; ctx.fill();
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillStyle = '#94A3B8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((player.team_name || '?').slice(0, 3).toUpperCase(), logoCx, barCy);
  }
  ctx.restore();

  ctx.save();
  ctx.shadowColor = theme.lineGlow; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(logoCx, barCy, LOGO_R + 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = theme.avatarBorder; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();

  const flagCx  = barLeft + CARD_W + (FLAG_W / 2 - FLAG_OVL);
  const flagImg = await tryLoadFlag(player.user_nationality);
  const flagX   = flagCx - FLAG_W / 2;
  const flagY   = barCy - FLAG_H / 2;

  ctx.save();
  rrPath(ctx, flagX, flagY, FLAG_W, FLAG_H, 4);
  ctx.fillStyle = '#1C2235'; ctx.fill();
  if (flagImg) {
    ctx.clip();
    ctx.drawImage(flagImg, flagX, flagY, FLAG_W, FLAG_H);
  } else if (player.user_nationality) {
    ctx.clip();
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillStyle = '#94A3B8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(player.user_nationality).slice(0, 2).toUpperCase(), flagCx, barCy);
  }
  ctx.restore();

  const nameMaxW = CARD_W - LOGO_OVL * 2 - 8;
  ctx.font = `bold 24px ${FONT}`;
  ctx.fillStyle = theme.playerName;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
  ctx.fillText(clamp(ctx, player.username || '', nameMaxW), cx, barCy);
  ctx.shadowBlur = 0;

  const pillTop = barTop + BAR_H + PILL_GAP;
  const pillX   = cx - PILL_W / 2;
  rrPath(ctx, pillX, pillTop, PILL_W, PILL_H, 6);
  ctx.fillStyle = theme.posBg; ctx.fill();
  ctx.font = `bold 18px ${FONT}`;
  ctx.fillStyle = theme.posText;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(posLabel, cx, pillTop + PILL_H / 2);
}

// ── Main export ────────────────────────────────────────────────────────────────

async function generateTOTWImage({ players, season, week, leagueLogoUrl, communityLogoUrl, isToty = false }) {
  const theme    = THEME;
  const title    = isToty ? 'TEAM OF THE YEAR' : 'TEAM OF THE WEEK';
  const subtitle = isToty
    ? `SUPERLIGA ROMANIA S${season}`
    : `SUPERLIGA ROMANIA S${season} W${week}`;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx);
  drawFlagBar(ctx);
  drawPitch(ctx, theme);
  drawHeader(ctx, title, subtitle, theme);

  const slotIdx = {};
  for (const entry of FORMATION) {
    const i      = slotIdx[entry.slot] || 0;
    slotIdx[entry.slot] = i + 1;
    const player = (players[entry.slot] || [])[i] || null;
    const cx     = PITCH_L + entry.relX * PITCH_W;
    const cy     = PITCH_T + entry.relY * PITCH_H;
    await drawPlayerCard(ctx, player, entry.label, cx, cy, theme);
  }

  await drawFooter(ctx, leagueLogoUrl, communityLogoUrl, theme);

  const dir    = await ensureOutputDir();
  const suffix = isToty ? `toty-s${season}` : `totw-s${season}-w${week ?? 'x'}`;
  const out    = path.join(dir, `${suffix}-${Date.now()}.png`);
  await fs.writeFile(out, canvas.toBuffer('image/png'));
  return out;
}

module.exports = { generateTOTWImage };
