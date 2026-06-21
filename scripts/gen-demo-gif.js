'use strict';
/*
 * 生成 README 动图 assets/demo.gif：Electron 加载 renderer(mock 数据)，连续截帧捕捉桌宠的"活着"
 * （呼吸、运行中转圈、思考链实时更新），再用 ffmpeg 合成高质量 GIF。
 * 前置：静态服务器（npm 的 pet-preview，或 python3 -m http.server 4178 --directory src/renderer）。
 * 跑：DEMO_URL=http://localhost:4178/ npx electron scripts/gen-demo-gif.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const URL = process.env.DEMO_URL || 'http://localhost:4178/';
const OUT = path.join(__dirname, '..', 'assets', 'demo.gif');
const W = +(process.env.DEMO_W || 520), H = +(process.env.DEMO_H || 470);
const OUT_W = +(process.env.OUT_W || 520);
const FPS = +(process.env.FPS || 12);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 截帧期间注入的"剧本"：让状态栈实时变化（演示思考链更新 / 任务完成进栈）
async function inject(win, js) { try { await win.webContents.executeJavaScript(js); } catch (e) { /* best-effort */ } }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, backgroundColor: '#f4f4f5', webPreferences: { offscreen: false } });
  await win.loadURL(URL);
  await sleep(1400);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-'));
  let n = 0;
  const grab = async (count, delay) => { for (let i = 0; i < count; i++) { fs.writeFileSync(path.join(tmp, `f${String(n++).padStart(3, '0')}.png`), (await win.capturePage()).toPNG()); await sleep(delay); } };

  // 1) 初始栈（呼吸 + 运行中转圈 + 三气泡）
  await grab(16, 70);
  // 2) 思考链实时更新（运行中任务换一句叙述 + 推进 todo）——展示"实时状态栈"
  await inject(win, `(function(){ if(typeof last!=='undefined'&&last.rows&&last.rows[1]){ last.rows[1].think='正在验证打包产物：asar 内图标与源一致'; last.rows[1].activity='Verify packaged icon matches source'; renderPet(last); detectTransitions(last); updateMode(last);} })()`);
  await grab(14, 70);
  // 3) 运行中任务完成 → 变绿"完成"进栈
  await inject(win, `(function(){ if(typeof last!=='undefined'&&last.rows&&last.rows[1]){ last.rows[1].state={key:'AWAITING',label:'等输入'}; last.rows[1].think=null; last.rows[1].attention=true; last.rows[1].live=false; renderPet(last); detectTransitions(last); updateMode(last);} })()`);
  await grab(16, 70);

  win.destroy();

  const pal = path.join(tmp, 'pal.png');
  const vf = `scale=${OUT_W}:-1:flags=lanczos`;
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%03d.png'), '-vf', `${vf},palettegen=stats_mode=diff`, pal], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%03d.png'), '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', OUT], { stdio: 'ignore' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ wrote', OUT, fs.statSync(OUT).size, 'bytes,', n, 'frames @', FPS, 'fps');
  app.quit();
});
