'use strict';
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  systemPreferences,
  shell,
  dialog,
  Notification,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const log = require('electron-log');

const config = require('./config');
const queue = require('./queue');
const api = require('./api');
const activity = require('./activity');
const scheduler = require('./scheduler');
const uploader = require('./uploader');
const updater = require('./updater');
const stats = require('./stats');

log.transports.file.level = 'info';
log.info('=== TeamLens Agent starting ===', api.AGENT_VERSION);

let tray = null;
let trayMenu = null;
let enrollWindow = null;
let statusWindow = null;
let monitoringActive = false;
let userPaused = false;
let pauseStartedAt = null;
let policyTimer = null;

// ── Single instance ──────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running. On macOS this is invisible (no dock icon)
  // so tell the user where to find it rather than silently exiting.
  app.whenReady().then(() => {
    if (Notification.isSupported()) {
      new Notification({
        title: 'TeamLens Agent is already running',
        body: 'Look for the TeamLens icon in the menu bar (top-right of your screen).',
      }).show();
    }
    setTimeout(() => app.quit(), 3000);
  });
} else {
  app.on('second-instance', () => {
    if (enrollWindow) {
      if (enrollWindow.isMinimized()) enrollWindow.restore();
      enrollWindow.focus();
    }
  });
}

// No dock icon on macOS — this is a background tray app
if (process.platform === 'darwin' && app.dock) app.dock.hide();

function platformKey() {
  return process.platform === 'darwin' ? 'darwin' : 'win32';
}

// ── macOS screen-recording permission ────────────────────────
let _screenPermPollTimer = null;

function startScreenPermPoll() {
  if (_screenPermPollTimer) return;
  _screenPermPollTimer = setInterval(() => {
    const s = systemPreferences.getMediaAccessStatus('screen');
    if (s === 'granted') {
      clearInterval(_screenPermPollTimer);
      _screenPermPollTimer = null;
      log.info('[perm] screen recording granted — restarting to activate');
      app.relaunch();
      app.exit(0);
    }
  }, 3000);
  // Stop polling after 10 minutes so it doesn't run forever
  setTimeout(() => {
    if (_screenPermPollTimer) {
      clearInterval(_screenPermPollTimer);
      _screenPermPollTimer = null;
    }
  }, 10 * 60 * 1000);
}

async function ensureScreenPermission() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  log.info('[perm] screen access status:', status);
  if (status === 'granted') return true;

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Screen Recording permission needed',
    message: 'TeamLens needs Screen Recording permission to capture screenshots.',
    detail:
      'Click "Open Settings" to go to System Settings → Privacy & Security → ' +
      'Screen Recording, then enable TeamLens Agent.\n\n' +
      'The app will restart automatically once permission is granted.',
    buttons: ['Open Settings', 'Later'],
  });

  if (response === 0) {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  }

  // Poll and auto-restart as soon as permission is granted
  startScreenPermPoll();
  return false;
}

