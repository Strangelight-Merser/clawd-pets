#!/usr/bin/env node
/*
 * Phase 0 — 多任务监控 + 用量 (v3)
 * 纯读本地文件，统一显示三类任务的状态 + token 用量 + 账户 5 小时限额窗口。
 *   ① 终端 / "Code" 标签           : ~/.claude/projects/<cwd>/<id>.jsonl
 *   ② 旧版 Cowork                  : 同上 + claude-code-sessions 元数据
 *   ③ 新版沙箱 Cowork (agent mode) : local-agent-mode-sessions/.../audit.jsonl
 *
 * 用量：transcript 每条 assistant 的 usage 块 / audit 的 result(total_cost_usd+usage)。
 *      ③ 有真实成本；①② 按单价估算(订阅制不按此计费，仅作量级参考)。
 * 限额：audit 的 rate_limit_event(five_hour 窗口 status + resetsAt)。
 *
 * 运行: node phase0/monitor.js [窗口分钟=120] [once]
 *
 * ⚠️ 分叉警告：本文件自带一份 jsonlState/auditState/jsonlUsage/auditUsage/collect 拷贝，
 *    与 src/collector.js 已**漂移**——src 端的 Tier 0 修复(pid 参与状态/①②报ERROR/关注态新鲜度窗口)
 *    未同步到这里。这是个 phase 0 探针(非出货代码)，状态判定以 src/collector.js 为唯一事实来源。
 *    收敛为 require('../src/collector') 复用 = ROADMAP 的 T2.4，待办。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const APP = path.join(HOME, 'Library', 'Application Support', 'Claude');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const COWORK_META_DIR = path.join(APP, 'claude-code-sessions');
const AGENT_MODE_DIR = path.join(APP, 'local-agent-mode-sessions');
const HOOK_LOG = path.join(HOME, '.claude', 'hook-probe.log');

const WINDOW_MIN = Number(process.argv[2]) || 120;
const ONCE = process.argv[3] === 'once';
const RUNNING_SECS = 30;
const MAX_READ = 6 * 1024 * 1024; // 用量统计单文件最多读尾部 6MB

// 每 1M token 单价 [input, output]（claude-api 技能表；缓存读≈0.1×输入，缓存写≈1.25×输入）
const PRICE = { fable: [10, 50], opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] };
function priceOf(model) {
  const m = String(model || '');
  if (/fable/.test(m)) return PRICE.fable;
  if (/sonnet/.test(m)) return PRICE.sonnet;
  if (/haiku/.test(m)) return PRICE.haiku;
  return PRICE.opus;
}

// ---------- 通用 ----------
function walk(dir, m, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = path.join(dir, e.name); e.isDirectory() ? walk(p, m, out) : (m(e.name, p) && out.push(p)); }
  return out;
}
// 读文件：小文件全读，大文件只读尾部 MAX_READ（用量会标 ~ 部分）
function readFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const partial = st.size > MAX_READ;
    const start = partial ? st.size - MAX_READ : 0;
    const buf = Buffer.alloc(st.size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (partial) { const i = text.indexOf('\n'); if (i >= 0) text = text.slice(i + 1); }
    return { lines: text.split('\n').filter(Boolean), mtimeMs: st.mtimeMs, partial };
  } finally { fs.closeSync(fd); }
}
function parse(lines) { const o = []; for (const l of lines) { try { o.push(JSON.parse(l)); } catch {} } return o; }

function loadCoworkLegacyMeta() {
  const map = new Map();
  for (const f of walk(COWORK_META_DIR, n => n.startsWith('local_') && n.endsWith('.json'))) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d.cliSessionId) map.set(d.cliSessionId, d); } catch {}
  }
  return map;
}

// ---------- 状态判定 ----------
const S = {
  run: { label: '运行中', color: 32 }, wait: { label: '等待?', color: 33 },
  done: { label: '等输入', color: 34 }, idle: { label: '空闲', color: 90 },
  err: { label: '出错', color: 31 }, rate: { label: '限流', color: 35 },
};
function jsonlState(parsed, idleSec) {
  const real = parsed.filter(e => e && (e.type === 'assistant' || e.type === 'user'));
  if (!real.length) return null;
  const tu = new Map(), res = new Set(); let lastAsst = null, model, cwd;
  for (const e of parsed) {
    if (e.cwd) cwd = e.cwd; const m = e.message;
    if (e.type === 'assistant' && m && Array.isArray(m.content)) { lastAsst = e; if (m.model) model = m.model; for (const c of m.content) if (c.type === 'tool_use') tu.set(c.id, c.name); }
    if (e.type === 'user' && m && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_result') res.add(c.tool_use_id);
  }
  let pending = null; for (const [id, n] of tu) if (!res.has(id)) pending = n;
  const stop = lastAsst && lastAsst.message ? lastAsst.message.stop_reason : null;
  let st;
  if (pending) st = idleSec < RUNNING_SECS ? S.run : S.wait;
  else if (stop === 'end_turn' && real[real.length - 1].type === 'assistant') st = S.done;
  else if (real[real.length - 1].type === 'user') st = idleSec < RUNNING_SECS ? S.run : S.idle;
  else st = S.idle;
  return { st, pending, model, cwd };
}
function auditState(parsed, idleSec) {
  const mean = parsed.filter(e => ['user', 'assistant', 'result', 'rate_limit_event'].includes(e.type));
  const last = mean[mean.length - 1];
  const tu = new Map(), res = new Set();
  for (const e of parsed) {
    const m = e.message;
    if (e.type === 'assistant' && m && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_use') tu.set(c.id, c.name);
    if (e.type === 'user' && m && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_result') res.add(c.tool_use_id);
  }
  let pending = null; for (const [id, n] of tu) if (!res.has(id)) pending = n;
  let st;
  if (!last) st = S.idle;
  else if (last.type === 'result' && last.is_error) st = S.err;
  else if (last.type === 'rate_limit_event') st = S.rate;
  else if (last.type === 'result') st = S.done;
  else if (pending) st = S.run;
  else st = idleSec < RUNNING_SECS ? S.run : S.idle;
  return { st, pending: pending ? pending.replace(/^mcp__workspace__/, '').replace(/^mcp__/, '') : null };
}

// ---------- 用量 ----------
function emptyU() { return { in: 0, out: 0, cr: 0, cw: 0, cost: 0, costReal: false }; }
function addUsage(acc, u) {
  if (!u) return;
  acc.in += u.input_tokens || 0; acc.out += u.output_tokens || 0;
  acc.cr += u.cache_read_input_tokens || 0; acc.cw += u.cache_creation_input_tokens || 0;
}
function jsonlUsage(parsed, model) {
  const u = emptyU();
  for (const e of parsed) if (e.type === 'assistant' && e.message && e.message.usage) addUsage(u, e.message.usage);
  const p = priceOf(model);
  u.cost = (u.in + u.cw * 1.25 + u.cr * 0.1) / 1e6 * p[0] + u.out / 1e6 * p[1]; // 估算
  return u;
}
function auditUsage(parsed) {
  const u = emptyU(); let cost = 0;
  for (const e of parsed) if (e.type === 'result') { addUsage(u, e.usage); if (typeof e.total_cost_usd === 'number') cost += e.total_cost_usd; }
  u.cost = cost; u.costReal = true; // ③ 有真实成本
  return u;
}

// ---------- 显示 ----------
function fmtN(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); }
function fmtC(c) { return '$' + (c < 1 ? c.toFixed(2) : c.toFixed(1)); }
function fmtIdle(s) { return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'; }
function tilde(p) { return p ? p.replace(HOME, '~') : '?'; }
function dispW(s) { let w = 0; for (const c of String(s)) w += c.charCodeAt(0) > 255 ? 2 : 1; return w; }
function pad(s, n) { s = String(s == null ? '' : s); const w = dispW(s); return w >= n ? s : s + ' '.repeat(n - w); }
function clip(s, n) { s = String(s || ''); let w = 0, o = ''; for (const c of s) { const cw = c.charCodeAt(0) > 255 ? 2 : 1; if (w + cw > n) return o + '…'; w += cw; o += c; } return o; }
function col(c, s) { return `\x1b[${c}m${s}\x1b[0m`; }

function collect(now) {
  const rows = []; const agg = { byModel: {}, ...emptyU() }; let rl = null;
  const legacy = loadCoworkLegacyMeta();

  // ① ② ~/.claude/projects
  for (const file of walk(PROJECTS_DIR, n => n.endsWith('.jsonl'))) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    const idleSec = Math.floor((now - st.mtimeMs) / 1000);
    if (idleSec > WINDOW_MIN * 60) continue;
    const parsed = parse(readFile(file).lines);
    const s = jsonlState(parsed, idleSec); if (!s) continue;
    const id = path.basename(file, '.jsonl'); const cw = legacy.get(id);
    const u = jsonlUsage(parsed, s.model);
    rows.push({ idleSec, src: cw ? 'Cowork' : 'Code', title: cw && cw.title ? cw.title : path.basename(s.cwd || '?'), st: s.st, tool: s.pending || '-', cwd: tilde(s.cwd), archived: cw && cw.isArchived, u, model: s.model });
    mergeAgg(agg, u, s.model);
  }
  // ③ local-agent-mode-sessions
  for (const meta of walk(AGENT_MODE_DIR, n => /^local_[0-9a-f-]+\.json$/.test(n))) {
    let d; try { d = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
    if (!d.sessionId) continue;
    const audit = path.join(path.dirname(meta), d.sessionId, 'audit.jsonl');
    let f; try { f = readFile(audit); } catch { continue; }
    const idleSec = Math.floor((now - f.mtimeMs) / 1000);
    const parsed = parse(f.lines);
    // 顺手收集账户级 5h 限额事件（取最新）
    for (const e of parsed) if (e.type === 'rate_limit_event' && e.rate_limit_info) {
      const ts = Date.parse(e._audit_timestamp || 0) || 0;
      if (!rl || ts > rl.ts) rl = { ts, info: e.rate_limit_info };
    }
    if (idleSec > WINDOW_MIN * 60) continue;
    const s = auditState(parsed, idleSec);
    const u = auditUsage(parsed);
    const proj = (d.userSelectedFolders && d.userSelectedFolders[0]) || d.cwd;
    rows.push({ idleSec, src: 'Cowork▣', title: d.title || path.basename(proj || '?'), st: s.st, tool: s.pending || '-', cwd: tilde(proj), archived: d.isArchived, u, model: d.model });
    mergeAgg(agg, u, d.model);
  }
  rows.sort((a, b) => a.idleSec - b.idleSec);
  return { rows, agg, rl };
}
function mergeAgg(agg, u, model) {
  agg.in += u.in; agg.out += u.out; agg.cr += u.cr; agg.cw += u.cw; agg.cost += u.cost;
  const k = String(model || '?').replace('claude-', ''); agg.byModel[k] = (agg.byModel[k] || 0) + 1;
}

function render() {
  const now = Date.now();
  const { rows, agg, rl } = collect(now);
  const o = [];
  o.push(col(1, `📊 多任务监控 v3  ${new Date().toLocaleTimeString()}  (窗口 ${WINDOW_MIN}m)`));

  // 用量汇总
  const models = Object.entries(agg.byModel).map(([k, v]) => `${k}×${v}`).join(' ');
  o.push(col(36, `💰 窗口内用量(${rows.length}会话): 入${fmtN(agg.in)} 出${fmtN(agg.out)} 缓存读${fmtN(agg.cr)} 写${fmtN(agg.cw)} · ≈${fmtC(agg.cost)} ` + col(90, '(API等价,订阅不计费)')));
  if (models) o.push(col(90, `   模型: ${models}`));
  // 5h 限额窗口
  if (rl) {
    const i = rl.info; const reset = new Date((i.resetsAt || 0) * 1000);
    const remain = i.resetsAt * 1000 - now;
    const remStr = remain > 0 ? `还剩 ${fmtIdle(Math.floor(remain / 1000))}` : '读数已过期(窗口已重置)';
    const age = fmtIdle(Math.floor((now - rl.ts) / 1000));
    const ok = i.status === 'allowed' && !i.isUsingOverage;
    o.push(col(ok ? 32 : 31, `⏳ 5h限额: ${i.status}${i.isUsingOverage ? ' [用超额]' : ''} · 重置 ${reset.toLocaleTimeString()} (${remStr}) ` + col(90, `· 读数 ${age}前`)));
  } else {
    o.push(col(90, '⏳ 5h限额: 无 rate_limit_event(需要近期有沙箱 Cowork 活动才会记录)'));
  }
  o.push('');

  // 表
  o.push(col(1, pad('状态', 7) + pad('来源', 8) + pad('标题', 22) + pad('空闲', 6) + pad('工具', 11) + pad('输出', 8) + pad('≈$', 8) + '项目'));
  o.push(col(90, '─'.repeat(100)));
  if (!rows.length) o.push(col(90, '  (窗口内无活跃会话)'));
  for (const r of rows) {
    o.push(
      col(r.st.color, pad(r.st.label, 7)) + pad(r.src, 8) +
      pad((r.archived ? '🗄' : '') + clip(r.title, 18), 22) + pad(fmtIdle(r.idleSec), 6) +
      pad(clip(r.tool, 10), 11) + pad(fmtN(r.u.out), 8) +
      pad((r.u.costReal ? '' : '~') + fmtC(r.u.cost), 8) + col(90, r.cwd)
    );
  }
  o.push('');
  o.push(col(90, '来源: Cowork▣=新版沙箱  Cowork=旧版/本地  Code=终端或Code标签  |  ≈$ 带~为估算, ③为真实成本'));
  o.push(col(90, '图例: ' + col(32, '运行中') + ' ' + col(33, '等待?') + ' ' + col(34, '等输入') + ' ' + col(35, '限流') + ' ' + col(31, '出错') + ' ' + col(90, '空闲')));

  if (!ONCE) process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(o.join('\n') + '\n');
}

render();
if (!ONCE) setInterval(render, 2000);
