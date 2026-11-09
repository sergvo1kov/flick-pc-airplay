'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('flick', {
  init: () => ipcRenderer.invoke('get-init'),
  command: (name) => ipcRenderer.invoke('command', name),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  restartEngine: () => ipcRenderer.invoke('restart-engine'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdate: (cb) => on('update', cb),
  openFull: () => ipcRenderer.send('open-full'),
  closeFull: () => ipcRenderer.send('close-full'),
  openSettings: () => ipcRenderer.send('open-settings'),
  hideMini: () => ipcRenderer.send('hide-mini'),
  togglePin: () => ipcRenderer.send('toggle-pin'),
  dragStart: () => ipcRenderer.send('mini-drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('mini-drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('mini-drag-end'),
  onPinned: (cb) => on('mini-pinned', cb),
  onState: (cb) => on('state', cb),
  onCover: (cb) => on('cover', cb),
  onEngine: (cb) => on('engine', cb),
  onRemote: (cb) => on('remote', cb),
  onRemoteError: (cb) => on('remote-error', cb),
  onDisplaysChanged: (cb) => on('displays-changed', cb),
});
