'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal, audited surface exposed to the enrollment renderer.
contextBridge.exposeInMainWorld('teamlens', {
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  enroll: (payload) => ipcRenderer.invoke('enroll', payload),
  getStatus: () => ipcRenderer.invoke('get-status'),
  pauseMonitoring: () => ipcRenderer.invoke('pause-monitoring'),
  resumeMonitoring: () => ipcRenderer.invoke('resume-monitoring'),
});