// ── Tray ─────────────────────────────────────────────────────
function trayIcon(active) {
  // Use a template image so it adapts to light/dark menubar on macOS.
  const file = active ? 'tray-active.png' : 'tray-idle.png';
  const p = path.join(__dirname, '..', 'assets', file);
  const img = nativeImage.createFromPath(p);
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildTrayMenu() {
  const enrolled = config.isEnrolled();

  let statusLabel;
  if (!enrolled) statusLabel = 'Not connected';
  else if (monitoringActive) statusLabel = '● Monitoring active';
  else if (userPaused) statusLabel = '○ Paused by you';
  else statusLabel = '○ Monitoring disabled';

  const items = [
    { label: statusLabel, enabled: false },
    { type: 'separator' },
  ];

  if (enrolled) {
    const s = queue.stats();
    items.push({
      label: `Queued: ${s.screenshots} shots, ${s.activity} events`,
      enabled: false,
    });
    items.push({ type: 'separator' });
    if (monitoringActive) {
      items.push({ label: 'Pause monitoring', click: () => pauseByUser() });
    } else if (userPaused) {
      items.push({ label: 'Resume monitoring', click: () => resumeByUser() });
    }
  } else {
    items.push({
      label: 'Connect device…',
      click: () => showEnrollWindow(),
    });
  }

  // Project picker — tags activity with whatever the member selects here
  if (enrolled) {
    const projects = config.get('projects') || [];
    const currentProjectId = config.get('currentProjectId');
    items.push({ type: 'separator' });
    items.push({
      label: 'Project',
      submenu: [
        {
          label: 'Unassigned',
          type: 'radio',
          checked: !currentProjectId,
          click: () => setCurrentProject(null, null),
        },
        ...(projects.length ? [{ type: 'separator' }] : []),
        ...projects.map((p) => ({
          label: p.client ? `${p.name} (${p.client})` : p.name,
          type: 'radio',
          checked: currentProjectId === p._id,
          click: () => setCurrentProject(p._id, p.name),
        })),
      ],
    });
  }

  // Inform member which apps have their screenshots blurred
  const privateApps = config.get('privateApps') || [];
  if (privateApps.length) {
    items.push({ type: 'separator' });
    items.push({
      label: `Screenshots blurred: ${privateApps.join(', ')}`,
      enabled: false,
    });
  }

  // Privacy patch: consent before upload + no idle reporting
  if (enrolled) {
    const consentOn = config.get('ssConsentEnabled') !== false;
    items.push({ type: 'separator' });
    items.push({
      label: 'SS approval + no idle',
      type: 'checkbox',
      checked: consentOn,
      click: (menuItem) => {
        const enabled = Boolean(menuItem.checked);
        config.set('ssConsentEnabled', enabled);
        log.info('[main] ssConsentEnabled set to', enabled);
        refreshTray();
      },
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Open logs',
    click: () => shell.showItemInFolder(log.transports.file.getFile().path),
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Restart TeamLens',
    click: () => {
      log.info('[main] restarting via tray menu');
      app.relaunch();
      app.exit(0);
    },
  });
  items.push({ label: 'Quit TeamLens', click: () => quitApp() });
  items.push({ type: 'separator' });
  items.push({ label: `TeamLens v${api.AGENT_VERSION}`, enabled: false });

  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(trayIcon(monitoringActive));
  tray.setToolTip(
    monitoringActive ? 'TeamLens — monitoring active' : 'TeamLens — idle'
  );
  // Kept off the tray itself (see createTray) so a left-click can open the
  // status window instead of always popping up the menu.
  trayMenu = buildTrayMenu();
}

function onTrayClick() {
  if (config.isEnrolled()) showStatusWindow();
  else showEnrollWindow();
}

function createTray() {
  tray = new Tray(trayIcon(false));
  tray.setToolTip('TeamLens Agent');
  refreshTray();
  tray.on('click', onTrayClick);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
}

// ── Enrollment window ────────────────────────────────────────
function showEnrollWindow() {
  if (enrollWindow) {
    enrollWindow.focus();
    return;
  }
  enrollWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    title: 'TeamLens Agent — Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  enrollWindow.loadFile(path.join(__dirname, 'enroll.html'));
  enrollWindow.on('closed', () => {
    enrollWindow = null;
  });
}

// ── Status window ─────────────────────────────────────────────
function showStatusWindow() {
  if (statusWindow) {
    statusWindow.focus();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 380,
    height: 680,
    useContentSize: true, // height above is the page's content area, not the outer window
    resizable: false,
    title: 'TeamLens — Status',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  statusWindow.loadFile(path.join(__dirname, 'status.html'));
  statusWindow.on('closed', () => {
    statusWindow = null;
  });
}

// ── Monitoring lifecycle ─────────────────────────────────────
function startMonitoring() {
  if (monitoringActive) return;
  monitoringActive = true;
  activity.start();
  scheduler.start();
  uploader.start();
  refreshTray();
  log.info('[main] monitoring started');
}

function stopMonitoring() {
  if (!monitoringActive) return;
  monitoringActive = false;
  activity.stop();
  scheduler.stop();
  // keep uploader running so the queue still drains after a pause
  refreshTray();
  log.info('[main] monitoring stopped');
}

function pauseByUser() {
  userPaused = true;
  pauseStartedAt = Date.now();
  stopMonitoring();
  api.heartbeat(true).catch(() => {});
  log.info('[main] monitoring paused by user');
}

function flushPauseEvent() {
  if (!pauseStartedAt) return;
  const endAt = new Date();
  const durationSec = Math.max(1, Math.round((Date.now() - pauseStartedAt) / 1000));
  queue.enqueueActivity({
    start_at: new Date(pauseStartedAt).toISOString(),
    end_at: endAt.toISOString(),
    duration_sec: durationSec,
    state: 'paused',
    active_app: null,
    window_title: null,
    url: null,
  });
  pauseStartedAt = null;
}

function resumeByUser() {
  flushPauseEvent();
  userPaused = false;
  api.heartbeat(false).catch(() => {});
  if (config.get('monitoringEnabled')) startMonitoring();
  log.info('[main] monitoring resumed by user');
}

// Called from the tray's Project submenu. Segment-boundary detection in
// activity.js's sample() picks this up within one sampling tick (≤15s).
function setCurrentProject(id, name) {
  config.set('currentProjectId', id || null);
  config.set('currentProjectName', name || null);
  log.info('[main] project set to', name || 'Unassigned');
  refreshTray();
}

// Called from the status window's memo field (blur / Enter). Segment-boundary
// detection in activity.js's sample() picks this up within one sampling tick.
function setCurrentMemo(text) {
  const trimmed = (text || '').toString().trim().slice(0, 140);
  config.set('currentMemo', trimmed || null);
  log.info('[main] memo set to', trimmed || '(cleared)');
}

// Refreshes the cached project list the tray's picker is built from.
async function syncProjects() {
  if (!config.isEnrolled()) return;
  try {
    const res = await api.fetchProjects();
    if (res?.projects) config.set('projects', res.projects);
  } catch (err) {
    log.warn('[projects] sync failed (offline?):', err.message);
  }
}

// Periodically re-fetch policy: respects admin's monitoring toggle and
// picks up interval changes without an app update.
async function syncPolicy() {
  if (!config.isEnrolled()) return;
  try {
    const res = await api.fetchPolicy();
    if (res?.unauthorized) {
      log.warn('[policy] device unauthorized (revoked?). Clearing enrollment.');
      config.clear();
      stopMonitoring();
      uploader.stop();
      refreshTray();
      showEnrollWindow();
      return;
    }
    if (res?.policy) config.set('policy', res.policy);
    config.set('monitoringEnabled', Boolean(res?.monitoringEnabled));
    updater.checkNow(res?.forceUpdateAt);
    syncProjects();

    if (res?.monitoringEnabled && !userPaused) startMonitoring();
    else stopMonitoring();

    // Report our actual paused state on every cycle (including right at boot).
    // userPaused only lives in memory, so a restart after a pause (e.g. the
    // machine was shut down without resuming first) would otherwise leave the
    // backend's last heartbeat — and thus the dashboard — stuck showing
    // "Paused" forever even though monitoring has resumed here.
    api.heartbeat(userPaused).catch(() => {});
  } catch (err) {
    log.warn('[policy] sync failed (offline?):', err.message);
    // Stay in last known state; uploader keeps buffering.
  }
  refreshTray();
}

function startPolicyLoop() {
  if (policyTimer) return;
  syncPolicy();
  policyTimer = setInterval(syncPolicy, 60 * 1000); // every minute
}

// ── Auto-launch on login ─────────────────────────────────────
function configureAutoLaunch() {
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
    args: ['--hidden'],
  });
}

// ── IPC for enrollment ───────────────────────────────────────
ipcMain.handle('get-server-url', () => config.get('serverUrl'));

ipcMain.handle('get-status', async () => {
  const enrolled = config.isEnrolled();
  const statsData = enrolled ? await stats.fetchToday() : null;
  const last = scheduler.getLastCapture();

  return {
    enrolled,
    version: api.AGENT_VERSION,
    monitoringActive,
    userPaused,
    monitoringEnabled: Boolean(config.get('monitoringEnabled')),
    projects: config.get('projects') || [],
    currentProjectId: config.get('currentProjectId'),
    currentProjectName: config.get('currentProjectName'),
    currentMemo: config.get('currentMemo'),
    stats: statsData,
    lastScreenshot: last
      ? {
          dataUrl: `data:image/jpeg;base64,${last.buffer.toString('base64')}`,
          capturedAt: last.capturedAt,
          width: last.width,
          height: last.height,
        }
      : null,
  };
});

ipcMain.handle('pause-monitoring', () => {
  pauseByUser();
  return { ok: true };
});

ipcMain.handle('resume-monitoring', () => {
  resumeByUser();
  return { ok: true };
});

ipcMain.handle('set-project', (_evt, { id, name } = {}) => {
  setCurrentProject(id || null, name || null);
  return { ok: true };
});

ipcMain.handle('set-memo', (_evt, text) => {
  setCurrentMemo(text);
  return { ok: true };
});

ipcMain.handle('enroll', async (_evt, { serverUrl, code }) => {
  try {
    config.set('serverUrl', serverUrl);
    const hostname = os.hostname();
    const result = await api.enroll(code, hostname, platformKey());
    config.setAll({
      deviceToken: result.deviceToken,
      deviceId: result.deviceId,
      userId: result.userId,
      policy: result.policy || config.get('policy'),
      monitoringEnabled: true,
    });
    log.info('[enroll] success, device', result.deviceId);

    // Begin monitoring immediately
    await ensureScreenPermission();
    uploader.start();
    startPolicyLoop();

    if (enrollWindow) {
      setTimeout(() => enrollWindow && enrollWindow.close(), 1200);
    }
    return { ok: true };
  } catch (err) {
    log.error('[enroll] failed:', err.message);
    return { ok: false, error: err.message };
  }
});

function quitApp() {
  log.info('[main] quitting');
  if (userPaused) flushPauseEvent();
  stopMonitoring();
  uploader.stop();
  app.quit();
}

// ── Boot ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  queue.init();
  createTray();
  updater.init();
  configureAutoLaunch();

  if (config.isEnrolled()) {
    await ensureScreenPermission();
    uploader.start();
    startPolicyLoop();
  } else {
    showEnrollWindow();
  }
});

// Keep running when all windows are closed (tray app)
app.on('window-all-closed', (e) => {
  e.preventDefault?.();
});

process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException:', err);
});
