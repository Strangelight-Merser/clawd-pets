# process-seeing 改进路线图

> 由多视角调研（Codex 对齐 / 监控准确性 / 一眼可见性 / 生命周期分发 / 架构）+ 完整性批判 + **代码实测核验**得出（2026-06-16）。
> 长期目标不变：复刻 Codex 官方宠物功能并持续完善。形象固定官方 Clawd、通知默认关、token 经系统授权读、纯只读——均为硬约束。

## 核验纪要（先读这条）
调研里把"③ 新版 Cowork 永远 $0.00、永不冒完成气泡"列为头号 bug。**实测推翻**：21 个 `audit.jsonl` 里 **20 个含 `result` 行（都带 `total_cost_usd`）**，`auditUsage`/`auditState` 对已完成会话正常工作。真实缺口仅"进行中会话在首个 result 行写盘前暂显 $0.00"，已降级到 Tier 2 小修。
另两条经代码确证为**真 bug**（见 Tier 0）。

---

## Tier 0 — 信任修复：别让桌宠撒谎 ✅ 已完成（2026-06-16）
桌宠的全部价值是"可信、一眼可见的状态"。这些是核心推导里的真 bug，应排在任何新功能之前。
**状态：T0.1–T0.4 全部落地，26/26 单测 + live 回归 + Electron 冒烟通过。** 经 3 视角对抗性评审（证伪）发现并修正了首版实现的真问题：
- ERROR 逻辑曾过激（用户中断后仍报红、失败后 agent 用 end_turn 收尾被误判）→ 改为：用户新输入/中断清除失败标记、中断结果不算错、`end_turn` 优雅收尾优先于 ERROR（仅"卡在失败工具上无收尾"才报红）。实测把一个误报的 Code 会话正确改判为 AWAITING。
- `stale` 字段曾无人消费（旧告警纠缠到 6h）→ 新鲜度窗口 `ATTN_MAX_SECS=2h`：超 2h 的出错/限流/等你确认仍在面板可见(标"久未处理")但不再驱动表情/气泡/needs；`isAttnClass`(结构) 管超窗保留、`isAttn`(新鲜) 管告警。
- 转场动画曾漏 WAIT→ERROR/AWAITING→ERROR 入口 → 放宽为"跨入告警族即晃动"。
- `alive(pid)` 的 EPERM 曾误判他人进程为存活 → 改为 EPERM/ESRCH 均视为不活。
- 残留 deferred：③ 沙箱长工具靠 auditState 既有 pending→RUNNING 兜底(可接受)；collect 同步占主线程~130ms → T2.1；phase0/monitor.js 分叉已加警告注释、完整复用 → T2.4；多 tool_result 数组序 latent(Code 串行不触发) → 记录。

- **T0.1 pid 参与状态推导**（M，impact 高，已确证）
  `live` 已在 `collector.liveSessions()` 算出，却只喂给 UI 的"活动中"小字；`jsonlState(parsed, idleSec)` 根本没收 `live`，pending+idle>30s 一律判 `WAIT`（红钟"等你确认"+45s 晃动）。后果：跑测试/长命令 90s 无写入就误报"需要你"；进程已退仍可能显"运行中"。改：把 `live` 传进 `jsonlState`——pending 且 idle≥30s 时 live→保持 RUNNING、非 live→才降 WAIT；末条 user 且非 live→IDLE。**PLAN §8 自列此为头号风险。** 仅①②有 host pid，③ 仍靠 mtime。

- **T0.2 ①② 识别 `is_error` → ERROR**（M，impact 高，已确证）
  `jsonlState`(collector.js:99-115) 收集 `tool_result` 只 `res.add(tool_use_id)`，**从不读 `is_error`，整个函数无 ERROR 分支**。①② 任务出错时不仅不报红，末条 `end_turn` 还会被判 AWAITING 弹"✅完成"庆祝跳——最伤信任的误判。改：收 `tool_result` 时记 `is_error`，末轮存在未被正常承接的失败结果→置 `ST.ERROR`。注意区分"失败后已重试恢复"与"真错"，只对末轮无成功后继的报红。

