# 多任务进度桌宠（Clawd Pets / 仓库 clawd-pets）— 设计规划 v2

> 常驻置顶"桌宠"，统一显示 Claude 桌面端所有任务（Cowork + Code + 终端）的进度，
> 任务"需要你"时主动提醒。解决"多处多任务、要不断切窗口监督"的痛点。
>
> v2 基于 Phase 0 实测 + 多代理深挖（2026-06-15）。**结论：监控完全可行且信息很丰富；
> 但"从桌宠直接操作 App 里的 Cowork 任务"基本做不到（只剩脆弱的界面自动化）。**

---

## 1. 背景与目标
- 痛点：Cowork / Code / 终端多个任务并行，要不断切窗口才知道谁卡住、谁要确认、谁跑完。
- 目标：一个 always-on-top 桌宠，聚合所有任务状态；`需要你` 时提醒。
- **优先级（用户定）**：① 监控进程/状态 + ② **用量监控**(token/成本/5h限额窗口) = **核心**；回复/批准 = **添头**(可行处再做，见 §5)。

## 2. 任务的真实架构（实测）

Claude 桌面端有**三大任务家族**，数据都在本地（但位置/格式不同），外加几个跨切面存储。

| 家族 | 元数据 / transcript | 执行 & 关键点 |
|------|--------------------|----------------|
| **① 终端 + "Code" 标签** | `~/.claude/projects/<enc-cwd>/<id>.jsonl` | host 执行；**认 host hooks**；可被 `claude --resume` 接管 |
| **② 旧版/本地 Cowork** | `claude-code-sessions/<acct>/<ws>/local_*.json`（title/cliSessionId/completedTurns）+ **共用** ①的 jsonl（经 cliSessionId 关联）| host 执行；认 hooks；可 resume |
| **③ 新版 Cowork（local agent mode）** | `local-agent-mode-sessions/<acct>/<ws>/local_<id>.json` + `local_<id>/audit.jsonl` | `bypassPermissions`；**不写 ~/.claude/projects、不触发 host hooks**；cliSessionId **无法**对应 host transcript |

③ 还分两子模式：`hostLoopMode:true`=CLI 直接在 host 跑（当前会话即此）；`hostLoopMode:false`=真·gVisor VM 沙箱（Apple Virtualization.framework，vsock）。VM 由 Claude.app **进程内**托管，空闲时无独立进程。

**跨切面存储（之前漏掉、但很有用）：**
- `~/.claude/sessions/<pid>.json` —— **权威存活信号**（pid，配合 `ps` 判断真在跑）。
- `~/.claude/tasks/<sessionId>/<n>.json` —— **显式 TodoWrite 进度**（status: pending/in_progress/completed，blockedBy）！host 会话的真实待办清单。
- `spaces.json` —— 项目/空间索引，用于分组。
- `bridge-state.json` —— host↔**云端**镜像登记（env_*/cse_*），**不是本地 API**。
- 纯云端面：claude.ai IndexedDB `conversations_v2`（网页对话）、Local Storage 里的 **Scheduled Tasks / Dispatch Beta**（定义和运行状态都在云端，本地只有压缩 leveldb 痕迹）。详见记忆 [[scheduled-tasks-local-storage]]。

> ⚠️ **关键**：没有任何存储带"运行中/等待/出错"的显式标志位——状态必须**推导**（transcript 末尾 + mtime/lastActivityAt 新鲜度 + pid 存活交叉验证）。

## 3. 监控方案（核心，已验证可行）

1. 枚举所有 `<acct>/<ws>`，摄入三大家族（①②走 projects jsonl，③走 audit.jsonl）。
2. **推导状态**（见 §4）。
3. **拉真实进度**：①②从 `~/.claude/tasks/*` 读 todo 清单；③从 audit.jsonl 解析 TodoWrite tool_use 还原。
4. **分组**：`spaces.json` + `userSelectedFolders[0]` 映射到真实项目。
5. **告警面**：会话进入 `AWAITING`/`ERROR`、或"活着但闲置超阈值"时通知；`isArchived` + 长期不活跃的过滤掉。
6. 文件监听：`fs.watch`/chokidar 盯 jsonl / audit.jsonl / sessions 目录。

> Phase 0 的 `phase0/monitor.js`(v3) 已实测：三大家族全覆盖 + 用量层 + 5h 限额窗口。待补：todos 清单 / pid 存活 / awaiting 内容块精判。

### 3b. 用量监控（核心，已验证可行）
全本地可得，无需云 API：
- **逐会话 token**：①② transcript 每条 assistant 的 `usage`(input/output/cache_read/cache_creation/service_tier)；③ audit 的 `result` 条目**直接带 `total_cost_usd` + usage**(真实成本)。
- **成本**：③ 用真实 `total_cost_usd`；①② 按单价表估算(订阅制不按此计费，仅量级参考 → UI 标 `~`)。
- **账户 5 小时限额窗口**（Max 用户最该看）：audit 的 `rate_limit_event.rate_limit_info` = `{status, rateLimitType:"five_hour", resetsAt(epoch), isUsingOverage}`。取**时间戳最新**那条；显示状态/重置时刻/倒计时，并标注**读数时效**（本地回退模式）。
- **实时模式（opt-in，已实现 `src/usage-api.js`）**：`GET https://api.anthropic.com/api/oauth/usage`（头 `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`），拿 `five_hour/seven_day/seven_day_sonnet/opus/cowork` 真实 `utilization%` + `resets_at` + `extra_usage`。token 复用 Claude Code 凭据（`~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`，macOS 无该文件则读登录钥匙串，首次系统授权）。**默认关、托盘开关**（读 token + 联网，敏感）；关时回退本地读数。做法参考开源 `jens-duttke/usage-monitor-for-claude`。
- **不可用**：`~/.claude/stats-cache.json` 有历史累计但**滞后数月**(只在 CLI 重算时更新)、订阅 `costUSD:0`；`policy-limits`/`gb-cache` 是合规/功能开关，与用量无关。

