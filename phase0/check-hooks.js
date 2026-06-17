#!/usr/bin/env node
/*
 * Phase 0 — hooks 验证报告
 * 读取 ~/.claude/hook-probe.log，交叉 Cowork 元数据，判定:
 *   - 终端 Claude Code 是否触发 hooks
 *   - Cowork 桌面端 是否触发 hooks  <-- 交互方案的命门
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const LOG = path.join(HOME, '.claude', 'hook-probe.log');
const COWORK_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

function walk(dir, m, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = path.join(dir, e.name); e.isDirectory() ? walk(p, m, out) : (m(e.name) && out.push(p)); }
  return out;
}
const coworkIds = new Set();
for (const f of walk(COWORK_DIR, n => n.startsWith('local_') && n.endsWith('.json'))) {
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d.cliSessionId) coworkIds.add(d.cliSessionId); } catch {}
}

let lines = [];
try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch {
  console.log('❌ 还没有 ~/.claude/hook-probe.log —— hooks 尚未触发过。');
  console.log('   先确认 settings.json 已装 hooks，再触发一次会话。');
  process.exit(0);
}

const term = { count: 0, events: {} }, cowork = { count: 0, events: {} }, unknown = { count: 0, events: {} };
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  const bucket = r.session_id == null ? unknown : coworkIds.has(r.session_id) ? cowork : term;
  bucket.count++; bucket.events[r.event] = (bucket.events[r.event] || 0) + 1;
}
const ev = o => Object.entries(o).map(([k, v]) => `${k}×${v}`).join(', ') || '无';

console.log('===== Phase 0 hooks 验证报告 =====');
console.log(`日志条目: ${lines.length}`);
console.log('');
console.log(`终端 Claude Code : ${term.count ? '✅ 触发' : '⬜ 无'}   (${ev(term.events)})`);
console.log(`Cowork 桌面端    : ${cowork.count ? '✅ 触发' : '⬜ 无'}   (${ev(cowork.events)})   <-- 交互方案命门`);
if (unknown.count) console.log(`无 session_id    : ${unknown.count}   (${ev(unknown.events)})`);
console.log('');
if (cowork.count) {
  console.log('结论: Cowork 认 hooks ✅ —— PLAN.md §5.1 "在桌宠上批准权限" 路线成立。');
} else if (term.count) {
  console.log('结论: 终端认 hooks，Cowork 暂未见触发。');
  console.log('      → 请在 Cowork 里"新开一个会话/任务"并发一条消息(hooks 通常仅在会话启动时加载)，再跑本脚本。');
} else {
  console.log('结论: 暂无任何 hook 触发 —— 检查 settings.json 的 hooks 配置与 hook-probe.js 路径。');
}
