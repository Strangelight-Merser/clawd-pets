'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const collector = require('./collector');
const usageApi = require('./usage-api');
const store = require('./store');

let win, tray;
const prevStates = new Map();
let firstTick = true;
let windowMin = 120;
let intervalMs = 3000;
let timer = null;
let liveUsage = false;   // 实时用量(联网+读钥匙串)默认关：clone 的陌生用户首启不应被静默联网/弹钥匙串；托盘可一键开，开关持久化
let quota = null;        // 最近一次 /api/oauth/usage 结果
let usageTimer = null;
let notifyEnabled = false;  // 系统通知默认关：与 Claude 桌面端重复；桌宠本身(常驻气泡+情绪)才是主要状态面
let motionOn = true;        // 动效（呼吸/眨眼/反应/视线）总开关，托盘可关

let petPx = 120;            // 桌宠像素尺寸（托盘可调 小/中/大）
const MARGIN = 14;
function SZ(mode) {          // 窗口三档尺寸随桌宠大小缩放
  if (mode === 'expanded') return { w: 400, h: 600 };
  if (mode === 'bubble') return { w: Math.max(330, petPx + 210), h: petPx + 118 };
  return { w: petPx + 30, h: petPx + 30 };   // collapsed
}

// 1x1 透明 PNG —— 托盘用 setTitle(emoji) 表达状态，图标只需占位
const TRAY_IMG = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
);

function place(size) {
  if (!win) return;
  const wa = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: wa.x + wa.width - size.w - MARGIN,
    y: wa.y + wa.height - size.h - MARGIN,
    width: size.w, height: size.h,
  });
}
function onAnyDisplay(x, y, w, h) {   // 矩形是否与任一显示器工作区相交(防还原到已拔掉的屏幕外)
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    if (x + w > a.x + 8 && x < a.x + a.width - 8 && y + h > a.y + 8 && y < a.y + a.height - 8) return true;
  }
  return false;
}
function restorePlace() {   // 还原用户上次拖到的位置(按右下角锚点，与 resize 的右下角保持一致)；无记录/不可见则默认右下角
  const sz = SZ('collapsed');
  const a = store.get('anchorBR', null);
  if (a) {
    const x = Math.round(a.right - sz.w), y = Math.round(a.bottom - sz.h);
    if (onAnyDisplay(x, y, sz.w, sz.h)) { win.setBounds({ x, y, width: sz.w, height: sz.h }); return; }
  }
  place(sz);
}
function saveAnchor() { if (win) { const b = win.getBounds(); store.set('anchorBR', { right: b.x + b.width, bottom: b.y + b.height }); } }
function placeByAnchor(w, h) {   // 按当前右下角锚点重排到 w×h，并钳进所在屏工作区（resize 与 resize-bubble 共用）
  if (!win) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.max(wa.x, Math.min(Math.round(b.x + b.width - w), wa.x + wa.width - w));
  const y = Math.max(wa.y, Math.min(Math.round(b.y + b.height - h), wa.y + wa.height - h));
  win.setBounds({ x, y, width: w, height: h });
  saveAnchor();
}
function setWindowMin(min) { if ([30, 120, 1440].includes(min)) { windowMin = min; store.set('windowMin', min); restartTimer(); } }

