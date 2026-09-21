#!/usr/bin/env node
'use strict';

// TeamLens Screenshot Warning v6
// Uses scheduler.js policy for alert windows.
// Idle sampling in this watcher is disabled (matches no-idle agent patch).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const scheduler = require('./teamlens-scheduler');

const WARN_BEFORE_SEC = 60;
const TICK_MS = 500;
const HEARTBEAT_MIN = 30;

const baseDir = path.join(process.env.APPDATA, 'teamlens-agent');
const toolsDir = path.join(baseDir, 'tools');
const configPath = path.join(baseDir, 'teamlens-agent.json');
const logPath = path.join(baseDir, 'logs', 'main.log');
const queuePath = path.join(baseDir, 'queue-index.json');
const nextShotPath = path.join(baseDir, 'next-shot-at.json');
const patchMarkerPath = path.join(toolsDir, 'patch-installed.json');
const toolLogPath = path.join(toolsDir, 'ss-warning.log');
const statePath = path.join(toolsDir, 'ss-warning-state.json');
const pidPath = path.join(toolsDir, 'ss-warning.pid');
const vbsPath = path.join(toolsDir, 'show-popup.vbs');

let policy = scheduler.getPolicy(configPath);
let schedule = null;
let logPosition = 0;
let queueSnapshot = { seq: 0, screenshots: [] };
let knownShotKeys = new Set();
let monitoringActive = true;
let heartbeatAt = Date.now();
let exactNextShotAt = null;
let exactWarnAt = null;
let exactAlertSent = false;
let patchActive = false;
let lastLoggedExactAt = null;

