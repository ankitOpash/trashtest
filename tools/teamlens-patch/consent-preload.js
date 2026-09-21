'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consent', {
  onData: (cb) => ipcRenderer.on('consent-data', (_e, data) => cb(data)),
  respond: (payload) => ipcRenderer.invoke('consent-response', payload),
});
