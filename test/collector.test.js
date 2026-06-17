'use strict';
/*
 * collector 状态推导单测（T0.4）。纯函数断言，无需真实 Claude 会话、CI 可复现。
 * 跑：npm test  （node --test）
 * 覆盖 Tier 0 三处修复：pid 参与状态(T0.1)、①② 识别 is_error→ERROR(T0.2)、关注态语义(配合 T0.3)。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { jsonlState, auditState, jsonlUsage, auditUsage, summarizeTodos, isAttn, isAttnClass } = require('../src/collector');

// ---- ①② transcript 行构造器 ----
const asstTool = (id, name = 'Bash', model = 'claude-opus-4-8') =>
  ({ type: 'assistant', message: { model, stop_reason: null, content: [{ type: 'tool_use', id, name }] } });
const userResult = (id, isErr = false) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isErr }] } });
const asstEnd = (text = '完成') =>
  ({ type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const userText = (text = '继续') => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const asstUsage = (u) => ({ type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: u } });

const key = (parsed, idle, live) => jsonlState(parsed, idle, live).state.key;

// ---------- jsonlState：RUNNING / WAIT 与 pid (T0.1) ----------
test('pending 工具 + 刚写入 → RUNNING', () => {
  assert.equal(key([asstTool('t1')], 5, false), 'RUNNING');
});
test('pending 工具 + 久未写入 + 进程已退(非 live) → WAIT', () => {
  assert.equal(key([asstTool('t1')], 120, false), 'WAIT');
});
test('T0.1: pending 工具 + 久未写入 + 进程仍活(live) → RUNNING（长工具不再误报"等你确认"）', () => {
  assert.equal(key([asstTool('t1')], 120, true), 'RUNNING');
});

// ---------- jsonlState：AWAITING / ERROR (T0.2) ----------
test('工具成功 + end_turn 收尾 → AWAITING（完成待看）', () => {
  assert.equal(key([asstTool('t1'), userResult('t1', false), asstEnd()], 5, false), 'AWAITING');
});
test('T0.2: 卡在失败工具结果上——停滞(idle>30 非live)才 ERROR；刚发生(idle<30)仍 RUNNING', () => {
  assert.equal(key([asstTool('t1'), userResult('t1', true)], 120, false), 'ERROR');
  assert.equal(key([asstTool('t1'), userResult('t1', true)], 5, false), 'RUNNING');   // 刚失败、agent 多半正要反应
});
test('修正: 工具出错后 agent 仍在活跃思考(写文字/进程 live) → RUNNING，不误报"出错了"', () => {
  const p = [asstTool('t1'), userResult('t1', true), { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: '命令失败了，我换个方式重试' }] } }];
  assert.equal(key(p, 5, false), 'RUNNING');     // 刚写入 → 在思考
  assert.equal(key(p, 120, true), 'RUNNING');    // 进程还活着 → 在跑
  assert.equal(key(p, 120, false), 'ERROR');     // 久未写入且进程退 → 才算停滞出错
});
test('评审修正: 失败后 agent 用 end_turn 收尾(汇报失败) → AWAITING，不误判 ERROR', () => {
  assert.equal(key([asstTool('t1'), userResult('t1', true), asstEnd('系统阻止了修改，需你确认')], 5, false), 'AWAITING');
});
test('T0.2: 失败后已重试成功 → 不报 ERROR（避免过度报红）', () => {
  const p = [asstTool('t1'), userResult('t1', true), asstTool('t2'), userResult('t2', false), asstEnd()];
  assert.equal(key(p, 5, false), 'AWAITING');
});
test('评审修正(高危): 失败后用户中断并输入新指令 → 清除失败标记，不永久报红', () => {
  const p = [asstTool('t1'), userResult('t1', true), userText('[Request interrupted by user]'), userText('我重新选了目录')];
  assert.notEqual(key(p, 5, false), 'ERROR');
});
test('评审修正: 中断类工具结果(Request interrupted)不算失败', () => {
  const interrupted = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '[Request interrupted by user for tool use]' }] } };
  assert.notEqual(key([asstTool('t1'), interrupted], 5, false), 'ERROR');
});
test('审计修正: 历史孤儿 tool_use(中断/后台残留)不算 pending，end_turn 终态不被压成 WAIT', () => {
  assert.equal(key([asstTool('t1'), asstEnd('整轮总览如下…')], 120, false), 'AWAITING');   // t1 永无结果(孤儿)，但已干净收尾
});
test('审计修正: 末条 assistant 是 API/额度错误 → ERROR(即使有残留 pending/即使 live)', () => {
  const apiErr = { type: 'assistant', message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Usage credits required, turn on usage credits at claude.ai' }] } };
  assert.equal(key([asstTool('t1'), apiErr], 5, true), 'ERROR');
});
test('误报修复: agent 正文里"提到"API Error/Usage credits(在讨论报错)→ 不误判 ERROR', () => {
  const talk = { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: '我刚改了 API Error 与 Usage credits required 的识别正则，正在验证 rate limit 分支' }] } };
  assert.notEqual(key([asstTool('t1'), userResult('t1'), talk], 5, false), 'ERROR');
});
test('审计修复: 陈旧 API Error 文本后跟纯 tool_use 续跑(过载自动重试已恢复)→ RUNNING，不被旧错误串误判 ERROR', () => {
  const apiErr = { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'API Error: Overloaded' }] } };
  // 后续 assistant 只有 tool_use(无 text，不覆盖游离 lastText)；按"最后一条 assistant 自身文本"判定应为 RUNNING
  assert.equal(key([apiErr, asstTool('t2')], 5, true), 'RUNNING');
  assert.equal(key([apiErr, asstTool('t2')], 5, false), 'RUNNING');
});
test('审计修正: pending 只认最后一条 assistant 的未完成工具(当前确在调工具)→ RUNNING', () => {
  assert.equal(key([asstEnd('先看下'), asstTool('t9')], 5, false), 'RUNNING');   // 最后一条 assistant 有未返回工具
});

// ---------- jsonlState：末条 user 分支 + pid ----------
test('末条 user + 刚写入 → RUNNING', () => {
  assert.equal(key([userText()], 5, false), 'RUNNING');
});
test('末条 user + 久未写入 + 非 live → IDLE', () => {
  assert.equal(key([userText()], 120, false), 'IDLE');
});
test('修正: 末条 user + 久未写入(即使进程 live) → IDLE（停在输入提示≠运行，修 stop 后误显思考中）', () => {
  assert.equal(key([userText()], 120, true), 'IDLE');
});
test('修正: 用户中断 [Request interrupted] → IDLE（即使刚发生/进程 live 也不显示思考中）', () => {
  const intArr = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  assert.equal(key([asstTool('t1'), userResult('t1'), intArr], 5, true), 'IDLE');
  const intStr = { type: 'user', message: { content: '[Request interrupted by user]' } };
  assert.equal(key([asstEnd(), intStr], 5, true), 'IDLE');
});
test('无 assistant/user 行 → null', () => {
  assert.equal(jsonlState([{ type: 'system' }], 5, false), null);
});

// ---------- jsonlState：标题提取 (T1.5) ----------
test('T1.5: 标题优先级 customTitle > aiTitle > lastPrompt', () => {
  const ai = { type: 'ai-title', aiTitle: 'AI 标题' };
  const custom = { type: 'custom-title', customTitle: '用户标题' };
  const lp = { type: 'last-prompt', lastPrompt: 'prompt 文本' };
  assert.equal(jsonlState([custom, ai, lp, asstEnd()], 5, false).title, '用户标题');
  assert.equal(jsonlState([ai, lp, asstEnd()], 5, false).title, 'AI 标题');
  assert.equal(jsonlState([lp, asstEnd()], 5, false).title, 'prompt 文本');
});
test('修复: 新一轮思考中(刚发提示、本轮没写文字) → think 不残留上一轮叙述', () => {
  const p = [
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '上一轮做完了' }] } },
    userText('现在做新任务'),
    asstTool('t1'),   // 本轮开始调工具，还没写文字
  ];
  const s = jsonlState(p, 5, false);
  assert.equal(s.think, null);          // 不应残留"上一轮做完了"
  assert.equal(s.state.key, 'RUNNING');
});
test('think 在本轮写了新文字后正常更新', () => {
  const p = [userText('做新任务'), { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: '好的，开始分析' }] } }, asstTool('t1')];
  assert.equal(jsonlState(p, 5, false).think, '好的，开始分析');
});
test('T1.5: 无标题元数据 → title null（collect 兜底为目录名）', () => {
  assert.equal(jsonlState([asstEnd()], 5, false).title, null);
});
test('T1.5: 超长 lastPrompt 截断到 60 字', () => {
  const lp = { type: 'last-prompt', lastPrompt: 'x'.repeat(200) };
  assert.ok(jsonlState([lp, asstEnd()], 5, false).title.length <= 60);
});

// ---------- auditState（③ 沙箱 Cowork）----------
const akey = (parsed, idle = 5) => auditState(parsed, idle).state.key;
test('③ 末条 result.is_error → ERROR', () => {
  assert.equal(akey([asstEnd(), { type: 'result', is_error: true }]), 'ERROR');
});
test('③ 审计修正: 真限流(status≠allowed)→RATE；allowed 用量心跳不误判 RATE', () => {
  assert.equal(akey([asstEnd(), { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]), 'RATE');
  assert.notEqual(akey([asstEnd(), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }]), 'RATE');
});
test('③ 末条 result(无错) → AWAITING', () => {
  assert.equal(akey([asstTool('t1'), userResult('t1'), { type: 'result', is_error: false }]), 'AWAITING');
});
test('③ 有 pending 工具：新鲜→RUNNING；陈旧(>30s)→WAIT(不恒 RUNNING)', () => {
  assert.equal(akey([asstTool('t1')], 5), 'RUNNING');
  assert.equal(akey([asstTool('t1')], 120), 'WAIT');
});
test('③ 末条 assistant 是 API/额度错误 → ERROR', () => {
  const apiErr = { type: 'assistant', message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Usage credits required for 1M context' }] } };
  assert.equal(akey([asstTool('t1'), userResult('t1'), apiErr]), 'ERROR');
});
test('③ 审计修复: 陈旧 API Error 后跟纯 tool_use 续跑(已恢复)→ RUNNING，不被旧错误串误判 ERROR', () => {
  const apiErr = { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'API Error: Overloaded' }] } };
  assert.equal(akey([apiErr, asstTool('t2')], 5), 'RUNNING');
});
test('③ system 行不影响"末条"判定（result 后跟 system 仍 AWAITING）', () => {
  assert.equal(akey([{ type: 'result', is_error: false }, { type: 'system' }]), 'AWAITING');
});

// ---------- 用量 ----------
test('jsonlUsage 累加各 assistant.message.usage', () => {
  const p = [asstUsage({ input_tokens: 100, output_tokens: 50 }), asstUsage({ input_tokens: 10, output_tokens: 5 })];
  const u = jsonlUsage(p, 'claude-opus-4-8');
  assert.equal(u.in, 110); assert.equal(u.out, 55);
  assert.ok(u.cost > 0);
});
test('auditUsage 累加 result.usage + total_cost_usd', () => {
  const p = [
    { type: 'result', usage: { input_tokens: 200, output_tokens: 100 }, total_cost_usd: 0.3 },
    { type: 'result', usage: { input_tokens: 50, output_tokens: 20 }, total_cost_usd: 0.1 },
  ];
  const u = auditUsage(p);
  assert.equal(u.in, 250); assert.equal(u.out, 120);
  assert.ok(Math.abs(u.cost - 0.4) < 1e-9);
  assert.equal(u.costReal, true);
});

// ---------- summarizeTodos ----------
test('summarizeTodos 统计 total/done/current', () => {
  const r = summarizeTodos([
    { status: 'completed', content: 'a' },
    { status: 'in_progress', activeForm: 'doing b' },
    { status: 'pending', content: 'c' },
  ]);
  assert.equal(r.total, 3); assert.equal(r.done, 1); assert.equal(r.current, 'doing b');
});
test('summarizeTodos 空 → null', () => {
  assert.equal(summarizeTodos([]), null);
  assert.equal(summarizeTodos(null), null);
});

// ---------- isAttn（关注态语义，配合 T0.3 窗口豁免）----------
test('isAttn: ERROR/RATE/WAIT 新鲜期(2h)内关注，超时降级（评审修正 stale 无消费者）', () => {
  assert.equal(isAttn('ERROR', 100), true);
  assert.equal(isAttn('RATE', 100), true);
  assert.equal(isAttn('WAIT', 100), true);
  assert.equal(isAttn('ERROR', 3 * 3600), false);   // >2h → 仍在面板可见但不再驱动表情/气泡
  assert.equal(isAttn('WAIT', 3 * 3600), false);
});
test('isAttn: AWAITING 仅新鲜期(10min)内关注', () => {
  assert.equal(isAttn('AWAITING', 100), true);   // <600s
  assert.equal(isAttn('AWAITING', 700), false);  // >600s
});
test('isAttn: RUNNING/IDLE 不关注', () => {
  assert.equal(isAttn('RUNNING', 1), false);
  assert.equal(isAttn('IDLE', 1), false);
});
test('isAttnClass: 结构判定(超窗保留用)，不看新鲜度', () => {
  assert.equal(isAttnClass('ERROR'), true);
  assert.equal(isAttnClass('RATE'), true);
  assert.equal(isAttnClass('WAIT'), true);
  assert.equal(isAttnClass('AWAITING'), true);
  assert.equal(isAttnClass('RUNNING'), false);
  assert.equal(isAttnClass('IDLE'), false);
});