- **T0.3 窗口剪裁豁免"需要你"态**（S，impact 中，已确证）
  `collect()`(L188/L209) 对 `idleSec>windowMin*60` 的会话 `continue` 丢弃，叠加 `FRESH_AWAIT_SECS=600`(L222) 两道静默剪裁。后果：2h 前问你要输入、之后挂起的 AWAITING/ERROR/WAIT 任务直接从列表消失，桌宠不再提醒——恰好漏掉最该提醒的长尾。改：窗口剪裁只对 IDLE/RUNNING 生效，对 attention 态（ERROR/RATE/WAIT/AWAITING）豁免保留（可标"久未处理"灰显折叠）。

- **T0.4 collector 状态推导单测 + JSONL fixtures**（M，impact 高，基础设施）
  `jsonlState/auditState/jsonlUsage/auditUsage/summarizeTodos` 是全 app 命脉却零测试，`npm run check` 依赖你机器上真实会话、CI 不可复现、不断言任何判定正确性。抽真实 jsonl/audit 片段脱敏成 fixtures，用 `node --test` 写纯函数断言。**应先于 T0.1–T0.3 的任何阈值/解析改动**——否则改推导没有回归网。

---

## Tier 1 — 常驻件该有的样子 ✅ 已完成（2026-06-16）
**状态：T1.1–T1.5 全部落地，29/29 单测 + 预览 + Electron 冒烟通过，经 3 视角对抗评审两轮修正。**
- 另修了路线图外的**真 bug**：collector 的 `walk` 递归把工作流/Task 的 `subagents/` transcript（84/109 个文件）当成独立任务 → 列表里冒出一堆重复 "process-seeing·Code" 行、且与真任务的 Code/Cowork 分类混淆。`SKIP_DIRS` 剪掉 subagents 子树后，2h 视图从 5+ 行降到 3 行真任务、分类干净。
- 评审驱动修正：拖拽与鼠标穿透抢 mousemove 导致"拖一半脱手"（HIGH，加 `petDragging` 互斥锁）；退出前 400ms 改动丢失（HIGH，`store.flush()` + `before-quit`）；静止光标/新弹元素首次点不到（`onCursor` 每150ms 用 `cx/cy/inBounds` 兜底重算穿透）；settings.json 非对象 JSON 致 set 抛错（init 类型校验）；resize 无工作区钳制致面板顶出屏外（`getDisplayMatching` clamp）；配额气泡 sig 含 util% 每涨1%重弹（改 sig 去 util + 首播一次后让位，红光晕才是常驻信号）。

下列为原始方向描述（已实现，细节见上）：

- **T1.1 鼠标穿透**（M，impact 高，盲区）⭐
  `main.js` 全程没有 `setIgnoreMouseEvents`。collapsed 是 `petPx+30` 的透明实心方窗 + 气泡区，会吃掉桌宠下方应用（编辑器右下、状态栏、Dock 边）的点击与 hover——24h 置顶常驻件最典型投诉点。改：默认 `setIgnoreMouseEvents(true,{forward:true})`，仅当指针落在 `#pet`/`#bubble` 实际像素上时由 renderer `mouseenter/leave` IPC 关掉穿透。比"迷你模式"更根本的"在但不烦"。

- **T1.2 设置持久化**（M，impact 高，基础设施）⭐
  `windowMin/intervalMs/liveUsage/notifyEnabled/motionOn/petPx` 全是模块级 `let`，窗口位置每次 `place()` 重算到右下角——重启即丢。建极小 store（`fs` 读写 `app.getPath('userData')/settings.json`，无需依赖），whenReady load 覆盖默认 + 据此 buildTray 勾选态，托盘改动/移窗 debounce 落盘。**解锁 Tier 4 的记住位置/快捷键/音效开关/自启。**

- **T1.3 多任务聚合气泡**（M，impact 高）⭐
  `pickHeadline` 永远只取最高优先级 1 行冒泡，badge 显 needsCount=3 但其余看不到——削弱"领先 Codex 的多任务聚合"卖点。**调研出现两个互斥方案（轮播 vs 同屏聚合），合并为一套**：主行文案后追加 `… +2 个还在等你` 或副行用 `STATE_COLOR` 小圆点列次要项（聚合 +N 比轮播更不吵）。`renderBubbleEl` 已是双 span，扩展成本低。

