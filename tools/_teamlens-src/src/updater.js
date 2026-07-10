'use strict';
const { autoUpdater } = require('electron-updater');
const { powerMonitor } = require('electron');
const log = require('electron-log');

autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Once a downloaded update is pending, require this much idle time before
// forcing a relaunch to install it, so we never interrupt active work.
const IDLE_INSTALL_THRESHOLD_SEC = 120;
const IDLE_POLL_MS = 30 * 1000;
// If the machine is never idle long enough, give up waiting and install anyway.
const MAX_INSTALL_WAIT_MS = 2 * 60 * 60 * 1000;

let idlePollTimer = null;
let installDeadline = null;

function tryInstallWhenIdle() {
  const idleSec = powerMonitor.getSystemIdleTime();
  const pastDeadline = installDeadline !== null && Date.now() >= installDeadline;
  if (idleSec >= IDLE_INSTALL_THRESHOLD_SEC || pastDeadline) {
    clearInterval(idlePollTimer);
    idlePollTimer = null;
    installDeadline = null;
    log.info(
      `[update] installing now (idle ${idleSec}s${pastDeadline ? ', wait deadline reached' : ''})`
    );
    autoUpdater.quitAndInstall(false, true);
  }
}

function scheduleIdleInstall() {
  if (idlePollTimer) return;
  installDeadline = Date.now() + MAX_INSTALL_WAIT_MS;
  tryInstallWhenIdle(); // install immediately if already idle
  if (idlePollTimer === null) {
    idlePollTimer = setInterval(tryInstallWhenIdle, IDLE_POLL_MS);
  }
}

// Checks the generic update server configured in package.json build.publish.
// Downloads happen silently in the background; once downloaded, the update is
// installed as soon as the machine is idle (see scheduleIdleInstall), instead
// of waiting indefinitely for the user to quit the app themselves.
function init() {
  autoUpdater.on('error', (err) => log.error('[update] error:', err?.message));
  autoUpdater.on('update-available', (i) =>
    log.info('[update] available:', i?.version)
  );
  autoUpdater.on('update-downloaded', (i) => {
    log.info('[update] downloaded, will install when idle:', i?.version);
    scheduleIdleInstall();
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((e) =>
      log.warn('[update] check failed:', e?.message)
    );
  };

  // First check after 1 min, then every 10 mins
  setTimeout(check, 60 * 1000);
  setInterval(check, 10 * 60 * 1000);
}

// Called from the policy poll when the server reports a forceUpdateAt
// timestamp (an admin clicked "Force update" in the dashboard). Triggers an
// immediate check instead of waiting for the periodic timer above. Harmless
// to call repeatedly with the same timestamp — checkForUpdates() is a no-op
// once the agent is already current, so this can't loop or spam restarts.
let lastForcedAt = null;
function checkNow(forceUpdateAt) {
  if (!forceUpdateAt || forceUpdateAt === lastForcedAt) return;
  lastForcedAt = forceUpdateAt;
  log.info('[update] admin requested an immediate update check');
  autoUpdater.checkForUpdates().catch((e) =>
    log.warn('[update] forced check failed:', e?.message)
  );
}

module.exports = { init, checkNow };
