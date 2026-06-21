'use strict';
const $ = (s) => document.querySelector(s);
const app = $('#app');
let open = false;
let last = null;

const STATE_COLOR = { RUNNING: '#3ddc97', WAIT: '#f5c451', AWAITING: '#6aa1ff', IDLE: '#7d8597', ERROR: '#fb6f86', RATE: '#c08bff' };   // 与 CSS --ok/--warn/--info/--neutral/--err/--rate 同步

function fmtN(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); }
function fmtCost(c, real) { return (real ? '' : '~') + '$' + ((c || 0) < 1 ? (c || 0).toFixed(2) : (c || 0).toFixed(1)); }
function fmtIdle(s) { s = Math.max(0, s | 0); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'; }
function clock(epochSec) { try { return new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '?'; } }

function setOpen(v) {
  open = v;
  app.classList.toggle('open', open);
  if (open && last) renderPanel(last);
  updateMode(last);
}

// ---- 状态气泡 + 情绪反应（对标 Codex Pets）----
let currentMode = 'collapsed';
// 鼠标穿透 + 拖拽互斥 + 配额播报状态（模块级，供 mousemove / onCursor / 拖拽 共用）
let ignoring = true, petDragging = false, petPxLocal = 120;
let stackMinimized = false, minimizedSig = null, hasActive = false;   // 气泡最小化：状态不变时保持收起，有实质变化自动恢复；hasActive=当前有可显示的任务行
function setIgnore(ig) { if (window.api && window.api.setIgnore && ig !== ignoring) { ignoring = ig; window.api.setIgnore(ig); } }
function hitInteractive(x, y) { const el = document.elementFromPoint(x, y); return !!(el && el.closest('#pet, #stack, #panel')); }
const osReduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let motionOff = osReduceMotion;
let taskMood = 'idle', sleeping = false, lastActivityAt = Date.now();
function applyMood() {   // 睡眠看用户不活动；情绪看任务。任务一旦活跃就退出睡眠
  if (sleeping && taskMood !== 'idle' && taskMood !== 'done') sleeping = false;
  app.dataset.mood = sleeping ? 'sleeping' : taskMood;
}
function applyMode(mode) {
  app.dataset.mode = mode;
  if (mode === currentMode) return;
  if (currentMode === 'bubble') lastSentH = 0;        // 离开 bubble → 作废上次高度，回来必重测(修 expanded→bubble 卡矮裁顶行)
  currentMode = mode;
  if (mode !== 'bubble') window.api.resize(mode);     // collapsed/expanded 用固定 SZ；bubble 尺寸由 resizeBubble 独占(消除两次 setBounds 抖动)
}

function petAnim(frames, opts) { if (motionOff) return; const m = $('#mascot'); if (m) m.animate(frames, opts); }
function reactCelebrate() { petAnim([{ transform: 'translateY(0)' }, { transform: 'translateY(-14px)' }, { transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }], { duration: 640, easing: 'cubic-bezier(.3,1.5,.5,1)' }); }
function reactWiggle() { petAnim([{ transform: 'rotate(0)' }, { transform: 'rotate(-5deg)' }, { transform: 'rotate(4deg)' }, { transform: 'rotate(-2deg)' }, { transform: 'rotate(0)' }], { duration: 440, easing: 'ease-out' }); }

function phaseVerb(tool) {   // 工具名 → 人话阶段（i18n）
  if (!tool || tool === '-') return T.phaseDefault;
  tool = String(tool).replace(/^mcp__[a-z0-9]+__/i, '').replace(/^mcp__/i, '');   // 去掉 mcp 前缀
  const t = tool.toLowerCase();
  if (/bash|shell|command|exec|\brun\b/.test(t)) return T.phaseRun;
  if (/edit|write|create|apply|patch|str_replace|notebook/.test(t)) return T.phaseEdit;
  if (/read|grep|glob|^ls|cat|search/.test(t)) return T.phaseRead;
  if (/test|pytest|jest|vitest/.test(t)) return T.phaseTest;
  if (/web|fetch|http|browser|preview|screenshot|snapshot|navigate|click|fill/.test(t)) return T.phaseWeb;
  if (/todo|plan/.test(t)) return T.phasePlan;
  return tool;
}
function bubbleSpec(r) {
  const nm = r.title;
  switch (r.state.key) {
    case 'ERROR': return { icon: 'error', text: T.bErr(nm), cls: 'b-err', persistent: true };
    case 'RATE': return { icon: 'rate', text: T.bRate(nm), cls: 'b-err', persistent: true };
    case 'WAIT': return { icon: 'wait', text: T.bWait(nm), cls: 'b-wait', persistent: true };
    case 'AWAITING': return { icon: 'done', text: T.bDone(nm), cls: 'b-done', persistent: false, linger: 6500 };   // 完成：短驻后离栈
    case 'RUNNING': {
      const act = r.activity || (r.tool ? phaseVerb(r.tool) : null);        // 工具动作：Bash 描述 / 读取文件名 / 检索…
      const primary = r.think || act || T.think;                            // 主行=当前思考叙述(其次工具动作)
      const sub = (act && r.think) ? `${nm} · ${act}` : nm;                 // 副行=任务名(· 工具动作)
      return { icon: r.tool ? 'working' : 'thinking', text: primary, sub, cls: r.tool ? 'b-run' : 'b-think', persistent: true };   // 运行：常驻 live 行，随思考/活动原地更新
    }
  }
  return null;
}
const HEAD_ORDER = { ERROR: 6, RATE: 5, WAIT: 4, RUNNING: 3, AWAITING: 1 };
const MAX_ROWS = 5;   // 折叠态最多并排几条(贴合"跑几个显示几个")，超出才折成"还有 N 个"；窗口高度随行数增长
function speakable(r) {   // 该会话在折叠态是否"说话"：运行中始终显示(随活动原地更新)；关注族(出错/限流/等你/完成)仅新鲜时；IDLE/陈旧不显示，留面板看
  const k = r.state.key;
  if (k === 'RUNNING') return bubbleSpec(r);
  if ((k === 'ERROR' || k === 'RATE' || k === 'WAIT' || k === 'AWAITING') && r.attention) return bubbleSpec(r);
  return null;
}
function rowSig(r, spec) { return r.state.key + '|' + spec.text + '|' + (spec.sub || ''); }   // 内容指纹：state/思考/动作 变了才原地更新

// 精致 SVG 图标（替代 emoji，monochrome 跟随 currentColor）
const ICONS = {
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.3 8.6l2.9 2.9L12.7 4.8"/></svg>',
  wait: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6" stroke-linecap="round"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.4" stroke-linecap="round"/><circle cx="8" cy="11" r=".75" fill="currentColor" stroke="none"/></svg>',
  rate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M4.5 4.5l7 7" stroke-linecap="round"/></svg>',
  working: '<svg class="i-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 2.4a5.6 5.6 0 1 1-5.3 3.9"/></svg>',
  thinking: '<svg class="i-spin-slow" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="2.6" x2="8" y2="13.4"/><line x1="2.6" y1="8" x2="13.4" y2="8"/><line x1="4.3" y1="4.3" x2="11.7" y2="11.7"/><line x1="11.7" y1="4.3" x2="4.3" y2="11.7"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h3l1.4 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
};
// ---- 折叠态状态行栈：每个"在说话"的会话一行，keyed reconcile 原地增删/更新，绝不反复重弹（根治"乱跳"+ 多任务全显示）----
const stackEls = new Map();      // key -> { el }
const lingerTimers = new Map();  // key -> { id, sig }  短驻行(完成/配额)到点离栈
const dismissed = new Map();     // key -> sig  短驻行已播过的内容，不再 re-add（含 '__quota__'）
let lastSentH = 0, pendingMeasure = false;

function renderRowEl(el, spec) {
  el.className = 'bubble ' + (spec.cls || '');
  el.innerHTML = `<span class="b-icon">${ICONS[spec.icon] || ''}</span>`
    + `<span class="b-body"><span class="b-text">${esc(spec.text)}</span>`
    + (spec.sub ? `<span class="b-sub">${esc(spec.sub)}</span>` : '')
    + `</span>`;
}
function enterRow(el) { if (!motionOff) el.animate([{ transform: 'translateY(10px) scale(.96)', opacity: 0, filter: 'blur(2px)' }, { transform: 'none', opacity: 1, filter: 'blur(0)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }); }
function clearLinger(key) { const t = lingerTimers.get(key); if (t) { clearTimeout(t.id); lingerTimers.delete(key); } }
function removeRow(key) {
  clearLinger(key);
  const rec = stackEls.get(key); if (!rec) return;
  stackEls.delete(key);
  const finish = () => { rec.el.remove(); measureAndResize(); };
  if (motionOff) return finish();
  rec.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px) scale(.97)' }], { duration: 180, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = finish;
}
function armLinger(key, sig, ms) {   // 短驻行(完成/配额)计时离栈；同内容已在计时则不重置
  const t = lingerTimers.get(key);
  if (t && t.sig === sig) return;
  if (t) clearTimeout(t.id);
  lingerTimers.set(key, { sig, id: setTimeout(() => { lingerTimers.delete(key); dismissed.set(key, sig); removeRow(key); }, ms) });
}
function isShort(spec) { return !spec.persistent; }   // persistent:false(+linger)=短驻(完成/配额)，到点离栈；true=live(运行/出错/等你)常驻

function computeDesired(d) {   // 算出当前该显示哪些行（每个 speakable 会话一行 + 配额合成行 + 超额折叠行）
  if (!d) return [];
  const cand = [];
  for (const r of d.rows) {
    if (r.state.key === 'RUNNING' || r.state.key === 'WAIT') dismissed.delete(r.key);   // 任务重新活跃 → 作废旧"完成"记录，下次完成会重新播
    const spec = speakable(r); if (!spec) continue;
    const sig = rowSig(r, spec);
    if (isShort(spec) && dismissed.get(r.key) === sig) continue;   // 完成行已播过同内容 → 不再 re-add
    cand.push({ key: r.key, weight: HEAD_ORDER[r.state.key] || 0, spec, sig });
  }
  const qa = quotaAlert(d);
  if (qa) {
    const sig = 'quota:' + qa.label;
    if (dismissed.get('__quota__') !== sig) cand.push({ key: '__quota__', weight: 5.5, spec: { icon: 'rate', text: quotaText(qa), cls: 'b-err', persistent: false, linger: 8000 }, sig });
  } else dismissed.delete('__quota__');
  const liveKeys = new Set(d.rows.map((r) => r.key)); liveKeys.add('__quota__');   // 任务离开后清其 dismissed，允许重现时重播
  for (const k of [...dismissed.keys()]) if (!liveKeys.has(k)) dismissed.delete(k);
  cand.sort((a, b) => b.weight - a.weight);   // 告警置顶；同权重保 collector 原序(V8 stable sort)
  if (cand.length > MAX_ROWS) {
    const head = cand.slice(0, MAX_ROWS - 1), dropped = cand.slice(MAX_ROWS - 1);
    for (const x of dropped) if (isShort(x.spec)) dismissed.set(x.key, x.sig);   // 被挤进折叠的短驻行视作已播，避免腾位后重弹
    head.push({ key: '__more__', weight: -1, spec: { icon: 'folder', text: T.more(dropped.length), cls: 'b-more', persistent: true }, sig: '__more__:' + dropped.length });
    return head;
  }
  return cand;
}
function reconcileStack(desired) {
  const stack = $('#stack');
  const want = new Set(desired.map((x) => x.key));
  for (const key of [...stackEls.keys()]) if (!want.has(key)) removeRow(key);   // 离场
  for (const x of desired) {
    let rec = stackEls.get(x.key);
    if (!rec) { const el = document.createElement('div'); renderRowEl(el, x.spec); el.dataset.sig = x.sig; stackEls.set(x.key, rec = { el }); stack.appendChild(el); enterRow(el); }   // 入场
    else { if (rec.el.dataset.sig !== x.sig) { renderRowEl(rec.el, x.spec); rec.el.dataset.sig = x.sig; } stack.appendChild(rec.el); }   // 内容变才原地换；appendChild 维持 desired 顺序，无 enter 重播
    if (isShort(x.spec)) armLinger(x.key, x.sig, x.spec.linger || 6000); else clearLinger(x.key);
  }
}
function measureAndResize() {   // 渲染端量内容真实高度 → main 按右下角锚点调窗(桌宠不动、栈往上长)；同步量(offsetHeight 强制布局)
  if (currentMode !== 'bubble') return;                 // 仅 bubble 模式调高：防 collapsed 后离场 onfinish 倒灌 bubble 尺寸
  if (petDragging) { pendingMeasure = true; return; }   // 拖拽中不调窗，避免与 setPosition 打架
  const pet = $('#pet'), stack = $('#stack'); if (!pet) return;
  const sh = stack ? stack.offsetHeight : 0;            // offsetHeight 即自然内容高(display:none 时为 0)，不受窗口裁切影响
  const h = pet.offsetHeight + (sh ? sh + 8 : 0) + 14 + 2;   // 桌宠 + 栈 + gap(8) + padding(14) + 2 安全余量(防边缘裁)
  if (Math.abs(h - lastSentH) > 3 && window.api && window.api.resizeBubble) { lastSentH = h; window.api.resizeBubble(h); }
}
function collapseStack() { for (const k of [...stackEls.keys()]) removeRow(k); lastSentH = 0; applyMode('collapsed'); }
function coarseSig(desired) { return desired.map(x => x.key + ':' + (x.spec.cls === 'b-think' ? 'b-run' : (x.spec.cls || ''))).join('|'); }   // 粗指纹：只看任务集合+状态族(忽略思考/动作文案 churn)
function updateMode(d) {
  if (open) { applyMode('expanded'); return; }
  const desired = computeDesired(d);
  hasActive = desired.length > 0;
  if (stackMinimized) {
    const sig = coarseSig(desired);
    if (minimizedSig === null) minimizedSig = sig;          // 刚最小化：记录当前状态指纹
    if (sig === minimizedSig) { collapseStack(); return; }  // 状态没变 → 保持只看 Clawd
    stackMinimized = false;                                 // 状态有实质变化(新任务/出错/完成…) → 自动恢复
  }
  if (!desired.length) { collapseStack(); return; }
  applyMode('bubble');
  reconcileStack(desired);
  measureAndResize();
}

// 真·状态跃迁 → 一次性反应（完成=庆祝；转入需要你/出错=晃动）。首帧只建基线不触发。
const prevRowStates = new Map();
function detectTransitions(d) {
  let celebrate = false, alarm = false; const seen = new Set();
  for (const r of d.rows) {
    seen.add(r.key);
    const prev = prevRowStates.get(r.key), k = r.state.key;
    if (prev && prev !== k) {
      if (k === 'AWAITING' && (prev === 'RUNNING' || prev === 'WAIT')) celebrate = true;
      // 跨入告警族(出错/等你/限流)即晃动，不再硬绑 prev==='RUNNING'——T0.2 让 ①② 现在也可能从 AWAITING/IDLE 跨入 ERROR
      else if ((k === 'ERROR' || k === 'WAIT' || k === 'RATE') && !(prev === 'ERROR' || prev === 'WAIT' || prev === 'RATE')) alarm = true;
    }
    prevRowStates.set(r.key, k);
  }
  for (const key of [...prevRowStates.keys()]) if (!seen.has(key)) prevRowStates.delete(key);
  if (celebrate) reactCelebrate(); else if (alarm) reactWiggle();
}

$('#collapse').addEventListener('click', () => setOpen(false));
// 点桌宠 = 开/关面板；按住拖动 = 移动窗口（区分 tap / drag）
(function () {
  const pet = $('#pet');
  pet.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    petDragging = true; setIgnore(false);              // 拖拽期间锁定接管：穿透切换让位，避免拖到透明区时窗口失焦导致拖拽卡半截
    let moved = false, b = null;
    try { b = await window.api.getBounds(); } catch {}
    const sx = e.screenX, sy = e.screenY;
    const onMove = (ev) => {
      const dx = ev.screenX - sx, dy = ev.screenY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved && b) window.api.moveWindow(b.x + dx, b.y + dy);
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      petDragging = false;
      if (pendingMeasure) { pendingMeasure = false; if (currentMode === 'bubble') measureAndResize(); }   // 拖拽期暂缓的调窗，松手补一次
      if (!moved) {                                          // 点 Clawd：面板开→关；最小化中且有任务→展开气泡(手动入口)；否则→开面板
        if (open) setOpen(false);
        else if (stackMinimized && hasActive) { stackMinimized = false; updateMode(last); }
        else setOpen(true);
      }
      setIgnore(!hitInteractive(ev.clientX, ev.clientY));   // 松手后按当前位置刷新穿透态
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();
$('#stack').addEventListener('click', () => setOpen(true));   // 点任意状态行 = 展开面板看详情
$('#stack-min').addEventListener('click', (e) => {           // 最小化：收起气泡只留 Clawd，状态实质变化才自动重现
  e.stopPropagation();
  stackMinimized = true; minimizedSig = null;               // null=下次 updateMode 捕获当前状态指纹
  updateMode(last);
});
// 随机眨眼（除睡着外所有情绪；间隔随机，偶尔双眨）
(function scheduleBlink() {
  const busy = ['working', 'thinking', 'needs'].includes(app.dataset.mood);
  setTimeout(() => {
    if (!motionOff && app.dataset.mood !== 'sleeping') {
      const eyes = document.querySelectorAll('.eye');
      const blink = () => eyes.forEach((e) => e.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.1)' }, { transform: 'scaleY(1)' }], { duration: 150, easing: 'ease-in-out' }));
      blink(); if (Math.random() < 0.18) setTimeout(blink, 200);
    }
    scheduleBlink();
  }, (busy ? 5000 : 3500) + Math.random() * 3000);
})();
// 视线跟随光标（睡着/reduce-motion 时不跟）
if (window.api && window.api.onCursor) window.api.onCursor((p) => {
  if (p.moved) { lastActivityAt = Date.now(); if (sleeping) wake(); }   // 鼠标动=用户在 → 惊醒
  // 穿透兜底(每150ms)：不依赖 mousemove，光标静止在新弹出的气泡/面板上也能即时接管；离开窗口即穿透
  if (!petDragging && window.api.setIgnore) setIgnore(!(p.inBounds && hitInteractive(p.cx, p.cy)));
  const eyes = $('#eyes'); if (!eyes) return;
  if (motionOff || sleeping) { eyes.style.transform = ''; return; }
  const x = Math.max(-0.85, Math.min(0.85, p.x)) * 1.6;   // viewBox 47 用户单位：幅度按新比例缩小，避免眼球移过头
  const y = Math.max(-0.5, Math.min(0.5, p.y)) * 1.1;
  eyes.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
});

// ---- 生命感：惊醒 / 睡眠阶梯 / 随机小动作 / 动效开关 ----
function wake() {
  sleeping = false; applyMood();
  petAnim([{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }], { duration: 300, easing: 'ease-out' });
}
function enterSleep() {
  if (sleeping || !(taskMood === 'idle' || taskMood === 'done')) return;
  sleeping = true; applyMood();
}
setInterval(() => {   // 用户 ~60s 没动鼠标且任务空闲/完成 → 睡着（动鼠标会惊醒）
  if (!motionOff && !sleeping && Date.now() - lastActivityAt > 60000) enterSleep();
}, 2000);
(function scheduleFidget() {   // 醒着且空闲时，30–60s 随机小动作（看一眼/歪头）
  setTimeout(() => {
    if (!motionOff && !sleeping && (taskMood === 'idle' || taskMood === 'done') && Date.now() - lastActivityAt > 18000) {
      if (Math.random() < 0.5) {
        const eyes = $('#eyes'); const off = Math.random() < 0.5 ? -3.5 : 3.5;
        if (eyes) { eyes.style.transform = `translate(${off}px,0)`; setTimeout(() => { if (!sleeping && !motionOff) eyes.style.transform = ''; }, 900); }
      } else {
        petAnim([{ transform: 'rotate(0)' }, { transform: 'rotate(3deg)' }, { transform: 'rotate(0)' }], { duration: 600, easing: 'ease-in-out' });
      }
    }
    scheduleFidget();
  }, 30000 + Math.random() * 30000);
})();
if (window.api && window.api.onMotion) window.api.onMotion((on) => {   // 托盘"动效"开关
  motionOff = !on || osReduceMotion;
  app.dataset.motion = motionOff ? 'off' : 'on';
  if (motionOff) { sleeping = false; const e = $('#eyes'); if (e) e.style.transform = ''; applyMood(); }   // 关动效时若正睡着→强制醒来：睡眠 interval 有 !motionOff 门槛不会自行推进，否则眼睛卡成眯线
});
if (window.api && window.api.onPet) window.api.onPet((px) => {   // 调整桌宠大小(托盘/拖拽手柄)
  petPxLocal = px;
  document.documentElement.style.setProperty('--pet', px + 'px');
  window.api.resize(currentMode);
});
// 右下角手柄：按住拖动连续调大小（下右=变大）。窗口由 setPet 回传 set-pet 重排(collapsed)，bubble 态额外 measureAndResize 调高
(function () {
  const grip = $('#resize-grip'); if (!grip) return;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();   // 不触发桌宠的 tap/移窗
    setIgnore(false);
    const sx = e.screenX, sy = e.screenY, start = petPxLocal;
    const onMove = (ev) => {
      const px = Math.max(80, Math.min(220, Math.round(start + ((ev.screenX - sx) + (ev.screenY - sy)) / 2)));
      if (px === petPxLocal) return;
      petPxLocal = px;
      document.documentElement.style.setProperty('--pet', px + 'px');   // 即时缩放
      if (window.api && window.api.setPet) window.api.setPet(px);        // 持久化 + 回传重排窗口
      measureAndResize();                                               // bubble 态按更大桌宠重算窗高
    };
    const onUp = (ev) => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); setIgnore(!hitInteractive(ev.clientX, ev.clientY)); };   // 松手立刻重算穿透，与桌宠拖拽一致(不等 150ms 兜底)
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();
// 鼠标穿透：透明窗默认让点击穿到下方应用；指针落在实体像素上才接管。拖拽中由 petDragging 锁定不切换；
// 静止光标/弹出新元素由 onCursor(每150ms) 兜底重算，不只靠 mousemove。
if (window.api && window.api.setIgnore) {
  document.addEventListener('mousemove', (e) => { if (!petDragging) setIgnore(!hitInteractive(e.clientX, e.clientY)); });
  document.addEventListener('mouseleave', () => { if (!petDragging) setIgnore(true); });
}
document.querySelectorAll('.chip').forEach((c) =>
  c.addEventListener('click', () => window.api.setWindow(Number(c.dataset.win))));

(function initI18n() {   // 用所选语言覆盖 index.html 里的静态英文默认（zh 系统→中文）
  const rl = document.querySelector('#rl-line .lbl'); if (rl) rl.textContent = T.rlLabel;
  const c = $('#collapse'); if (c) c.title = T.tCollapse;
  const m = $('#stack-min'); if (m) { m.title = T.tMinimize; m.setAttribute('aria-label', T.tMinimize); }
  const g = $('#resize-grip'); if (g) g.title = T.tResize;
})();

function renderPet(d) {
  taskMood = d.mascot; applyMood();
  const b = $('#badge');
  if (d.needsCount > 0) { b.textContent = d.needsCount; b.classList.add('show'); }
  else b.classList.remove('show');
  $('#pet').title = T.petTitle(d.rows.length, d.needsCount, fmtN(d.agg.out));
}

function renderPanel(d) {
  // 窗口范围高亮
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', Number(c.dataset.win) === d.windowMin));

  renderQuota(d);   // 顶部只保留"有意义时"的内容：实时配额条 / 本地 5h 读数；都没有则塌缩，不留空行/说明

  // 任务列表
  const ul = $('#tasks'); ul.innerHTML = '';
  if (!d.rows.length) { ul.innerHTML = `<li class="empty">${esc(T.empty)}</li>`; }
  for (const r of d.rows) {
    const li = document.createElement('li');
    li.className = 'task' + (r.attention ? ' attn' : '');
    const color = STATE_COLOR[r.state.key] || '#7d8597';
    const todo = r.todos
      ? `<div class="t-todo"><div class="bar"><i style="width:${Math.round(100 * r.todos.done / Math.max(1, r.todos.total))}%"></i></div>`
        + `<span class="cur">${r.todos.done}/${r.todos.total}${r.todos.current ? ' · ' + esc(r.todos.current) : ''}</span></div>`
      : '';
    const toolTxt = (r.state.key === 'RUNNING' && r.tool) ? ` · <span class="t-tool">${esc(r.tool)}</span>` : '';
    li.innerHTML =
      `<span class="sdot" style="background:${color}"></span>`
      + `<div class="t-main"><div class="t-title">${esc(r.title)}</div>`
      + `<div class="t-meta">${esc(T.state[r.state.key] || r.state.label)} · ${esc(r.src)} · ${esc(r.projectShort)} · ${fmtIdle(r.idleSec)}${r.live ? ' · ' + esc(T.active) : ''}${r.stale ? ' · ' + esc(T.stale) : ''}${toolTxt}</div>${todo}</div>`
      + `<div class="t-right"><div class="t-usage">${fmtN(r.usage.out)} <span class="dim">${fmtCost(r.usage.cost, r.usage.costReal)}</span></div>`
      + `${r.project ? `<button class="openbtn" title="${esc(T.openDir)}">${ICONS.folder}</button>` : ''}</div>`;
    if (r.project) li.querySelector('.openbtn').addEventListener('click', () => window.api.openPath(r.project));
    ul.appendChild(li);
  }
  // 聚合用量挪到底部、次要呈现（成本仅按单价估算，订阅不计费）；实时用量失败也只在此低调提示
  const liveFail = d.quota && !d.quota.ok;
  $('#panel-foot').textContent = `${fmtN(d.agg.out)} ${T.out} · ≈${fmtCost(d.agg.cost, true)} (${T.estimate})`
    + (liveFail ? ' · ' + T.liveFail : '') + ` · ${new Date(d.generatedAt).toLocaleTimeString()}`;
}

const Q_BUCKETS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_cowork'];   // 标签经 T.qb 本地化
function qColor(u) { return u >= 90 ? '#fb6f86' : u >= 70 ? '#f5c451' : '#6aa1ff'; }   // 对齐 CSS --err/--warn/--accent
function quotaAlert(d) {   // 返回最严重的 bucket（util≥90 才算告急），否则 null
  const q = d && d.quota; if (!q || !q.ok || !q.quota) return null;
  let worst = null;
  for (const k of Q_BUCKETS) { const bk = q.quota[k]; if (bk && bk.util >= 90 && (!worst || bk.util > worst.util)) worst = { util: Math.round(bk.util), label: T.qb[k], resetsAt: bk.resetsAt }; }
  return worst;
}
function quotaText(a) {
  const remain = a.resetsAt ? Date.parse(a.resetsAt) - Date.now() : 0;
  return T.quotaUsed(a.label, a.util, remain > 0 ? fmtIdle(remain / 1000) : '');
}
function applyQuota(d) { app.dataset.quota = quotaAlert(d) ? 'critical' : ''; }   // 任一 bucket≥90% → 桌宠光晕转红
function renderQuota(d) {
  const box = $('#quota'), rl = $('#rl-line'), summary = $('#summary'); box.innerHTML = '';
  const q = d.quota;
  if (q && q.ok && q.quota) {                          // 实时配额条（最有用的视图）
    rl.style.display = 'none';
    for (const k of Q_BUCKETS) {
      const b = q.quota[k]; if (!b) continue;
      const u = Math.round(b.util);
      const remain = b.resetsAt ? Date.parse(b.resetsAt) - Date.now() : 0;
      box.insertAdjacentHTML('beforeend',
        `<div class="q-row"><span class="qlbl">${esc(T.qb[k])}</span>`
        + `<div class="q-bar"><i style="width:${Math.min(100, u)}%;background:${qColor(u)}"></i></div>`
        + `<span class="q-val">${u}%<span class="q-reset"> · ${remain > 0 ? fmtIdle(remain / 1000) : T.reset}</span></span></div>`);
    }
    const ex = q.quota.extra_usage;
    if (ex && ex.is_enabled) box.insertAdjacentHTML('beforeend',
      `<div class="q-row"><span class="qlbl">${esc(T.extra)}</span><span class="dim" style="grid-column:2/4">${esc(T.used)} $${(ex.used_credits || 0).toFixed(2)} / ${esc(T.limit)} $${ex.monthly_limit}</span></div>`);
    box.insertAdjacentHTML('beforeend', `<div class="q-reset" style="margin-top:3px">${esc(T.liveAge(fmtIdle((Date.now() - q.fetchedAt) / 1000)))}</div>`);
  } else if (d.rl) {                                   // 无实时配额条但有本地 5h 读数 → 只显这一行
    rl.style.display = '';
    const ok = d.rl.status === 'allowed' && !d.rl.isUsingOverage;
    $('#rl-dot').className = 'dot ' + (ok ? 'ok' : 'warn');
    const remain = d.rl.resetsAt * 1000 - Date.now();
    $('#rl-text').textContent = `${d.rl.status}${d.rl.isUsingOverage ? ' [' + T.overage + ']' : ''} · ${T.reset} ${clock(d.rl.resetsAt)}`
      + (remain > 0 ? ` (${fmtIdle(remain / 1000)})` : ` (${T.wasReset})`);
  } else {
    rl.style.display = 'none';
  }
  summary.style.display = (rl.style.display === 'none' && !box.children.length) ? 'none' : '';   // 顶部无内容则整块塌缩
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

if (window.api && window.api.onUpdate) {
  window.api.onUpdate((d) => { try { last = d; renderPet(d); applyQuota(d); if (open) renderPanel(d); detectTransitions(d); updateMode(d); } catch (e) { console.error('[render]', e); } });   // 单轮渲染异常隔离：不卡死后续更新
} else {
  // 预览 / 开发：无 Electron 时用示例数据渲染，方便看界面
  const now = Date.now();
  const mock = {
    generatedAt: now, windowMin: 120, mascot: 'needs', needsCount: 2,
    agg: { in: 120000, out: 458000, cr: 7710000, cw: 294000, cost: 2.34, byModel: { 'opus-4-8': 3, 'sonnet-4-6': 1 }, count: 4 },
    rl: { status: 'allowed', type: 'five_hour', resetsAt: Math.floor(now / 1000) + 3600, isUsingOverage: false, ts: now - 120000 },
    quota: { ok: true, fetchedAt: now - 35000, quota: {
      five_hour: { util: 48, resetsAt: new Date(now + 59 * 60000).toISOString() },
      seven_day: { util: 64, resetsAt: new Date(now + 3 * 86400000).toISOString() },
      seven_day_sonnet: { util: 2, resetsAt: new Date(now + 3 * 86400000).toISOString() },
      seven_day_opus: null, seven_day_cowork: null,
      extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 0 },
    } },
    rows: [
      { key: '1', src: 'Cowork-VM', title: 'Math modeling progress', projectShort: 'Mathmodel', project: '/x', state: { key: 'AWAITING', label: '等输入' }, tool: null, idleSec: 42, live: false, attention: true, usage: { out: 34260, cost: 0.31, costReal: true }, todos: { total: 7, done: 5, current: 'Writing the report section' }, model: 'opus-4-8' },
      { key: '2', src: 'Code', title: 'clawd-pets', projectShort: 'clawd-pets', project: '/y', state: { key: 'RUNNING', label: '运行中' }, tool: 'Bash', activity: 'Restart Electron and verify clean boot', think: 'Refactoring renderer: single bubble → live status stack, one row per task', idleSec: 3, live: true, attention: false, usage: { out: 6170, cost: 0.42, costReal: false }, todos: null, model: 'opus-4-8' },
      { key: '3', src: 'Cowork-VM', title: 'English writing help', projectShort: 'English-learning', project: '/z', state: { key: 'ERROR', label: '出错' }, tool: null, idleSec: 300, live: false, attention: true, usage: { out: 28400, cost: 4.2, costReal: true }, todos: null, model: 'sonnet-4-6' },
      { key: '4', src: 'Cowork', title: 'Project review', projectShort: 'A new project', project: '/w', state: { key: 'IDLE', label: '空闲' }, tool: null, idleSec: 5400, live: false, attention: false, usage: { out: 90600, cost: 7.2, costReal: false }, todos: null, model: 'opus-4-8' },
    ],
  };
  window.api = { onUpdate() {}, resize() {}, resizeBubble() {}, setPet() {}, openPath() {}, setWindow() {}, quit() {}, getBounds() { return Promise.resolve({ x: 0, y: 0, width: 150, height: 150 }); }, moveWindow() {} };
  last = mock; renderPet(mock); applyQuota(mock); updateMode(mock);
}
