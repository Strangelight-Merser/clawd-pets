# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [0.1.0] - 2026-06-17

首个公开版本。常驻置顶桌宠 Clawd，纯本地只读监控所有 Claude 任务（Cowork / Code / 终端）。

### 新增
- **多任务实时状态栈**：每个进行中/待关注会话一行，显示当前思考叙述（主行）+ 任务名·工具动作（副行）；按 出错/限流/等你 > 运行 > 完成 排序；keyed reconcile 原地更新，状态不变不重弹。
- **官方 Clawd 形象**：像素几何 1:1 取自官方资产；情绪光晕、呼吸、随机眨眼、视线跟随光标、长时间空闲入睡。
- **实时用量限额**（可选，默认关）：接官方 OAuth 用量端点显示 5h / 每周 / Sonnet / Opus 真实利用率与重置倒计时；任一额度 ≥90% 桌宠转红预警。OAuth token 只进请求头、不落盘、只与 `api.anthropic.com` 通信。
- **状态全靠推导**：transcript 无显式运行/出错标志位——由 末尾内容 + 工具是否返回 + mtime 新鲜度 + 进程存活 交叉推导，单元测试覆盖（`npm test`，40 项）。
- **交互细节**：鼠标穿透（不挡底下应用）、拖拽移位、右下角手柄连续缩放、气泡栈可最小化、菜单栏托盘开关、设置持久化。
- **打包**：`npm run pack` 产出可双击的 macOS `.app`（菜单栏 App、不占 Dock）；单色 Clawd template 菜单栏图标，按亮/暗栏自动适配。

### 安全
- 纯本地只读，从不写入或修改任何 `~/.claude` 文件或 Claude 配置；不外传 transcript 内容。
- 实时用量默认关闭，避免首次运行静默联网 / 读凭据。

[0.1.0]: https://github.com/Strangelight-Merser/clawd-pets/releases/tag/v0.1.0
