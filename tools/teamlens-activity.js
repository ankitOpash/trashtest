'use strict';

// Port of TeamLens src/activity.js idle detection (Windows, no Electron).
// Uses the same SAMPLE_MS and idleThresholdSec policy as the agent.

const { execFileSync } = require('node:child_process');

const SAMPLE_MS = 15000;

let timer = null;
let onStateChange = null;
let lastState = null;

function getIdleThresholdSec(policy) {
  return policy?.idleThresholdSec ?? 300;
}

function getSystemIdleTimeSec() {
  const script = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class TLIdle {',
    '  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
    '  public static int Seconds() {',
    '    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);',
    '    GetLastInputInfo(ref i);',
    '    return (int)(((uint)Environment.TickCount - i.dwTime) / 1000);',
    '  }',
    '}',
    '"@',
    '[TLIdle]::Seconds()',
  ].join('\n');

  try {
    const out = execFileSync(
      `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }
    );
    const sec = parseInt(String(out).trim(), 10);
    return Number.isFinite(sec) ? Math.max(0, sec) : 0;
  } catch {
    return 0;
  }
}

function sample(policy) {
  const idleSec = getSystemIdleTimeSec();
  const threshold = getIdleThresholdSec(policy);
  const isIdle = idleSec >= threshold;
  const state = isIdle ? 'idle' : 'active';

  if (state !== lastState) {
    lastState = state;
    if (onStateChange) {
      onStateChange({ state, idleSec, thresholdSec: threshold });
    }
  }

  return { state, idleSec, thresholdSec: threshold, isIdle };
}

function start(policy, stateChangeCb) {
  if (timer) return;
  onStateChange = stateChangeCb || null;
  lastState = null;
  sample(policy);
  timer = setInterval(() => sample(policy), SAMPLE_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  onStateChange = null;
  lastState = null;
}

function getLastState() {
  return lastState;
}

module.exports = {
  SAMPLE_MS,
  getSystemIdleTimeSec,
  getIdleThresholdSec,
  sample,
  start,
  stop,
  getLastState,
};