- **T1.4 配额接近上限预警**（M，impact 高，依赖本轮已完成的实时用量）⭐
  当前 `mascot` 情绪只看任务状态、完全无视配额，`qColor` 仅在面板里变色。改：renderer 读 `d.quota`，任一 bucket util≥90% → `#app[data-quota="critical"]`（光晕转红）+ 无更高优先 headline 时冒 "5h 配额已用 92%，约 18m 后重置"。对 Max 用户配额耗尽=停工，最该一眼可见。**与 T1.1 收起态视觉、badge 着色统一一套"收起态视觉优先级"规则后做，避免三者同帧语义打架。**

- **T1.5 用 ai-title 命名任务**（S，impact 中，已确证）
  `collect()` L194 非 Cowork 无 title 时直接取目录 basename，导致气泡/列表显示成 "process-seeing 思考中"、同目录多会话撞车。每个 projects jsonl 都含 `type:'ai-title'` 行（Claude 自生成的人类可读标题），`jsonlState` 已全量 parse 在手却丢弃。改：提取最后一条 `ai-title.aiTitle`（无则退 `last-prompt` 截断），目录名仅兜底。

---

## Tier 2 — 健壮性与基础设施（T2.1/T2.2/T2.3 ✅ 2026-06-16）
- ✅ **T2.1 fs.watch 事件驱动**：main 对 projects/agent-mode/sessions/cowork-meta 四目录 `fs.watch(recursive)` + 250ms 防抖 → 文件一变即重算，实时思考链/状态近实时(不再最多滞后 3s)；忽略 subagents 写入噪声；心跳保留作兜底。
- ✅ **T2.2 解析隔离 + 崩溃自愈**：collect 的 ①③ 每会话循环体包 try（单坏文件不拖垮整轮、UI 不静默停更）；main 监听 `render-process-gone`/`unresponsive` 自动 reload；renderer onUpdate 包 try/catch。
- ✅ **T2.3 用量端点退避**（随 429 修复一并完成）：180s 轮询 + 429 指数退避(180→900s) + 8s 超时 + retry-after。
> 下列为原始方向（T2.4 phase0 dedup / worker 线程移出主线程仍待办）：

- **T2.1 fs.watch 事件驱动取代 3s 死轮询**（M）：`tick()` 每 3s（"快"档 1.5s）无条件全树 walk + 读每文件尾部 6MB，无变化也跑满。改 watch 目录变更触发 collect（~300ms debounce）+ 30s 慢心跳兜底。降 CPU/IO，状态延迟从最坏 3s 降到近实时。PLAN §3.6 已规划。
- **T2.2 per-row 解析隔离 + 崩溃可观测性**（M，含盲区）：`collect()` 顶层 `jsonlUsage/auditState/mergeAgg` 在 try 外裸跑，任一行抛异常整轮 collect 失败、UI 静默停更（最糟失败模式：用户以为没任务其实崩了）。包 per-row try + 坏行降级占位；renderer 加 `window.onerror`/`unhandledrejection` 兜底 + main 监听 `render-process-gone`/`unresponsive` 重载；加 `--debug` 日志开关（打包后可追溯）。
- **T2.3 用量端点退避/超时/陈旧标记**（S–M）：`startUsage` 固定 60s 死轮询，`fetchUsage` 无显式 timeout，端点限流仍硬打。加 `AbortController`(8s) + 连续失败指数退避(60→120→300s) + 保留上次成功值显示"实时(陈旧 Nm 前)" + unauthorized 停轮询。**注意：token 刷新（refresh）单独评估、不与本条捆绑**（端点是未公开接口，主动 refresh 风险高一档且可能需回写凭据=违背只读）。
- **T2.4 消除 phase0/monitor.js 的 collector 逻辑复制**（S）：README/PLAN 称 collector "被 CLI 和 GUI 复用"，实测 `phase0/monitor.js` 自带一份 `walk/jsonlState/auditState/collect` 拷贝、未 require。改 `require('../src/collector')`，删重复推导，避免两边阈值漂移。
- **T2.5 ③ 进行中会话用量小修**（S）：唯一无 result 行的进行中 ③ 会话暂显 $0.00。可选累加 `assistant.message.usage`（21/21 文件都有）用 `pricing.js` 估算并标 `~`，不再 `costReal=true` 谎称真值。
- **T2.6 collect 增量解析 / 移出主进程**（M，发布审计提出）：`collect()` 全同步——walk 全树 statSync + 对窗口内文件读尾部≤6MB + JSON.parse 逐行（实测 windowMin=1440 单次 ≈132ms、最大单文件 47MB）。跑在主进程且被心跳(默认 3s)+fs.watch(250ms 防抖)高频触发，多个活跃大会话时桌宠呼吸/眨眼/拖拽会卡。三选一：① 移 worker_threads/utilityProcess；② fs.watch 仅当变更命中窗口内会话再 collect + 最短重算间隔(≥800ms)合并；③ 缓存每文件 (mtimeMs,size,解析结果)，mtime 未变跳过重读重解析(增量)。
- **T2.7 live 判定防 PID 复用误判**（L，精度边界）：`alive(pid)=process.kill(pid,0)` 无法区分"同 PID 不同进程"——旧会话进程退出后 PID 被 OS 复用给无关进程会被误标 live→可能误显运行中。macOS 短期复用概率低、EPERM 已当不活处理。可选增强：session json 若有进程启动时间则 `ps -o lstart=` 交叉校验，或对 live 加"文件 idleSec 也较新"双门槛。