function createWindow() {
  win = new BrowserWindow({
    width: SZ('collapsed').w, height: SZ('collapsed').h,
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  restorePlace();
  win.setIgnoreMouseEvents(true, { forward: true });   // 默认穿透：不挡桌宠下方应用的点击/hover；renderer 在指针落到实体像素时关掉
  win.webContents.on('render-process-gone', () => { try { win && !win.isDestroyed() && win.reload(); } catch {} });   // 渲染进程崩了→自动重载，避免桌宠永久僵死
  win.webContents.on('unresponsive', () => { try { win && !win.isDestroyed() && win.reload(); } catch {} });
}

function moodGlyph(m) { return m === 'error' ? '🔴' : m === 'needs' ? '🟡' : m === 'working' ? '🟢' : '😴'; }
function notify(title, body) { try { new Notification({ title, body, silent: false }).show(); } catch {} }

function tick() {
  let data;
  try { data = collector.collect({ windowMin }); } catch (e) { console.error('[collect]', e); return; }
  data.quota = liveUsage ? quota : null;
  if (win && !win.isDestroyed()) win.webContents.send('update', data);
  if (tray) {
    tray.setTitle(` ${moodGlyph(data.mascot)}${data.needsCount ? data.needsCount : ''}`);
    tray.setToolTip(`process-seeing · ${data.rows.length} 个会话 · ${data.needsCount} 需要你`);
  }
  // 状态跃迁 → 通知（首轮只建立基线，不打扰）
  const seen = new Set();
  for (const r of data.rows) {
    seen.add(r.key);
    const prev = prevStates.get(r.key);
    if (notifyEnabled && !firstTick) {   // 默认关；桌宠气泡是主要提醒，通知仅作可选补充
      const where = r.projectShort && r.projectShort !== r.title ? ` · ${r.projectShort}` : '';
      if ((prev === 'RUNNING' || prev === 'WAIT') && r.state.key === 'AWAITING') notify('✋ 需要你', r.title + where);
      else if ((prev === 'RUNNING' || prev === 'WAIT') && r.state.key === 'ERROR') notify('🔴 出错', r.title + where);
      else if (prev !== 'RATE' && r.state.key === 'RATE') notify('⏳ 触发限流', r.title + where);
    }
    prevStates.set(r.key, r.state.key);
  }
  for (const k of [...prevStates.keys()]) if (!seen.has(k)) prevStates.delete(k);
  firstTick = false;
}

function restartTimer() { if (timer) clearInterval(timer); tick(); timer = setInterval(tick, intervalMs); }   // 心跳：兜底刷新 idleSec/睡眠/陈旧剪裁

// fs.watch 事件驱动：transcript/会话文件一变就(防抖)重算，思考链/状态近实时反映，不等心跳
let watchers = [], watchTimer = null;
function scheduleTick() { clearTimeout(watchTimer); watchTimer = setTimeout(tick, 250); }   // 合并写入风暴：最后一次变更 250ms 后才 collect
function startWatch() {
  stopWatch();
  for (const dir of collector.WATCH_DIRS) {
    try {
      const w = fs.watch(dir, { recursive: true }, (ev, file) => {
        if (file && String(file).includes('subagents')) return;   // 忽略子代理 transcript 噪声(我跑工作流时的写入)
        scheduleTick();
      });
      w.on('error', () => {});   // 目录被删/重建等：静默忽略
      watchers.push(w);
    } catch {}   // 目录不存在等：跳过
  }
}
function stopWatch() { clearTimeout(watchTimer); for (const w of watchers) { try { w.close(); } catch {} } watchers = []; }

const USAGE_BASE = 180000, USAGE_MAX = 900000;   // 正常 180s(带正确 UA 的公认安全间隔)；429 指数退避封顶 15min
let usageFails = 0, usageGen = 0;   // generation 令牌：保证任意时刻只有一条活跃轮询链，关闭/切换后 in-flight 结果作废
function scheduleUsage(ms) { const gen = usageGen; if (usageTimer) clearTimeout(usageTimer); usageTimer = setTimeout(() => runUsage(gen), ms); }
async function runUsage(gen) {
  if (!liveUsage || gen !== usageGen) return;
  const r = await usageApi.fetchUsage();   // token 只在该函数内用于请求头，不落盘/不打印
  if (!liveUsage || gen !== usageGen) return;   // in-flight 期间被关闭/重启 → 丢弃陈旧结果，不再续排(防双轮询)
  quota = r;
  tick();
  let next = USAGE_BASE;
  if (r && r.reason === 'rate-limited') {            // 429：退避，期间不发请求，避免继续污染 token
    usageFails++;
    next = r.retryAfter ? Math.min(Math.max(r.retryAfter * 1000, USAGE_BASE), USAGE_MAX)
                        : Math.min(USAGE_BASE * Math.pow(2, usageFails - 1), USAGE_MAX);
  } else if (r && r.reason === 'unauthorized') { next = USAGE_MAX; }   // token 过期：15min 后再试(等 Claude 自己刷新)
  else if (r && !r.ok && (r.reason === 'network' || r.reason === 'timeout' || /^http-5/.test(r.reason || ''))) { next = 30000; }
  else { usageFails = 0; }                            // 成功
  console.log('[usage]', r && r.ok ? 'ok' : (r && r.reason), '→ next', Math.round(next / 1000) + 's');  // 仅状态，不打印 token/额度
  scheduleUsage(next);
}
function startUsage() { usageFails = 0; const gen = ++usageGen; if (usageTimer) clearTimeout(usageTimer); runUsage(gen); }
function stopUsage() { ++usageGen; if (usageTimer) clearTimeout(usageTimer); usageTimer = null; quota = null; }
function setPet(px) { petPx = Math.max(80, Math.min(220, Math.round(px))); store.set('petPx', petPx); if (win) win.webContents.send('set-pet', petPx); }  // 渲染端收到后改 --pet 并请求重排；夹在 80–220

function buildTray() {
  tray = new Tray(TRAY_IMG);
  tray.setTitle(' 😴');
  tray.on('click', () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => win && (win.isVisible() ? win.hide() : win.show()) },
    { type: 'separator' },
    { label: '窗口范围', submenu: [
      { label: '最近 30 分钟', type: 'radio', checked: windowMin === 30, click: () => setWindowMin(30) },
      { label: '最近 2 小时', type: 'radio', checked: windowMin === 120, click: () => setWindowMin(120) },
      { label: '最近 24 小时', type: 'radio', checked: windowMin === 1440, click: () => setWindowMin(1440) },
    ] },
    { label: '刷新频率', submenu: [
      { label: '快 (1.5s)', type: 'radio', checked: intervalMs === 1500, click: () => { intervalMs = 1500; store.set('intervalMs', 1500); restartTimer(); } },
      { label: '正常 (3s)', type: 'radio', checked: intervalMs === 3000, click: () => { intervalMs = 3000; store.set('intervalMs', 3000); restartTimer(); } },
      { label: '省电 (10s)', type: 'radio', checked: intervalMs === 10000, click: () => { intervalMs = 10000; store.set('intervalMs', 10000); restartTimer(); } },
    ] },
    { label: '桌宠大小', submenu: [
      { label: '小', type: 'radio', checked: petPx === 100, click: () => setPet(100) },
      { label: '中', type: 'radio', checked: petPx === 120, click: () => setPet(120) },
      { label: '大', type: 'radio', checked: petPx === 156, click: () => setPet(156) },
    ] },
    { type: 'separator' },
    { label: '实时用量 (联网·首次读钥匙串需授权)', type: 'checkbox', checked: liveUsage,
      click: (mi) => { liveUsage = mi.checked; store.set('liveUsage', liveUsage); liveUsage ? startUsage() : stopUsage(); tick(); } },
    { label: '需要你/出错时弹系统通知 (默认关·避免与 Claude 重复)', type: 'checkbox', checked: notifyEnabled,
      click: (mi) => { notifyEnabled = mi.checked; store.set('notifyEnabled', notifyEnabled); } },
    { label: '动效（呼吸/眨眼/视线/反应）', type: 'checkbox', checked: motionOn,
      click: (mi) => { motionOn = mi.checked; store.set('motionOn', motionOn); if (win) win.webContents.send('set-motion', motionOn); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

let lastCur = { x: 0, y: 0 };
function cursorTick() {   // 视线跟随 + 用户活动检测（鼠标移动）
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const b = win.getBounds();
  const ax = b.x + b.width - petPx * 0.57, ay = b.y + b.height - petPx * 0.84;   // 眼睛近似屏幕坐标(随大小)
  let c; try { c = screen.getCursorScreenPoint(); } catch { return; }
  const moved = Math.abs(c.x - lastCur.x) + Math.abs(c.y - lastCur.y) > 2;
  lastCur = c;
  const dx = c.x - ax, dy = c.y - ay, dist = Math.hypot(dx, dy) || 1, k = Math.min(1, dist / 300);
  const inBounds = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  win.webContents.send('cursor', { x: (dx / dist) * k, y: (dy / dist) * k, moved, cx: c.x - b.x, cy: c.y - b.y, inBounds });  // cx/cy=窗口内客户端坐标, inBounds=光标是否在窗口内(穿透兜底用)
}

// 单实例：第二个实例直接退，并聚焦已有实例，避免双桌宠双轮询
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });

app.whenReady().then(() => {
  if (!isPrimary) return;
  store.init(app.getPath('userData'));   // 读回上次设置(窗口范围/刷新率/实时用量/通知/动效/桌宠大小/位置)
  // 读盘加白名单/范围校验，防 settings.json 被手改/损坏成 0/负值/NaN 冻死应用
  const sw = store.get('windowMin'); if ([30, 120, 1440].includes(sw)) windowMin = sw;
  const si = store.get('intervalMs'); if ([1500, 3000, 10000].includes(si)) intervalMs = si;
  const sp = store.get('petPx'); if (typeof sp === 'number' && sp >= 80 && sp <= 220) petPx = sp;
  liveUsage = store.get('liveUsage', liveUsage) === true;
  notifyEnabled = store.get('notifyEnabled', notifyEnabled) === true;
  motionOn = store.get('motionOn', motionOn) !== false;
  createWindow();
  buildTray();
  restartTimer();
  startWatch();
  if (liveUsage) startUsage();
  setInterval(cursorTick, 150);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
});

ipcMain.on('resize', (e, mode) => {
  if (!win || mode === 'bubble') return;              // bubble 尺寸由 resize-bubble 独占(渲染端量真实高)，不走固定 SZ
  const size = SZ(mode);                              // collapsed/expanded：保持右下角不动 + 钳进工作区
  placeByAnchor(size.w, size.h);
});
ipcMain.on('resize-bubble', (e, h) => {               // 状态行栈：渲染端量到的真实高度，按右下角锚点调窗(桌宠不动、栈往上长)
  if (!win) return;
  const w = Math.max(330, petPx + 210);
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const H = Math.max(petPx + 30, Math.min(Math.round(h), wa.height - 2 * MARGIN));
  const cur = win.getBounds();
  if (cur.width === w && cur.height === H) return;    // 同尺寸跳过，避免无谓 setBounds 抖动
  placeByAnchor(w, H);
});
ipcMain.handle('get-bounds', () => (win ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 }));
ipcMain.on('move-window', (e, x, y) => { if (win) { win.setPosition(Math.round(x), Math.round(y)); saveAnchor(); } });
ipcMain.on('set-ignore', (e, ig) => { if (win) win.setIgnoreMouseEvents(!!ig, { forward: true }); });
ipcMain.on('pet-size', (e, px) => setPet(px));   // 拖动手柄：连续设置桌宠大小(含持久化+回传 set-pet)
ipcMain.on('open-path', (e, p) => { if (p) shell.openPath(p).catch(() => {}); });
ipcMain.on('set-window', (e, min) => setWindowMin(min));
ipcMain.on('quit', () => app.quit());
app.on('before-quit', () => { store.flush(); stopWatch(); });   // 退出前同步刷盘 + 关文件监听
app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
app.on('activate', () => { if (win) win.show(); });
