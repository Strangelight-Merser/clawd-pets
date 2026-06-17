# Phase 0 — 可行性验证

目的：在写 Electron 应用前，先用最小脚本验证两件事——
1. **状态判定能不能纯读文件做准**（监控部分）
2. **Cowork 是否认 hooks**（交互方案的命门）

## 1. 监控脚本（只读，随时可跑）

```bash
node phase0/monitor.js            # 默认最近 120 分钟活跃会话
node phase0/monitor.js 30         # 只看最近 30 分钟
node phase0/monitor.js 360 once   # 6 小时窗口，打印一次后退出
```

实时刷新（每 2s），统一显示 Cowork + Claude Code 的任务：状态 / 来源 / 标题 / 空闲时长 / 当前工具 / 目录。

**已验证结论**
- ✅ Cowork vs Code 来源区分准（靠 `claude-code-sessions/**/local_*.json` 的 `cliSessionId` 交叉比对）
- ✅ Cowork 标题准；Code 用目录名兜底
- ✅ 运行中 / 等输入(完成) / 空闲 三态判得准
- ⚠️ **盲区**：会话"有未完成工具 + 文件停写"时，无法区分"卡在权限(需要你)"和"长命令运行中"。
  脚本用 30s 阈值把它标成 `等待?`，但要真正区分，必须靠 hooks。

## 2. hooks 验证（需修改全局 settings.json，请你本人执行）

⚠️ 这会往 `~/.claude/settings.json` 装 5 个**只记日志、不改 Claude 行为**的 hook
（PreToolUse 不返回 decision = 正常放行），影响今后每个 Claude 会话。已自动备份，可一键还原。

### 安装
```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak
cp ~/Claude/Projects/process-seeing/phase0/hook-probe.js ~/.claude/hook-probe.js
node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude/settings.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));const N="/opt/homebrew/bin/node "+process.env.HOME+"/.claude/hook-probe.js";const c=e=>({type:"command",command:N+" "+e});s.hooks={SessionStart:[{hooks:[c("SessionStart")]}],UserPromptSubmit:[{hooks:[c("UserPromptSubmit")]}],PreToolUse:[{matcher:"*",hooks:[c("PreToolUse")]}],Notification:[{hooks:[c("Notification")]}],Stop:[{hooks:[c("Stop")]}]};fs.writeFileSync(p,JSON.stringify(s,null,2));console.log("hooks 已安装");'
```

### 触发并验证
1. **终端**：随便跑一句 `claude -p "说 ping"`（会触发 SessionStart/UserPromptSubmit/Stop）。
2. **Cowork**：在 Cowork 里**新开一个会话/任务**发一条消息（hooks 通常在会话启动时加载，旧会话可能不生效）。
3. 看报告：
```bash
node ~/Claude/Projects/process-seeing/phase0/check-hooks.js
```
报告会分别告诉你"终端"和"Cowork"是否触发了 hooks。**Cowork 那行显示 ✅ = 交互方案成立。**

### 还原（随时）
```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
rm -f ~/.claude/hook-probe.js ~/.claude/hook-probe.log
```

## 文件
- `monitor.js` — 实时任务状态监控（只读）
- `hook-probe.js` — hooks 探针（装到 `~/.claude/` 后被调用，只写 `~/.claude/hook-probe.log`）
- `check-hooks.js` — 读日志 + 交叉 Cowork 元数据，输出 hooks 验证报告
