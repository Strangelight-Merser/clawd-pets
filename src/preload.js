'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onUpdate: (cb) => ipcRenderer.on('update', (_e, data) => cb(data)),
  resize: (mode) => ipcRenderer.send('resize', mode),       // 'collapsed' | 'expanded'
  openPath: (p) => ipcRenderer.send('open-path', p),
  setWindow: (min) => ipcRenderer.send('set-window', min),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  moveWindow: (x, y) => ipcRenderer.send('move-window', x, y),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onMotion: (cb) => ipcRenderer.on('set-motion', (_e, on) => cb(on)),
  onPet: (cb) => ipcRenderer.on('set-pet', (_e, px) => cb(px)),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),   // 鼠标穿透开关
  setPet: (px) => ipcRenderer.send('pet-size', px),                // 拖动手柄连续调桌宠大小
  resizeBubble: (h) => ipcRenderer.send('resize-bubble', h),       // 状态行栈动态高度
  quit: () => ipcRenderer.send('quit'),
});
