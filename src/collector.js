'use strict';
/*
 * 数据层：纯读本地文件，统一收集三类 Claude 任务的状态、用量、todo、账户 5h 限额。
 * 被 Electron 主进程和 phase0 CLI 复用。无任何写操作、无网络。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PRICE = require('./pricing');

const HOME = os.homedir();
const APP = path.join(HOME, 'Library', 'Application Support', 'Claude');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const COWORK_META_DIR = path.join(APP, 'claude-code-sessions');
const AGENT_MODE_DIR = path.join(APP, 'local-agent-mode-sessions');
const TASKS_DIR = path.join(HOME, '.claude', 'tasks');
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');

const MAX_READ = 6 * 1024 * 1024;  // 用量统计单文件最多读尾部 6MB
const RUNNING_SECS = 30;           // 末次写入早于此 + 有未完成工具 => 从"运行中"转"等待?"
const FRESH_AWAIT_SECS = 600;      // "等输入"超过此时长不再视为"需要你"(避免对陈旧会话长期告警)

const ST = {
  RUNNING: { key: 'RUNNING', label: '运行中' }, WAIT: { key: 'WAIT', label: '等待?' },
  AWAITING: { key: 'AWAITING', label: '等输入' }, IDLE: { key: 'IDLE', label: '空闲' },
  ERROR: { key: 'ERROR', label: '出错' }, RATE: { key: 'RATE', label: '限流' },
};

const ATTN_MAX_SECS = 2 * 3600;    // 出错/限流/等你确认 主动告警的新鲜上限：超此仍在面板可见(超窗 stale)，但不再驱动表情/气泡/计数

// 是否"需要你"族（结构判定，用于超窗保留：见 collect 的 hardCull）
function isAttnClass(key) { return key === 'ERROR' || key === 'RATE' || key === 'WAIT' || key === 'AWAITING'; }
// 是否"需要你"且仍新鲜（驱动 mascot/needs/气泡）：出错/限流/等你确认 2h 内，完成(等输入) 10min 内
function isAttn(key, idleSec) {
  if (key === 'AWAITING') return idleSec < FRESH_AWAIT_SECS;
  if (key === 'ERROR' || key === 'RATE' || key === 'WAIT') return idleSec < ATTN_MAX_SECS;
  return false;
}

function priceOf(model) {
  const m = String(model || '');
  if (/fable/.test(m)) return PRICE.fable;
  if (/sonnet/.test(m)) return PRICE.sonnet;
  if (/haiku/.test(m)) return PRICE.haiku;
  return PRICE.opus;
}

// ---------- 文件工具 ----------
const SKIP_DIRS = new Set(['subagents', 'node_modules', '.git']);  // subagents/=工作流/Task 子代理的内部 transcript，非用户任务，递归遇到即剪枝
function walk(dir, m, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, m, out); }
    else if (m(e.name, p)) out.push(p);
  }
  return out;
}
function readFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const partial = st.size > MAX_READ;
    const start = partial ? st.size - MAX_READ : 0;
    const buf = Buffer.alloc(st.size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    let t = buf.toString('utf8');
    if (partial) { const i = t.indexOf('\n'); if (i >= 0) t = t.slice(i + 1); }
    return { lines: t.split('\n').filter(Boolean), mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}
function parse(lines) { const o = []; for (const l of lines) { try { o.push(JSON.parse(l)); } catch {} } return o; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }   // ESRCH=已退/EPERM=他人进程(非我方 claude 会话)→均视为不活

// ---------- 索引 / 旁路数据 ----------
function liveSessions() {
  const s = new Set();
  for (const f of walk(SESSIONS_DIR, n => n.endsWith('.json'))) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d.pid && d.sessionId && alive(d.pid)) s.add(d.sessionId); } catch {}
  }
  return s;
}
function loadLegacyMeta() {
  const m = new Map();
  for (const f of walk(COWORK_META_DIR, n => n.startsWith('local_') && n.endsWith('.json'))) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d.cliSessionId) m.set(d.cliSessionId, d); } catch {}
  }
  return m;
}
function summarizeTodos(items) {
  if (!items || !items.length) return null;
  const done = items.filter(t => t.status === 'completed').length;
  const cur = items.find(t => t.status === 'in_progress');
  return { total: items.length, done, current: cur ? (cur.activeForm || cur.subject || cur.content || null) : null };
}
function todosForSession(sessionId) {  // ①② host: ~/.claude/tasks/<sessionId>/*.json
  const dir = path.join(TASKS_DIR, sessionId);
  let files; try { files = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return null; }
  const items = [];
  for (const f of files) { try { items.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {} }
  return summarizeTodos(items);
}
function todosFromAudit(parsed) {  // ③ sandbox: 最近一次 TodoWrite tool_use 的 todos
  let todos = null;
  for (const e of parsed) {
    const m = e.message;
    if (e.type === 'assistant' && m && Array.isArray(m.content))
      for (const c of m.content)
        if (c.type === 'tool_use' && /TodoWrite/.test(c.name || '') && c.input && Array.isArray(c.input.todos)) todos = c.input.todos;
  }
  return summarizeTodos(todos);
}

// ---------- 当前活动摘要（"正在做什么"，对标 Claude Code 状态行：Ran <desc> / 读取 file 等）----------
function baseName(p) { return p ? String(p).split('/').pop() : ''; }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function cleanThink(s) {   // 轻量去 markdown：代码块/链接(留文字)/列表/标题/残余标记，再交给 clip
  return String(s == null ? '' : s)
    .replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*([-*+]|\d+\.|#{1,6})\s+/gm, '').replace(/[`*_#>|]/g, '');
}
function toolActivity(name, input) {
  if (!name) return null;
  const i = input || {};
  const n = String(name).replace(/^mcp__[a-z0-9_]+__/i, '').replace(/^mcp__/i, '');
  const t = n.toLowerCase();
  if (/^(bash|shell|exec)/.test(t)) return i.description ? clip(i.description, 76) : (i.command ? '运行 ' + clip(String(i.command).split('\n')[0], 60) : '运行命令');
  if (/^(edit|write|notebookedit|multiedit|str_replace|apply)/.test(t)) return '编辑 ' + (baseName(i.file_path || i.notebook_path) || '文件');
  if (/^read$/.test(t)) return '读取 ' + (baseName(i.file_path) || '文件');
  if (/grep/.test(t)) return '检索 ' + clip(i.pattern || i.query || '', 50);
  if (/glob/.test(t)) return '查找 ' + clip(i.pattern || i.glob || '', 50);
  if (/websearch/.test(t)) return '搜索 ' + clip(i.query, 50);
  if (/webfetch|fetch/.test(t)) { let h = i.url; try { h = new URL(i.url).host; } catch {} return '访问 ' + clip(h || '', 50); }
  if (/^(task|agent)$/.test(t)) return clip(i.description || i.prompt || '子任务', 76);
  if (/todo/.test(t)) return '整理计划';
  if (i.description) return clip(i.description, 76);
  if (i.query) return clip(i.query, 60);
  if (i.file_path) return baseName(i.file_path);
  return n;   // 退回工具名
}

// ---------- 状态判定 ----------
const INTERRUPT_RE = /Request interrupted/i;   // "[Request interrupted by user]" 等：用户主动中断，不算工具失败
// 真实 API 错误：Claude Code 把它作为 assistant 消息正文、以 "API Error:" 起头且简短。
// 必须锚定开头 + 限长——否则会匹配到 agent 正文里"讨论/复述"这些词的叙述(如本项目自己在写 API 错误识别时)，造成误报出错。
const API_ERR = /^api error\b/i;
function isApiErrorText(s) { const t = String(s || '').trim(); return t.length > 0 && t.length < 300 && API_ERR.test(t); }
function resultText(c) {
  const x = c && c.content;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
  return '';
}
// pending 只认"最后一条 assistant 消息里未返回结果的工具"——忽略中断/后台工具(TaskOutput/Workflow 等)留下的历史孤儿 tool_use；
// 否则孤儿使 pending 永真，把真实的 end_turn 终态压成 WAIT(host)/RUNNING(sandbox)。
function pendingFromLastAsst(lastAsst, res) {
  if (!lastAsst || !lastAsst.message || !Array.isArray(lastAsst.message.content)) return null;
  let p = null;
  for (const c of lastAsst.message.content) if (c.type === 'tool_use' && !res.has(c.id)) p = c;
  return p;
}

function jsonlState(parsed, idleSec, live) {
  const real = parsed.filter(e => e && (e.type === 'assistant' || e.type === 'user'));
  if (!real.length) return null;
  const tu = new Map(), res = new Set(); let lastAsst = null, model, cwd, lastResErr = false, lastUserInterrupt = false, customTitle, aiTitle, lastPrompt, lastText = null;
  for (const e of parsed) {
    if (e.cwd) cwd = e.cwd; const m = e.message;
    if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;      // 标题优先级：用户手设 > Claude 生成 > 末次提示
    else if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;
    else if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    else if (e.type === 'assistant' && m && Array.isArray(m.content)) { lastAsst = e; lastUserInterrupt = false; if (m.model) model = m.model; for (const c of m.content) { if (c.type === 'tool_use') tu.set(c.id, c); else if (c.type === 'text' && c.text && c.text.trim()) lastText = c.text; } }
    else if (e.type === 'user' && m) {
      // 逐条 user 消息重算：含工具结果→取本条末个 is_error(中断结果不算错)；纯文本输入→清零失败标记；纯中断消息→标记(用户已停，非运行中)
      if (Array.isArray(m.content)) {
        let had = false, err = false, interrupt = false;
        for (const c of m.content) {
          if (c.type === 'tool_result') { res.add(c.tool_use_id); had = true; if (!!c.is_error && !INTERRUPT_RE.test(resultText(c))) err = true; }   // 同条消息多结果：任一真错即算错(OR 聚合，不被后一个覆盖)
          else if (c.type === 'text' && INTERRUPT_RE.test(c.text || '')) interrupt = true;
        }
        lastResErr = had ? err : false;
        lastUserInterrupt = !had && interrupt;
        if (!had) lastText = null;   // 用户新提示/中断(非工具结果)=新一轮开始 → 清上一轮叙述，避免"思考中"仍显上轮末尾
      } else { lastResErr = false; lastUserInterrupt = INTERRUPT_RE.test(String(m.content || '')); lastText = null; }
    }
  }
  let lastTU = null; for (const [, c] of tu) lastTU = c;                        // 全历史最后一个工具(仅用于 activity 摘要)
  const pendingTU = pendingFromLastAsst(lastAsst, res);                         // pending 只认最后一条 assistant 里未返回结果的工具(忽略历史孤儿)
  const pending = pendingTU ? pendingTU.name : null;
  const actTU = pendingTU || lastTU;                                            // 正在执行的工具；无则取最近一个(工具间隙的"刚做了什么")
  const activity = actTU ? toolActivity(actTU.name, actTU.input) : null;
  const think = lastText ? clip(cleanThink(lastText), 90) : null;   // 最近一条 assistant 叙述=当前"思考链"摘要
  const stop = lastAsst && lastAsst.message ? lastAsst.message.stop_reason : null;
  const lastReal = real[real.length - 1];
  // API 错误判定只看"最后一条 assistant 消息自身的末段文本"，不用游离的 lastText：
  // 否则旧的 "API Error:" 文本后跟着纯 tool_use 续跑(无 text 不覆盖 lastText)会被误判 ERROR(实为已恢复/运行中)
  let lastAsstText = null;
  if (lastAsst && lastAsst.message && Array.isArray(lastAsst.message.content))
    for (const c of lastAsst.message.content) if (c.type === 'text' && c.text && c.text.trim()) lastAsstText = c.text;
  let state;
  // 末条 assistant 正文是真实 API 错误(以 "API Error:" 起头) → 出错(需要你处理，如开通额度)
  if (lastReal.type === 'assistant' && isApiErrorText(lastAsstText)) state = ST.ERROR;
  // 长工具：mtime 变旧但进程(pid)还活着 → 仍"运行中"，不误报"等你确认"(WAIT)
  else if (pending) state = (idleSec < RUNNING_SECS || live) ? ST.RUNNING : ST.WAIT;
  // agent 已用 end_turn 优雅收尾(哪怕在汇报失败) → "等输入"，不盖成 ERROR
  else if (stop === 'end_turn' && lastReal.type === 'assistant') state = ST.AWAITING;
  // 工具出错：仅在"停滞在错误上"(久未写入且进程已退)才算出错需要你；仍在活跃推进(刚写入/进程在)说明 agent 在处理错误=运行中，不误报"出错了"
  else if (lastResErr) state = (idleSec < RUNNING_SECS || live) ? ST.RUNNING : ST.ERROR;
  // 末条是 user：刚发出的提示(新鲜)→运行中；用户已中断或长时间无回应→空闲。不再用 live 撑 RUNNING：
  // 进程还活着但停在输入提示符 ≠ 在运行(否则 stop 后/等输入的交互会话会一直误显"思考中")
  else if (lastReal.type === 'user') state = (!lastUserInterrupt && idleSec < RUNNING_SECS) ? ST.RUNNING : ST.IDLE;
  else state = ST.IDLE;
  const title = customTitle || aiTitle || (lastPrompt ? lastPrompt.replace(/\s+/g, ' ').trim().slice(0, 60) : null);
  return { state, pending, activity, think, model, cwd, title };
}
function auditState(parsed, idleSec) {
  const mean = parsed.filter(e => ['user', 'assistant', 'result'].includes(e.type) || (e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.status !== 'allowed'));   // 含真限流(status≠allowed)；排除 allowed 用量心跳(否则每条心跳误判 RATE)
  const last = mean[mean.length - 1];
  const tu = new Map(), res = new Set(); let lastText = null, lastAsst = null;
  for (const e of parsed) {
    const m = e.message;
    if (e.type === 'assistant' && m && Array.isArray(m.content)) { lastAsst = e; for (const c of m.content) { if (c.type === 'tool_use') tu.set(c.id, c); else if (c.type === 'text' && c.text && c.text.trim()) lastText = c.text; } }
    else if (e.type === 'user' && m) {
      if (Array.isArray(m.content)) { let had = false; for (const c of m.content) if (c.type === 'tool_result') { res.add(c.tool_use_id); had = true; } if (!had) lastText = null; }
      else lastText = null;   // 用户新提示=新一轮 → 清上一轮叙述
    }
  }
  let lastTU = null; for (const [, c] of tu) lastTU = c;
  const pendingTU = pendingFromLastAsst(lastAsst, res);
  const actTU = pendingTU || lastTU;
  const activity = actTU ? toolActivity(actTU.name, actTU.input) : null;
  const think = lastText ? clip(cleanThink(lastText), 90) : null;
  let lastAsstText = null;   // 同 jsonlState：API 错误只看最后一条 assistant 自身末段文本，避免陈旧错误串+后续 tool_use 误判
  if (lastAsst && lastAsst.message && Array.isArray(lastAsst.message.content))
    for (const c of lastAsst.message.content) if (c.type === 'text' && c.text && c.text.trim()) lastAsstText = c.text;
  let state;
  if (!last) state = ST.IDLE;
  else if (last.type === 'assistant' && isApiErrorText(lastAsstText)) state = ST.ERROR;   // 真实 API 错误("API Error:" 起头)终止
  else if (last.type === 'result' && last.is_error) state = ST.ERROR;
  else if (last.type === 'rate_limit_event') state = ST.RATE;   // 真限流(allowed 心跳已在 mean 过滤掉)
  else if (last.type === 'result') state = ST.AWAITING;
  else if (pendingTU) state = idleSec < RUNNING_SECS ? ST.RUNNING : ST.WAIT;   // 新鲜度门控(沙箱无 live)：陈旧未完成工具→等你确认/授权，不恒 RUNNING
  else state = idleSec < RUNNING_SECS ? ST.RUNNING : ST.IDLE;
  const pending = pendingTU ? String(pendingTU.name).replace(/^mcp__workspace__/, '').replace(/^mcp__/, '') : null;
  return { state, pending, activity, think };
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
  u.cost = (u.in + u.cw * 1.25 + u.cr * 0.1) / 1e6 * p[0] + u.out / 1e6 * p[1];
  return u;
}
function auditUsage(parsed) {
  const u = emptyU(); let cost = 0;
  for (const e of parsed) if (e.type === 'result') { addUsage(u, e.usage); if (typeof e.total_cost_usd === 'number') cost += e.total_cost_usd; }
  u.cost = cost; u.costReal = true;
  return u;
}

function mergeAgg(agg, u, model) {
  agg.in += u.in; agg.out += u.out; agg.cr += u.cr; agg.cw += u.cw; agg.cost += u.cost;
  const k = String(model || '?').replace('claude-', ''); agg.byModel[k] = (agg.byModel[k] || 0) + 1;
}
function makeRow(o) {
  const proj = o.project || '';
  let projectShort;
  if (o.sandbox || proj.includes('local-agent-mode-sessions')) projectShort = '(沙箱)';
  else projectShort = proj ? path.basename(proj) : '?';
  return {
    key: o.key, src: o.src, title: o.title || '(无标题)', project: proj, projectShort,
    state: o.state, tool: o.pending || null, activity: o.activity || null, think: o.think || null, idleSec: o.idleSec, live: !!o.live,
    usage: o.usage, todos: o.todos || null, model: o.model || null, stale: !!o.stale,
  };
}

// ---------- 主入口 ----------
function collect(opts = {}) {
  const windowMin = opts.windowMin || 120;
  const hardCull = Math.max(windowMin * 60, 6 * 3600);  // 关注态兜底窗口：至少 6h，救回超窗但仍需处理(出错/等你确认)的任务
  const now = Date.now();
  const legacy = loadLegacyMeta();
  const live = liveSessions();
  const rows = [];
  const agg = { in: 0, out: 0, cr: 0, cw: 0, cost: 0, byModel: {}, count: 0 };
  let rl = null;

  // ① 终端/Code  +  ② 旧版 Cowork
  for (const file of walk(PROJECTS_DIR, n => n.endsWith('.jsonl'))) try {
    let st; try { st = fs.statSync(file); } catch { continue; }
    const idleSec = Math.floor((now - st.mtimeMs) / 1000);
    if (idleSec > hardCull) continue;                                          // 真·古老：超兜底上限不解析
    let parsed; try { parsed = parse(readFile(file).lines); } catch { continue; }
    const id = path.basename(file, '.jsonl');
    const s = jsonlState(parsed, idleSec, live.has(id)); if (!s) continue;
    if (idleSec > windowMin * 60 && !isAttnClass(s.state.key)) continue;        // 超窗且非"需要你"族 → 丢；出错/限流/等你确认 即使超窗也保留(标 stale)
    const cw = legacy.get(id);
    const u = jsonlUsage(parsed, s.model);
    const title = (cw && cw.title) ? cw.title : (s.title || null);   // Cowork 元数据标题 > jsonl(custom/ai/last-prompt) > 目录名(下方兜底)
    rows.push(makeRow({ key: id, src: cw ? 'Cowork' : 'Code', title, project: s.cwd, state: s.state, pending: s.pending, activity: s.activity, think: s.think, idleSec, live: live.has(id), usage: u, todos: todosForSession(id), model: s.model, stale: idleSec > windowMin * 60 }));
    const lastRow = rows[rows.length - 1];
    if (lastRow.title === '(无标题)') lastRow.title = lastRow.projectShort;
    mergeAgg(agg, u, s.model);
  } catch { /* 单会话解析异常隔离：不拖垮整轮 collect，UI 不静默停更 */ }
  // ③ 新版沙箱 Cowork
  for (const meta of walk(AGENT_MODE_DIR, n => /^local_[0-9a-f-]+\.json$/.test(n))) try {
    let d; try { d = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
    if (!d.sessionId) continue;
    const audit = path.join(path.dirname(meta), d.sessionId, 'audit.jsonl');
    let f; try { f = readFile(audit); } catch { continue; }
    const parsed = parse(f.lines);
    const idleSec = Math.floor((now - f.mtimeMs) / 1000);
    if (idleSec > hardCull) continue;   // 古老会话整体跳过——也不让其陈旧 rate_limit_event 污染面板"5h 限额"
    for (const e of parsed) if (e.type === 'rate_limit_event' && e.rate_limit_info) {
      const t = e._audit_timestamp ? Date.parse(e._audit_timestamp) : NaN;   // Date.parse(0)===2000年(非0)，须显式校验
      const ts = Number.isFinite(t) ? t : 0;
      if (!rl || ts > rl.ts) rl = { ts, info: e.rate_limit_info };
    }
    const s = auditState(parsed, idleSec);
    if (idleSec > windowMin * 60 && !isAttnClass(s.state.key)) continue;
    const u = auditUsage(parsed);
    const proj = (d.userSelectedFolders && d.userSelectedFolders[0]) || null;
    rows.push(makeRow({ key: d.sessionId, src: 'Cowork-VM', title: d.title, project: proj, sandbox: !proj, state: s.state, pending: s.pending, activity: s.activity, think: s.think, idleSec, live: false, usage: u, todos: todosFromAudit(parsed), model: d.model, stale: idleSec > windowMin * 60 }));
    mergeAgg(agg, u, d.model);
  } catch { /* 单沙箱会话异常隔离 */ }
  agg.count = rows.length;

  // 注意力 + 桌宠情绪（多会话取最高优先级，富状态）
  let needs = 0, anyErr = false, anyWait = false, anyRunTool = false, anyThinking = false, anyDone = false;
  for (const r of rows) {
    const k = r.state.key;
    r.attention = isAttn(k, r.idleSec);
    if (r.attention) needs++;
    // 仅新鲜关注行驱动桌宠表情：超窗 stale 的旧告警仍在面板可见，但不让 Clawd 长期红/黄
    if (k === 'ERROR' || k === 'RATE') { if (r.attention) anyErr = true; }
    else if (k === 'WAIT') { if (r.attention) anyWait = true; }
    else if (k === 'RUNNING') { if (r.tool) anyRunTool = true; else anyThinking = true; }
    else if (k === 'AWAITING' && r.attention) anyDone = true;
  }
  const mascot = anyErr ? 'error' : anyWait ? 'needs' : anyRunTool ? 'working' : anyThinking ? 'thinking' : anyDone ? 'done' : 'idle';
  rows.sort((a, b) => (Number(b.attention) - Number(a.attention)) || (a.idleSec - b.idleSec));

  if (rl && rl.info && rl.info.resetsAt && rl.info.resetsAt * 1000 < now) rl = null;   // 5h 窗口已过重置点 → 旧读数失效，不再显示
  return {
    generatedAt: now, windowMin, rows, agg,
    rl: rl ? { status: rl.info.status, type: rl.info.rateLimitType, resetsAt: rl.info.resetsAt, isUsingOverage: rl.info.isUsingOverage, ts: rl.ts } : null,
    mascot, needsCount: needs,
  };
}

module.exports = { collect, jsonlState, auditState, jsonlUsage, auditUsage, summarizeTodos, isAttn, isAttnClass, ST,
  WATCH_DIRS: [PROJECTS_DIR, AGENT_MODE_DIR, SESSIONS_DIR, COWORK_META_DIR] };   // 供 main 用 fs.watch 事件驱动刷新
