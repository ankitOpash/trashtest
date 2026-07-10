'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const log = require('electron-log');

// Offline-first queue, pure JS — no native modules so the agent builds with
// zero compilation on any platform, keeping the same exported API its
// consumers (scheduler, uploader, activity) already depend on.
//
// Design:
//  - Metadata lives in a single JSON index, written atomically (temp + rename)
//    so a crash mid-write can never corrupt it.
//  - Screenshot image bytes are stored as individual files on disk (referenced
//    by filename in the index), never inlined into JSON — keeps the index small
//    and avoids base64 bloat. Consumers still receive an `image` Buffer.
//  - All mutations are debounced-flushed to disk; we also flush synchronously
//    on enqueue/delete so nothing is lost across an abrupt exit.

let dir; // userData
let indexPath; // queue-index.json
let shotsDir; // directory holding raw image files
let state = { seq: 0, screenshots: [], activity: [] };

function init() {
  dir = app.getPath('userData');
  indexPath = path.join(dir, 'queue-index.json');
  shotsDir = path.join(dir, 'queue-shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  try {
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        seq: parsed.seq || 0,
        screenshots: Array.isArray(parsed.screenshots) ? parsed.screenshots : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      };
    }
  } catch (err) {
    log.error('[queue] index corrupt, starting fresh:', err.message);
    state = { seq: 0, screenshots: [], activity: [] };
  }
  // Reconcile: drop screenshot records whose image file vanished.
  state.screenshots = state.screenshots.filter((s) => {
    const ok = fs.existsSync(path.join(shotsDir, s.file));
    if (!ok) log.warn('[queue] missing image file, dropping record', s.id);
    return ok;
  });
  flush();
  log.info('[queue] initialized (json) at', indexPath);
}

// Atomic write: write temp, fsync, rename over the target.
function flush() {
  const tmp = indexPath + '.tmp';
  const data = JSON.stringify(state);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, indexPath);
}

function nextId() {
  state.seq += 1;
  return state.seq;
}

// ── Screenshots ──────────────────────────────────────────────
function enqueueScreenshot(row) {
  const id = nextId();
  const file = `shot_${id}.jpg`;
  // Persist the image bytes to its own file first…
  fs.writeFileSync(path.join(shotsDir, file), row.image);
  // …then record metadata.
  state.screenshots.push({
    id,
    file,
    captured_at: row.captured_at,
    active_app: row.active_app ?? null,
    window_title: row.window_title ?? null,
    url: row.url ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    attempts: 0,
  });
  flush();
}

function nextScreenshots(limit = 5) {
  const out = [];
  for (const rec of state.screenshots) {
    if (rec.attempts >= 10) continue;
    let image;
    try {
      image = fs.readFileSync(path.join(shotsDir, rec.file));
    } catch {
      continue; // file gone; prune() will clean the record
    }
    out.push({ ...rec, image });
    if (out.length >= limit) break;
  }
  return out;
}

function deleteScreenshot(id) {
  const idx = state.screenshots.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [rec] = state.screenshots.splice(idx, 1);
  try {
    fs.unlinkSync(path.join(shotsDir, rec.file));
  } catch {
    /* already gone */
  }
  flush();
}

function bumpScreenshotAttempt(id) {
  const rec = state.screenshots.find((s) => s.id === id);
  if (rec) {
    rec.attempts += 1;
    flush();
  }
}

// ── Activity ─────────────────────────────────────────────────
function enqueueActivity(row) {
  state.activity.push({
    id: nextId(),
    start_at: row.start_at,
    end_at: row.end_at,
    duration_sec: row.duration_sec,
    state: row.state,
    active_app: row.active_app ?? null,
    window_title: row.window_title ?? null,
    url: row.url ?? null,
    attempts: 0,
  });
  flush();
}

function nextActivity(limit = 100) {
  return state.activity.filter((a) => a.attempts < 10).slice(0, limit);
}

function deleteActivity(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.activity = state.activity.filter((a) => !set.has(a.id));
  flush();
}

function bumpActivityAttempts(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  for (const a of state.activity) if (set.has(a.id)) a.attempts += 1;
  flush();
}

// Drop rows that failed too many times, and cap total screenshots so a long
// offline period can't fill the disk.
function prune(maxScreenshots = 2000) {
  let changed = false;

  // Remove exhausted screenshots (and their files)
  const keepShots = [];
  for (const s of state.screenshots) {
    if (s.attempts >= 10) {
      try {
        fs.unlinkSync(path.join(shotsDir, s.file));
      } catch {
        /* ignore */
      }
      changed = true;
    } else {
      keepShots.push(s);
    }
  }
  state.screenshots = keepShots;

  // Remove exhausted activity
  const beforeAct = state.activity.length;
  state.activity = state.activity.filter((a) => a.attempts < 10);
  if (state.activity.length !== beforeAct) changed = true;

  // Cap total screenshots (drop oldest)
  if (state.screenshots.length > maxScreenshots) {
    const excess = state.screenshots.length - maxScreenshots;
    const removed = state.screenshots.splice(0, excess);
    for (const r of removed) {
      try {
        fs.unlinkSync(path.join(shotsDir, r.file));
      } catch {
        /* ignore */
      }
    }
    log.warn(`[queue] pruned ${excess} oldest screenshots (cap ${maxScreenshots})`);
    changed = true;
  }

  if (changed) flush();
}

function stats() {
  return {
    screenshots: state.screenshots.length,
    activity: state.activity.length,
  };
}

module.exports = {
  init,
  enqueueScreenshot,
  nextScreenshots,
  deleteScreenshot,
  bumpScreenshotAttempt,
  enqueueActivity,
  nextActivity,
  deleteActivity,
  bumpActivityAttempts,
  prune,
  stats,
};
