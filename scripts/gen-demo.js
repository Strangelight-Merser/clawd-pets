'use strict';
/*
 * 生成 README 演示图 assets/demo.png：用 Electron 加载 renderer(走 http preview 的 mock 数据)截图。
 * 前置：先起静态预览服务器（见 .claude/launch.json 的 pet-preview，或 `python3 -m http.server 4178 --directory src/renderer`）。
 * 跑：DEMO_URL=http://localhost:4178/ npx electron scripts/gen-demo.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const URL = process.env.DEMO_URL || 'http://localhost:4178/';
const OUT = path.join(__dirname, '..', 'assets', 'demo.png');
const W = +(process.env.DEMO_W || 520), H = +(process.env.DEMO_H || 470);   // 紧凑构图：桌宠锚右下，气泡上叠，少留空白

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false,
    backgroundColor: '#f4f4f5',                 // 中性浅底，模拟桌面、突出玻璃气泡
    webPreferences: { offscreen: false },
  });
  await win.loadURL(URL);
  await new Promise(r => setTimeout(r, 1400));    // 等 mock 渲染 + 呼吸/进场动画稳定
  const img = await win.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('✓ wrote', OUT, fs.statSync(OUT).size, 'bytes', img.getSize());
  win.destroy();
  app.quit();
});
