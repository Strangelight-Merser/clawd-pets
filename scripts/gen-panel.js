'use strict';
/*
 * 生成 README 的展开面板截图 assets/panel.png：Electron 加载 renderer(mock)，打开面板，按 #panel
 * 的实际 bounding rect 精确裁剪截图（用 live-usage mock，展示配额条 + 任务列表的"深度"）。
 * 前置：静态服务器(pet-preview / python3 -m http.server 4178 --directory src/renderer)。
 * 跑：DEMO_URL=http://localhost:4178/ npx electron scripts/gen-panel.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const URL = process.env.DEMO_URL || 'http://localhost:4178/';
const OUT = path.join(__dirname, '..', 'assets', 'panel.png');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 840, show: false, backgroundColor: '#f4f4f5', webPreferences: { offscreen: false } });
  await win.loadURL(URL);
  await sleep(1300);
  await win.webContents.executeJavaScript(`(function(){ if(typeof setOpen==='function') setOpen(true); if(typeof renderPanel==='function') renderPanel(last); })()`);
  await sleep(600);
  const rect = JSON.parse(await win.webContents.executeJavaScript(
    `(function(){var r=document.getElementById('panel').getBoundingClientRect();return JSON.stringify({x:Math.max(0,Math.floor(r.x-8)),y:Math.max(0,Math.floor(r.y-8)),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16)});})()`));
  const img = await win.capturePage(rect);
  fs.writeFileSync(OUT, img.toPNG());
  console.log('✓ wrote', OUT, fs.statSync(OUT).size, 'bytes', JSON.stringify(rect));
  win.destroy();
  app.quit();
});