---

## Tier 3 — 分发与首次体验

- **T3.1 打包 .app（electron-builder）+ 生成 Clawd icns**（M，impact 高）：当前只能 dev `npm start`，仓内零图标资产。加 build 段 + 由内联全-rect Clawd SVG 渲染多尺寸 icns。**原型→产品的基础，且是自启/自动更新的前置。**（未签名首启会被 Gatekeeper 拦）
- **T3.2 首启引导 + 隐私/只读声明 + 钥匙串授权解释**（M，盲区）：`liveUsage` 默认开、whenReady 立刻 `startUsage()`，无 `.credentials.json` 时会突然弹钥匙串系统框，首启用户毫无上下文。加首启说明（读了哪些路径、只读不写、token 不落盘只进 api.anthropic.com、为何要授权、如何关）。信任硬伤。
- **T3.3 开机自启**（S，依赖 T3.1+T3.2）：`setLoginItemSettings({openAtLogin, openAsHidden})` + 托盘开关。**默认建议关或显式询问**——自启 + liveUsage 默认开 = 每次登录静默联网带 token + 弹钥匙串框，须在持久化+隐私说明就绪后再开。
- **T3.4 单实例锁 + before-quit 清理**（S）：无 `requestSingleInstanceLock`，自启+手开易出两只桌宠双倍轮询。加锁 + `second-instance` 聚焦已有 + before-quit 清 timer。
- **T3.5 多显示器/多 Space 锚定 + 视线坐标修正**（M）：`place()` 钉死主屏右下角；光标移副屏时 `cursorTick` 的 dx/dy 跨屏巨大、视线一直"瞪向副屏"。改 `getDisplayNearestPoint` + 监听 `display-*` 事件重排。
- **T3.6 电池感知节流 + powerMonitor**（M）：接 `powerMonitor` suspend/resume 收放定时器、on-battery 自动升 intervalMs/降 cursorTick 频率。常驻件耗电口碑红线。
- **T3.7 浅色模式（prefers-color-scheme: light）**（M）：`:root` 硬编码暗色玻璃，常驻置顶叠浅色桌面突兀、`#9aa0ad` 文字接近 WCAG 边缘。加 light 变量组（桌宠本体不动）。
- **T3.8 autoUpdater 更新通道**（L，低优，依赖 T3.1）：electron-updater，更新提示用桌宠气泡而非 OS 弹窗（合规）。先做"手动检查+气泡提示"，签名公证后再开自动下载。

---

## Tier 4 — 趣味与体感对齐（Codex parity 锦上添花）

