#!/usr/bin/env node
/*
 * Phase 0 — hooks 探针
 * 被 ~/.claude/settings.json 的 hooks 调用；把每次触发追加到 ~/.claude/hook-probe.log。
 * 关键：只写文件、不向 stdout 输出、永远 exit 0 —— 对 Claude 行为零干扰
 * (PreToolUse 不返回 decision = 正常放行)。
 *
 * 这是安装到 ~/.claude/hook-probe.js 的副本；改这里后需重新拷贝过去。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOG = path.join(os.homedir(), '.claude', 'hook-probe.log');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', write);
// stdin 万一不结束的兜底
setTimeout(write, 1500);

let done = false;
function write() {
  if (done) return; done = true;
  let obj = {};
  try { obj = JSON.parse(input); } catch {}
  const rec = {
    ts: new Date().toISOString(),
    event: obj.hook_event_name || process.argv[2] || 'unknown',
    session_id: obj.session_id || null,
    cwd: obj.cwd || null,
    tool: obj.tool_name || null,
    transcript: obj.transcript_path || null,
  };
  try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch {}
  process.exit(0); // 无 stdout => 不影响 agent
}
