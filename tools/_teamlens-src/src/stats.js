'use strict';
const log = require('electron-log');
const api = require('./api');

// Fetches today's stats fresh on demand — the status window is only open
// briefly, so there's no need for a background poller.
async function fetchToday() {
  try {
    return await api.fetchMyStats();
  } catch (err) {
    log.warn('[stats] fetch failed:', err.message);
    return null;
  }
}

module.exports = { fetchToday };