- **T4.1 双击/四连击逗弄彩蛋**（S，codexParity）：`#pet` mousedown 现仅区分 tap/drag，加 400ms 累计计数：双击=戳一下、四连击=甩头眩晕，走 `petAnim` 受 motionOff 控。"想去戳"的生命感。
- **T4.2 拖拽记住位置 + 弹簧/挤压物理**（M，依赖 T1.2）：落位写 prefs、启动读回（clamp 进现存显示器）；松手给 `#breath` overshoot 回弹+挤压关键帧。
- **T4.3 边缘吸附迷你模式**（L）：新增 `mode='mini'`，拖到边缘半身藏边、hover 探头。需 T1.1 穿透 + T4.2 记住吸附边。
- **T4.4 全局快捷键召唤/展开**（S，依赖 T1.2 存键位）：`globalShortcut` 切显隐 + 直接展开面板，全屏 App 里一键看限额/谁要你。
- **T4.5 可选音效**（S，默认关+10s 冷却+睡眠/勿扰静音）：复用 `detectTransitions` 已算好的 celebrate/alarm 跃迁点。
- **T4.6 hook 事件驱动阶段**（L，codexParity）：产品化 phase0 探针写 NDJSON 给 collector 读，确定性点亮"运行命令/写改动"+ 即时捕捉 Stop。**定位为轮询补强而非替代**：需用户装 settings.json hook（新外部依赖）、仅覆盖①②、③ 沙箱不认——故**排在 T2.1 fs.watch（无需用户配置即降延迟）之后**。
- **T4.7 收起态露关键信号 + badge 最坏态着色**（M）：收起态叠极细进度环（最高优先运行任务 todos）；badge 跟随最坏状态着色（ERROR 红/WAIT 琥珀/完成绿点不带数字），睡眠降透明。**与 T1.4 共用"收起态视觉优先级"规则统一做。**
- **T4.8 动画品味打磨**（M，低）：working spin 用 dasharray/缓动去跳接；配额条 `width` 加 `transition .4s` 去硬跳；`detectTransitions` 同帧 celebrate+alarm 别只取其一；nudge/fidget 加去抖。
- **T4.9 面板按项目分组 + 折叠次要任务**（L）：按 `projectShort` 分组、IDLE/陈旧折进"其它 N 个空闲"，让"需要你"始终顶部。
- **T4.10 空状态个性化**（S）：区分"窗口太短"（给可点的切 24h）vs"真没任务"（Clawd 打盹文案）。
- **T4.11 renderer.js 拆模块**（M）：327 行单文件混了格式化/气泡状态机/生命感/面板/mock。**往里加 T4.1–T4.3 前先拆**（format/bubble/pet-life/panel/mock），降每个 P2 项边际成本 + 纯函数可单测。
- **T4.12 i18n 抽取 + aria-live + 状态形状冗余**（M，盲区）：文案全硬编码中文、状态几乎只靠颜色（色觉障碍难分完成绿/出错红）、气泡无 aria-live（读屏拿不到"需要你"）。扩受众/无障碍。
- **T4.13 工具名→阶段动词映射收敛**（S）：现 collector(③剥 mcp 前缀) 与 renderer(`phaseVerb`) 双重剥离且不一致，①②的 mcp 工具显示成裸名。collector 透传原始名，剥离+归类全集中到 renderer 一处 + 映射测试。

---

## 🧊 冻结 / 需你拍板
- **对 ①② host 会话加"一句话回复"（fork-resume）**：调研提议、impact 标高，但与"纯只读"边界 + 已于 2026-06-15 推迟的"交互式审批"非目标正面冲突——`fork-resume` 会真实写入/分叉会话文件，突破 collector/usage-api 反复自证的只读定位。**批判建议保持冻结，最多做调研 spike。** 需你明确决定是否解冻才动。

## 关键依赖顺序
- 持久化(T1.2) → 解锁 记住位置(T4.2)/快捷键(T4.4)/音效开关(T4.5)/自启(T3.3)
- collector 测试(T0.4) → 先于 T0.1–T0.3 任何推导改动
- 打包(T3.1) → 先于 自启(T3.3)/自动更新(T3.8)
- fs.watch(T2.1) → 先于 hook(T4.6)
- renderer 拆分(T4.11) → 先于 T4.1–T4.3 等气泡/动画类
- "收起态视觉优先级"统一规则 → T1.4 + T4.7 一起定