function writeLog(msg) {
  const line = `[${ts()}] ${msg}`;
  try {
    fs.appendFileSync(toolLogPath, line + '\n', 'utf8');
  } catch {}
  if (process.argv.includes('--foreground')) {
    console.log(line);
  }
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState() {
  if (!schedule) return;
  const data = {
    version: 6,
    lastShotAt: schedule.lastShotAt.toISOString(),
    earlyWarningAt: schedule.earlyWarningAt.toISOString(),
    finalWarningAt: schedule.finalWarningAt.toISOString(),
    earliestNextAt: schedule.earliestNextAt.toISOString(),
    latestNextAt: schedule.latestNextAt.toISOString(),
    earlyAlertSent: schedule.earlyAlertSent,
    finalAlertSent: schedule.finalAlertSent,
    windowLabel: schedule.windowLabel,
    policyMinSec: schedule.policy.min,
    policyMaxSec: schedule.policy.max,
    activityState: 'active',
  };
  fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8');
}

function shotKey(time) {
  return time.toISOString();
}

function setScheduleFromShot(shotTime, reason) {
  schedule = scheduler.buildAlertSchedule(shotTime, policy, WARN_BEFORE_SEC);
  schedule.earlyAlertSent = false;
  schedule.finalAlertSent = false;
  schedule.nextPhase = 'early';
  writeState();
  writeLog(
    `Scheduled from ${scheduler.fmtTime(shotTime)}: early=${scheduler.fmtTime(schedule.earlyWarningAt)}, ` +
      `final=${scheduler.fmtTime(schedule.finalWarningAt)}, window=${schedule.windowLabel} (${reason})`
  );
}

function restoreSchedule(shotTime) {
  const saved = readState();
  if (!saved) return false;

  const savedShot = scheduler.parseIso(saved.lastShotAt);
  if (!savedShot || savedShot.getTime() !== shotTime.getTime()) return false;

  schedule = scheduler.buildAlertSchedule(shotTime, policy, WARN_BEFORE_SEC);

  if (saved.version === 6) {
    schedule.earlyWarningAt = scheduler.parseIso(saved.earlyWarningAt) || schedule.earlyWarningAt;
    schedule.finalWarningAt = scheduler.parseIso(saved.finalWarningAt) || schedule.finalWarningAt;
    schedule.earliestNextAt = scheduler.parseIso(saved.earliestNextAt) || schedule.earliestNextAt;
    schedule.latestNextAt = scheduler.parseIso(saved.latestNextAt) || schedule.latestNextAt;
    schedule.windowLabel = saved.windowLabel || schedule.windowLabel;
  }

  schedule.earlyAlertSent = Boolean(saved.earlyAlertSent);
  schedule.finalAlertSent = Boolean(saved.finalAlertSent);
  schedule.nextPhase = schedule.earlyAlertSent
    ? schedule.finalAlertSent
      ? 'done'
      : 'final'
    : 'early';

  writeLog(
    `Startup: restored schedule early=${scheduler.fmtTime(schedule.earlyWarningAt)} ` +
      `final=${scheduler.fmtTime(schedule.finalWarningAt)} window=${schedule.windowLabel}`
  );
  return true;
}

function clearSchedule(reason) {
  schedule = null;
  writeLog(`Warning cancelled (${reason})`);
}

function showAlert(kind, shotTime) {
  const isEarly = kind === 'early';
  const title = 'TeamLens Screenshot Alert';
  const window = schedule?.windowLabel || '';
  const message = isEarly
    ? `TeamLens may take a screenshot soon.\n\nNext screenshot window: ${window}\n\nPlease switch to your work window.\n\nAnother reminder comes ~1 minute before the latest possible time.`
    : `TeamLens may capture your screen in about 1 minute!\n\nNext screenshot window: ${window}\n\nSwitch to your work window now.`;

  writeLog(`Showing ${kind} alert dialog`);

  try {
    fs.writeFileSync(path.join(toolsDir, 'popup-title.txt'), title, 'utf8');
    fs.writeFileSync(path.join(toolsDir, 'popup-msg.txt'), message, 'utf8');
    fs.writeFileSync(path.join(toolsDir, 'popup-timeout.txt'), '30', 'ascii');
    const proc = spawn(`${process.env.SystemRoot}\\System32\\wscript.exe`, [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.unref();
    writeLog(`Alert dialog launched (PID ${proc.pid || '?'})`);
  } catch (err) {
    writeLog(`Alert dialog failed: ${err.message}`);
    return false;
  }

  if (isEarly) schedule.earlyAlertSent = true;
  else schedule.finalAlertSent = true;
  writeState();
  writeLog(`${isEarly ? 'Early' : 'Final'} alert shown`);
  return true;
}

function readNextShotFile() {
  if (!fs.existsSync(nextShotPath)) {
    exactNextShotAt = null;
    exactWarnAt = null;
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(nextShotPath, 'utf8'));
    const at = scheduler.parseIso(data.at);
    if (!at || at.getTime() <= Date.now()) {
      exactNextShotAt = null;
      exactWarnAt = null;
      return;
    }
    exactNextShotAt = at;
    exactWarnAt = new Date(at.getTime() - WARN_BEFORE_SEC * 1000);
    if (lastLoggedExactAt !== at.toISOString()) {
      lastLoggedExactAt = at.toISOString();
      writeLog(
        `EXACT next SS at ${scheduler.fmtTime(at)} (patch active, warn ${scheduler.fmtTime(exactWarnAt)})`
      );
    }
  } catch {
    exactNextShotAt = null;
    exactWarnAt = null;
  }
}

function checkExactAlert() {
  if (!patchActive || !exactWarnAt || exactAlertSent || !monitoringActive) return;
  if (Date.now() < exactWarnAt.getTime()) return;

  const atLabel = exactNextShotAt ? scheduler.fmtTime(exactNextShotAt) : '?';
  fs.writeFileSync(path.join(toolsDir, 'popup-title.txt'), 'TeamLens Screenshot Alert', 'utf8');
  fs.writeFileSync(
    path.join(toolsDir, 'popup-msg.txt'),
    `EXACT: TeamLens will capture in about 1 minute!\n\nScheduled time: ${atLabel}\n\nSwitch to your work window now.\n\n(After patch: you will also see image preview before post.)`,
    'utf8'
  );
  fs.writeFileSync(path.join(toolsDir, 'popup-timeout.txt'), '30', 'ascii');
  writeLog(`Showing EXACT alert for ${atLabel}`);
  try {
    const proc = spawn(`${process.env.SystemRoot}\\System32\\wscript.exe`, [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.unref();
    exactAlertSent = true;
    writeLog(`EXACT alert launched (PID ${proc.pid || '?'})`);
  } catch (err) {
    writeLog(`EXACT alert failed: ${err.message}`);
  }
}

function checkDueAlerts() {
  if (patchActive && exactNextShotAt) {
    checkExactAlert();
    return;
  }
  if (!schedule || !monitoringActive) return;
  const now = Date.now();

  if (!schedule.earlyAlertSent && now >= schedule.earlyWarningAt.getTime()) {
    showAlert('early', schedule.lastShotAt);
    schedule.nextPhase = 'final';
  }

  const finalGapSec = (schedule.finalWarningAt - schedule.earlyWarningAt) / 1000;
  if (
    !schedule.finalAlertSent &&
    finalGapSec >= 120 &&
    now >= schedule.finalWarningAt.getTime()
  ) {
    showAlert('final', schedule.lastShotAt);
    schedule.nextPhase = 'done';
  }
}

function onNewScreenshot(shotTime, reason) {
  if (!shotTime) return;
  const key = shotKey(shotTime);
  if (knownShotKeys.has(key)) return;
  knownShotKeys.add(key);
  if (knownShotKeys.size > 50) {
    knownShotKeys = new Set([...knownShotKeys].slice(-30));
  }
  setScheduleFromShot(shotTime, reason);
  exactAlertSent = false;
  checkDueAlerts();
}

function processLogLine(line) {
  if (line.includes('[shot] next capture at')) {
    readNextShotFile();
    exactAlertSent = false;
    return;
  }
  if (line.includes('[shot] captured')) {
    const t = scheduler.parseLogTimestamp(line);
    onNewScreenshot(t, 'main.log');
    return;
  }
  if (line.includes('[shot] scheduler stopped') || line.includes('[main] monitoring stopped')) {
    monitoringActive = false;
    clearSchedule('monitoring paused/stopped');
    return;
  }
  if (line.includes('[shot] scheduler started') || line.includes('[main] monitoring started')) {
    monitoringActive = true;
    writeLog('Monitoring active');
  }
  if (line.includes('[activity] tracker started')) {
    writeLog('Activity tracker started (agent)');
  }
  if (line.includes('[activity] tracker stopped')) {
    writeLog('Activity tracker stopped (agent)');
  }
}

function readNewLogLines() {
  if (!fs.existsSync(logPath)) return;
  let fd;
  try {
    const stat = fs.statSync(logPath);
    if (logPosition > stat.size) logPosition = 0;
    fd = fs.openSync(logPath, 'r');
    const len = stat.size - logPosition;
    if (len <= 0) {
      fs.closeSync(fd);
      return;
    }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, logPosition);
    logPosition = stat.size;
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) processLogLine(line);
    }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function readQueueIndex() {
  if (!fs.existsSync(queuePath)) return;
  let raw;
  try {
    raw = fs.readFileSync(queuePath, 'utf8');
    const data = JSON.parse(raw);
    const shots = Array.isArray(data.screenshots) ? data.screenshots : [];

    for (const shot of shots) {
      const t = scheduler.parseIso(shot.captured_at);
      if (t) onNewScreenshot(t, 'queue-index.json');
    }

    queueSnapshot = { seq: data.seq || 0, screenshots: shots };
  } catch {
    // queue may be mid-write
  }
}

function initFromExisting() {
  policy = scheduler.getPolicy(configPath);

  patchActive = fs.existsSync(patchMarkerPath);
  readNextShotFile();

  if (fs.existsSync(logPath)) {
    logPosition = fs.statSync(logPath).size;
    const tail = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-500);
    let lastShot = null;
    for (const line of tail) {
      if (line.includes('[shot] captured')) {
        const t = scheduler.parseLogTimestamp(line);
        if (t) lastShot = t;
      }
      if (line.includes('[shot] scheduler stopped') || line.includes('[main] monitoring stopped')) {
        monitoringActive = false;
      }
      if (line.includes('[shot] scheduler started') || line.includes('[main] monitoring started')) {
        monitoringActive = true;
      }
    }
    if (lastShot && monitoringActive) {
      const deadline = lastShot.getTime() + policy.maxIntervalSec * 1000;
      if (Date.now() <= deadline) {
        if (!restoreSchedule(lastShot)) {
          setScheduleFromShot(lastShot, 'startup resume');
        }
        checkDueAlerts();
      }
    }
  }

  readQueueIndex();
}

function writePid() {
  fs.writeFileSync(pidPath, String(process.pid), 'ascii');
}

function removePid() {
  try { fs.unlinkSync(pidPath); } catch {}
}

function stopOtherInstance() {
  if (!fs.existsSync(pidPath)) return;
  try {
    const oldPid = parseInt(fs.readFileSync(pidPath, 'ascii').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, 'SIGTERM');
      writeLog(`Stopped previous instance (PID ${oldPid})`);
    }
  } catch {}
}

function showTestAlert() {
  fs.writeFileSync(path.join(toolsDir, 'popup-title.txt'), 'TeamLens Screenshot Alert', 'utf8');
  fs.writeFileSync(
    path.join(toolsDir, 'popup-msg.txt'),
    'TEST: Alerts are working. This popup auto-closes in 30 seconds.',
    'utf8'
  );
  fs.writeFileSync(path.join(toolsDir, 'popup-timeout.txt'), '30', 'ascii');
  execFileSync(`${process.env.SystemRoot}\\System32\\wscript.exe`, [vbsPath], { stdio: 'inherit' });
}

function startWatcher() {
  if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });

  stopOtherInstance();
  writePid();
  writeLog(
    `=== SS Warning v6 started (${patchActive ? 'EXACT patch + ' : ''}activity.js + scheduler.js policy) ===`
  );

  initFromExisting();

  // Idle detection in this watcher is disabled (matches no-idle agent patch).
  // Do not start activity sampling / idle logs here.

  if (fs.existsSync(queuePath)) {
    fs.watch(queuePath, { persistent: true }, () => {
      setTimeout(readQueueIndex, 50);
    });
  }

  if (fs.existsSync(nextShotPath)) {
    fs.watch(nextShotPath, { persistent: true }, () => {
      setTimeout(() => {
        readNextShotFile();
        exactAlertSent = false;
      }, 50);
    });
  }

  const loop = setInterval(() => {
    policy = scheduler.getPolicy(configPath);
    patchActive = fs.existsSync(patchMarkerPath);
    readNewLogLines();
    if (patchActive) readNextShotFile();
    checkDueAlerts();

    if (Date.now() - heartbeatAt >= HEARTBEAT_MIN * 60 * 1000) {
      const extra = exactNextShotAt
        ? ` EXACT next ${scheduler.fmtTime(exactNextShotAt)}`
        : schedule
          ? ` next window ${schedule.windowLabel}, phase ${schedule.nextPhase || 'n/a'}`
          : '';
      writeLog(`Heartbeat: watcher alive (PID ${process.pid})${extra}`);
      heartbeatAt = Date.now();
    }
  }, TICK_MS);

  const shutdown = () => {
    clearInterval(loop);
    removePid();
    writeLog('=== SS Warning tool stopped ===');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// CLI
const arg = process.argv[2];
if (arg === '--test') {
  showTestAlert();
} else if (arg === '--stop') {
  stopOtherInstance();
  removePid();
  console.log('Stop signal sent.');
} else if (arg === '--start') {
  const child = spawn(process.execPath, [__filename, '--foreground'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: toolsDir,
  });
  child.unref();
  setTimeout(() => {
    if (fs.existsSync(pidPath)) {
      console.log(`ss-warning started (PID ${fs.readFileSync(pidPath, 'ascii').trim()})`);
    } else {
      console.log('ss-warning start requested. Check ss-warning.log');
    }
  }, 1500);
} else {
  startWatcher();
}
