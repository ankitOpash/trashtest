'use strict';

// Port of TeamLens src/scheduler.js policy + timing helpers.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY = {
  minIntervalSec: 300,
  maxIntervalSec: 600,
  idleThresholdSec: 300,
};

function loadConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getPolicy(configPath) {
  const config = loadConfig(configPath);
  const p = config.policy || {};
  const min = Number(p.minIntervalSec ?? DEFAULT_POLICY.minIntervalSec);
  const max = Number(p.maxIntervalSec ?? DEFAULT_POLICY.maxIntervalSec);
  return {
    minIntervalSec: min > 0 ? min : DEFAULT_POLICY.minIntervalSec,
    maxIntervalSec: max >= min ? max : min + 300,
    idleThresholdSec: Number(p.idleThresholdSec ?? DEFAULT_POLICY.idleThresholdSec),
    monitoringEnabled: config.monitoringEnabled !== false,
  };
}

// Same formula as scheduler.js nextDelayMs()
function nextDelaySec(policy) {
  const min = policy.minIntervalSec ?? 300;
  const max = policy.maxIntervalSec ?? 600;
  const sec = min + Math.random() * Math.max(0, max - min);
  return Math.round(sec);
}

function buildAlertSchedule(lastShotAt, policy, warnBeforeSec = 60) {
  const min = policy.minIntervalSec;
  const max = policy.maxIntervalSec;
  const shotMs = lastShotAt.getTime();

  const earliestNextMs = shotMs + min * 1000;
  const latestNextMs = shotMs + max * 1000;

  const earlyMs = shotMs + Math.max(15, min - warnBeforeSec) * 1000;
  const finalMs = shotMs + Math.max(min - warnBeforeSec, max - warnBeforeSec) * 1000;

  return {
    lastShotAt,
    policy: { min, max },
    earliestNextAt: new Date(earliestNextMs),
    latestNextAt: new Date(latestNextMs),
    earlyWarningAt: new Date(earlyMs),
    finalWarningAt: new Date(finalMs),
    windowLabel: `${fmtTime(new Date(earliestNextMs))} to ${fmtTime(new Date(latestNextMs))}`,
  };
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function parseLogTimestamp(line) {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
  if (!m) return null;
  const d = new Date(m[1].replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  DEFAULT_POLICY,
  getPolicy,
  nextDelaySec,
  buildAlertSchedule,
  parseLogTimestamp,
  parseIso,
  fmtTime,
};
