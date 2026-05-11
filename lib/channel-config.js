'use strict';

// Runtime channel config. Loads from Firestore at startup; falls back to env vars.
// Firestore document: bots/vpg-romania  (publicly readable, admin-writable)
// Set FIREBASE_PROJECT_ID env var to enable Firestore sync.

const PROJECT_ID    = process.env.FIREBASE_PROJECT_ID || '';
const FIRESTORE_URL = PROJECT_ID
  ? `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/bots/vpg-romania`
  : null;

const config = {
  superligaScheduleChannelId:  process.env.SUPERLIGA_SCHEDULE_CHANNEL_ID  || '',
  superligaResultsChannelId:   process.env.SUPERLIGA_RESULTS_CHANNEL_ID   || '',
  superligaClasamentChannelId: process.env.SUPERLIGA_CLASAMENT_CHANNEL_ID || '',
  nationalTeamChannelId:       process.env.VPG_NATIONAL_TEAM_CHANNEL_ID   || '',
  totwChannelId:               process.env.TOTW_CHANNEL_ID                || '',
  totyChannelId:               process.env.TOTY_CHANNEL_ID                || '',
};

function parseFirestoreDoc(doc) {
  const out = {};
  for (const [key, val] of Object.entries(doc.fields ?? {})) {
    if (typeof val.stringValue === 'string') out[key] = val.stringValue;
  }
  return out;
}

async function loadFromFirestore() {
  if (!FIRESTORE_URL) return false;
  try {
    const res = await fetch(FIRESTORE_URL, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return false; // not configured yet — keep env var values
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = parseFirestoreDoc(await res.json());
    let changed = 0;
    for (const [key, val] of Object.entries(remote)) {
      if (key in config && val) { config[key] = val; changed++; }
    }
    if (changed) console.log(`[Config] Loaded ${changed} channel(s) from Firestore.`);
    return true;
  } catch (err) {
    console.warn('[Config] Firestore load failed, using env vars:', err.message);
    return false;
  }
}

module.exports = { config, loadFromFirestore };