## 4. 状态判定（推导，非读标志位）
- `RUNNING`：transcript 仍在追加（mtime 新）/ 有 pending tool_use / host 会话 pid 存活。
- `AWAITING`（=需要你）：①② 末轮 assistant 收尾未继续且 pid 活；③ 末条 `result`(stop=end_turn)。⚠️ "等待输入" vs "活着但闲置"要看末尾**内容块**，不能只看条目类型。
- `DONE`：末条 result/end_turn 且无新活动。
- `ERROR`：result.is_error / tool_result is_error / API error。
- 注：③ 因 `bypassPermissions`，没有"权限确认"卡顿——原来"权限 vs 长任务"盲区在新版 Cowork 不存在。

## 5. 交互的真相（重要修订）

**核心结论：无法从桌宠可靠地回复"运行中的新版沙箱 Cowork(③)任务"。** 它的输入通道是 Claude.app 进程内的匿名 socketpair / vsock，**没有监听端口、没有磁盘 socket/FIFO、没有文件收件箱**；③ 的 cliSessionId 也对不上 host transcript，`claude --resume` 接不上。能对运行中 ③ 下手的只有界面自动化。

| 路径 | 可靠性 | 说明 |
|------|--------|------|
| **桌宠当启动器**（自己用 host `claude` 开会话并托管 stdio）| 🟢 稳 | 对**自己启动**的任务 100% 可回复 + 可编程批准。但够不到 App 开的 ②③ |
| **resume 接管 ①②**（`claude -p --resume <cliSessionId> --fork-session`）| 🟢 稳 | host 会话可回复（cliSessionId 能对上 jsonl）。**必须 --fork-session** 避免冲突；无法答权限弹窗；不覆盖 ③ |
| **Accessibility / 界面自动化** Claude.app | 🟡 脆 | **唯一**能操作运行中 ③ 的办法；Electron 无 AppleScript 字典、依赖 AX 树、随版本/布局失效、需 TCC 授权。仅作 opt-in 兜底 |
| **`--remote-control` 模式** | 🟡 脆 | CLI 有此 flag 但传输/能否触达 App 会话未验证，值得做个 spike |
| **桥/vsock 直接注入** | 🔴 堵死 | 私有、进程内；bridge-state.json 是云镜像登记非注入 API；fd/ptrace 需 root 且对抗 SIP。仅可观察 |

**翻译成人话**：你最初要的"在桌宠上批准/回复"——
- 监控 + "需要你"提醒：✅ 全部任务都行。
- 回复：✅ 仅限 host 会话（终端/Code/旧版 Cowork）+ 桌宠自己开的任务；❌ App 的新版 Cowork 任务（除非用脆弱的界面自动化）。
- 批准权限：③ 是 bypassPermissions 根本没东西要批；①② 的权限弹窗走私有管道，外部也答不了。

## 6. 技术选型：Electron
透明置顶窗、`fs.watch`、托盘、原生通知、canvas 桌宠动画全开箱即用。备选 Tauri（省内存、起步慢）。

## 7. 分阶段（修订）
- **Phase 0 ✅ 已完成**：验证状态判定可行；摸清三大家族 + 沙箱执行模型 + 交互边界。产物 `phase0/`。
- **Phase 1（核心）只读监控 + 用量 + 告警桌宠**：§3 全量摄入 + §4 状态推导 + **§3b 用量/5h限额** + 项目分组 + `需要你`/出错通知。这是项目命脉，**回复/批准不在此阶段**。
- **Phase 1.5（添头交互，opt-in）**：对 ①② 加"回复"（fork-resume）；"桌宠当启动器"（新任务全程可控，§5 路径A）。AX 自动化 / --remote-control 作实验性 spike。运行中的 ③ 仍只读。
- **Phase 2（打磨）**：桌宠动画/Live2D、音效、设置（监听目录、隐藏归档、开机自启）、多账号枚举。

## 8. 风险
- 状态是启发式（末尾+mtime+pid），长工具调用易误报"需要你" → 要解析内容块 + 调阈值。
- ③ 存活信号最弱（无 host pid、空闲无 VM 进程），靠 audit.jsonl mtime + vmProcessName，可能滞后。
- 非 fork 的 `--resume` 打开着的 App 会话有文件锁冲突风险 → 一律 `--fork-session`。
- AX 自动化需 TCC 授权、随版本失效 → 仅 opt-in。
- 云端 / Scheduled / Dispatch 覆盖只能"探知存在"，全量需 claude.ai / scheduled-tasks MCP API。
- 所有存储按 `<acct>/<ws>` 嵌套，多账号需枚举全部，否则漏覆盖。
- 读 leveldb 时 Claude.app 在跑有锁竞争 → 只读/先拷贝；`audit.jsonl` 有 `.audit-key` 完整性控制，**不可追加**。

## 9. 待定决策
桌宠的交互定位（见 §5）：①只读为核心+可行处加交互（推荐）②也做 AX 自动化争取操作 App Cowork ③重心转"桌宠当启动器"。
