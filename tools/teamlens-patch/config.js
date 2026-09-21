'use strict';
const Store = require('electron-store');

// Persists enrollment state + cached policy across restarts.
// Stored under the OS user-data dir (encrypted-at-rest is the OS's job;
// the device token here is a bearer credential, treat the machine as trusted).
const store = new Store({
  name: 'teamlens-agent',
  defaults: {
    serverUrl: 'https://monitor.opashsoftware.com',
    deviceToken: null,
    deviceId: null,
    userId: null,
    policy: {
      minIntervalSec: 300,
      maxIntervalSec: 600,
      idleThresholdSec: 300,
    },
    monitoringEnabled: true,
    // Apps whose screenshots are blurred (matched case-insensitively
    // against any visible window owner name, across all monitors).
    privateApps: ['WhatsApp'],
    // Client/project the member has picked from the tray, tagged onto
    // activity segments until they switch. Cached list is refreshed
    // alongside the policy poll.
    currentProjectId: null,
    currentProjectName: null,
    projects: [],
    // Free-text note on what the member is currently working on, tagged onto
    // activity segments the same way currentProjectId is.
    currentMemo: null,
    // Local privacy patch toggle (tray checkbox). When true:
    //   - screenshot consent popup before upload
    //   - idle time never reported (always active)
    // When false: stock silent upload + normal idle detection.
    ssConsentEnabled: true,
  },
});

module.exports = {
  get: (key) => store.get(key),
  set: (key, val) => store.set(key, val),
  setAll: (obj) => {
    for (const [k, v] of Object.entries(obj)) store.set(k, v);
  },
  isEnrolled: () => Boolean(store.get('deviceToken')),
  clear: () => {
    store.set('deviceToken', null);
    store.set('deviceId', null);
    store.set('userId', null);
  },
  store,
};
