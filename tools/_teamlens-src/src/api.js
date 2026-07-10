'use strict';
const log = require('electron-log');
const config = require('./config');

const AGENT_VERSION = require('../package.json').version;

function base() {
  return config.get('serverUrl').replace(/\/$/, '');
}

function deviceHeaders(extra = {}) {
  return {
    Authorization: `Device ${config.get('deviceToken')}`,
    'X-Agent-Version': AGENT_VERSION,
    ...extra,
  };
}

// Enroll this machine using a code pasted by the user (from the admin).
async function enroll(enrollCode, hostname, platform) {
  const res = await fetch(`${base()}/api/devices/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enrollCode,
      hostname,
      platform,
      agentVersion: AGENT_VERSION,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Enroll failed (${res.status}): ${body}`);
  }
  return res.json();
}

// Pull current policy + whether monitoring is on. Returns null on auth failure
// so the caller can decide whether to re-enroll.
async function fetchPolicy() {
  const res = await fetch(`${base()}/api/ingest/policy`, {
    headers: deviceHeaders(),
  });
  if (res.status === 401) return { unauthorized: true };
  if (!res.ok) throw new Error(`Policy fetch failed: ${res.status}`);
  return res.json();
}

// Own daily stats (active/idle/paused seconds + goal) for the status window.
async function fetchMyStats(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(`${base()}/api/ingest/me/stats${qs}`, {
    headers: deviceHeaders(),
  });
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  return res.json();
}

async function heartbeat(paused = false) {
  const res = await fetch(`${base()}/api/ingest/heartbeat`, {
    method: 'POST',
    headers: deviceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ paused }),
  });
  return res.ok;
}

// Upload one screenshot via multipart. `image` is a Buffer (WebP).
async function uploadScreenshot(row) {
  const form = new FormData();
  form.append('capturedAt', row.captured_at);
  if (row.active_app) form.append('activeApp', row.active_app);
  if (row.window_title) form.append('windowTitle', row.window_title);
  if (row.url) form.append('url', row.url);
  if (row.width) form.append('width', String(row.width));
  if (row.height) form.append('height', String(row.height));
  form.append(
    'screenshot',
    new Blob([row.image], { type: 'image/jpeg' }),
    'shot.jpg'
  );

  const res = await fetch(`${base()}/api/ingest/screenshots`, {
    method: 'POST',
    headers: deviceHeaders(), // don't set Content-Type; fetch sets the boundary
    body: form,
  });
  // 202 = monitoring disabled server-side; treat as "accepted, drop locally"
  return { ok: res.ok || res.status === 202, status: res.status };
}

async function uploadActivity(events) {
  const res = await fetch(`${base()}/api/ingest/activity`, {
    method: 'POST',
    headers: deviceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ events }),
  });
  return { ok: res.ok || res.status === 202, status: res.status };
}

module.exports = {
  AGENT_VERSION,
  enroll,
  fetchPolicy,
  fetchMyStats,
  heartbeat,
  uploadScreenshot,
  uploadActivity,
};
