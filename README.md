<p align="center">
  <img src="assets/icon.png" width="116" alt="Clawd Pets — the orange Clawd mascot on a dark squircle">
</p>

<h1 align="center">Clawd Pets</h1>

<p align="center">
  <b>An always-on-top desktop pet that watches <i>all</i> your Claude tasks at a glance.</b><br>
  Live progress, status, and real-time usage across Claude Cowork, Claude Code, and your terminals — read-only and local-first.
</p>

<p align="center">
  <a href="https://github.com/Strangelight-Merser/clawd-pets/releases"><img alt="platform: macOS" src="https://img.shields.io/badge/platform-macOS-111111?logo=apple&logoColor=white"></a>
  <a href="https://www.electronjs.org/"><img alt="Electron 33" src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white"></a>
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-3b82f6"></a>
  <a href="#-privacy--security"><img alt="read-only · local-first" src="https://img.shields.io/badge/read--only-·_local--first-3ddc97"></a>
  <a href="#-privacy--security"><img alt="zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-3ddc97"></a>
  <a href="https://github.com/Strangelight-Merser/clawd-pets/actions/workflows/ci.yml"><img alt="tests" src="https://github.com/Strangelight-Merser/clawd-pets/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <picture>
    <source srcset="assets/demo.gif" type="image/gif">
    <img src="assets/demo.png" width="640" alt="Clawd Pets — the desktop pet with a live multi-task status stack above it">
  </picture>
</p>

<p align="center">
  <sub>The pet sits in a corner of your screen. Each live task stacks above it as one row.</sub>
</p>

<p align="center">
  <sub>🌏 中文说明见 <a href="README.zh-CN.md">README.zh-CN.md</a></sub>
</p>

---

You run Claude in a lot of places — a couple of **Cowork** sessions, **Claude Code** in two terminals, an agent in your IDE — and then you spend the next ten minutes alt-tabbing between windows to babysit them. You miss the one that **finished**. You miss the one that **errored** and is just sitting there. You miss the one quietly **waiting on you**, or the one that just **hit a rate limit**.

**Clawd Pets** puts all of it into one tiny, always-on-top creature that floats above everything. It's **Clawd** — Claude Code's orange pixel mascot — sitting on your desktop, watching every task and changing color the moment something needs you. One glance at the corner of your screen tells you who's running, who's done, who's stuck, and who's waiting on you.

Inspired by OpenAI's [Codex Pets](#-credits), built for the Claude ecosystem: it watches Cowork + Code + terminal all at once. No more window roulette — just look at the pet.

> **Read-only & local-first.** Clawd Pets only *reads* files under `~/.claude` and your Claude app data — it never writes or changes any Claude config, and your transcript content never leaves your machine. The optional usage feature is off by default; its OAuth token is header-only, never stored, never logged. **Zero runtime npm dependencies.**

## ✨ Features

### 🐾 The official Clawd mascot, alive
This is **Clawd** — Claude Code's official orange pixel mascot — with its pixel geometry reproduced **1:1** from the official asset. It's alive, not a static sprite:

- **Mood glow** that reflects what's happening: `idle · thinking · working · done · needs-you · error`.
- **Continuous breathing**, **random blinking**, and **eyes that track your cursor**.
- **Falls asleep** when you're idle, and wakes up when there's something to show.

### 📚 Multi-task live status stack
Every in-progress or attention-needing session shows up as **one row, stacked right above the pet**:

- **Main line** — the task's current thinking-chain narration, pulled live from the transcript.
- **Sub line** — the task name · the current tool action (e.g. *"Restart Electron and verify clean boot"*).
- **Sorted by what matters** — `error` / `rate-limit` / `awaiting-you` float to the top, `running` next, `done` settles at the bottom. The stuff that needs you is always where you look first.
- **Never flickers** — rows update *in place* via keyed DOM reconciliation, so the stack stays calm even as a dozen tasks churn.
- **Minimizable** — collapse it down to just the pet when you want quiet.

### 📊 Real-time usage limits *(optional, off by default)*
Opt in from the tray to see your **real** quota utilization — `5h` · `weekly` · `Sonnet` · `Opus` — each with a live reset countdown, straight from Anthropic's official OAuth usage endpoint. When any quota hits **≥ 90%**, the pet **turns red** as an early warning, so you can wrap up a run *before* it gets cut off mid-thought. (See [Real-time usage](#-real-time-usage-optional) for exactly how the token is handled.)

### 🖱️ Stays out of your way
- **Transparent window with mouse click-through** — it never blocks the apps underneath. Clicks only land when your pointer is actually on the pet, a row, or a panel.
- **Drag to move**, and a **drag handle to resize** the pet to taste.
- **Menu-bar tray menu** for everything: window time range, refresh rate, live usage, motion, and size toggles.
- **Settings persist** across restarts.
- **Pure menu-bar app** — no Dock icon cluttering things up.

## 🚀 Quick start

Requires **macOS** and **Node.js ≥ 18**.

```bash
git clone https://github.com/Strangelight-Merser/clawd-pets.git
cd clawd-pets
npm install        # installs Electron (zero runtime deps of our own)
npm run app        # builds + installs "Clawd Pets.app" into /Applications + opens it
```

That's it. After `npm run app`, **"Clawd Pets.app" lives in /Applications** — launch it from **Launchpad / Spotlight / Finder** like any other Mac app. A monochrome Clawd appears in your menu bar, and the pet appears on your desktop.

> **Prefer not to build?** Grab a prebuilt `.app` from the [**Releases**](https://github.com/Strangelight-Merser/clawd-pets/releases) page.
>
> The build is unsigned, so on first launch macOS will refuse to open it. Either **right-click the app → Open → Open**, or clear the quarantine flag:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Clawd Pets.app"
> ```

**For development:**

```bash
npm start          # run the pet directly, without installing
npm test           # run the state-inference unit suite (40 tests · node --test)
```

## 🧠 How it works

Here's the part worth knowing before you trust a status indicator with your attention.

**Claude's transcript files contain no explicit "running" or "error" status flag.** There is no field to read. So Clawd Pets *infers* each task's state — carefully — by cross-checking several independent signals:

1. **The transcript tail** — what the session was doing in its last few entries.
2. **Whether the last tool call actually returned** — an open tool call means it's still working.
3. **File mtime freshness** — how recently the transcript was touched.
4. **Process liveness** — whether the owning process is still alive.

No single signal is trusted on its own; they're combined so a stalled task doesn't masquerade as a running one, and a quiet-but-busy task doesn't get marked done. **This inference engine is covered by 40 unit tests** (`npm test` / `node --test`) — because a monitoring tool that's confidently wrong is worse than no tool at all.

Updates are **event-driven**: `fs.watch` on the relevant directories means the moment a file changes, state recomputes — near-real-time, no busy polling.

**Data sources** (all local, all read-only):

| Source | What it covers |
| --- | --- |
| `~/.claude/projects/<enc-cwd>/<id>.jsonl` | Terminal sessions & Claude Code |
| Legacy Cowork session JSON | Older Cowork sessions |
| Sandbox Cowork `audit.jsonl` | New Cowork sessions — includes **real** `total_cost_usd` |

## 🔒 Privacy & security

Trust is the whole point, so here's the short, honest version:

- **Read-only.** It only *reads* the files listed above under `~/.claude` and Claude's app data. It **never writes or changes** any Claude config — your setup is exactly as you left it.
- **Local-first.** Your transcript content is parsed **on your machine** to derive status, progress, and the current narration line. **None of it is ever sent anywhere.**
- **No surprise network calls.** Real-time usage is **off by default**. When you turn it on, the app talks only to `api.anthropic.com`.
- **Token hygiene.** The OAuth token used for the usage endpoint is placed in the request header *only* — it is **never stored** and **never logged**.
- **Zero runtime dependencies.** No third-party npm packages in production means a small, auditable surface you can read end to end.

## 📊 Real-time usage *(optional)*

This feature is **opt-in** and **off by default**.

When you enable **Live usage** from the tray menu, Clawd Pets calls Anthropic's official OAuth usage endpoint and shows your real **5h / weekly / Sonnet / Opus** utilization, each with a reset countdown. If any quota reaches **≥ 90%**, the pet turns **red** as an early warning.

How the token is handled, precisely:

- It is used **only** in the request `Authorization` header.
- It is **never written to disk** and **never logged**.
- Requests go **only** to `api.anthropic.com` — nowhere else.

If you'd rather not connect it at all, just leave it off; everything else works the same.

## ⚠️ Known limits

Being upfront about what this is and isn't:

- **macOS only** for now.
- **Status is inferred** (best-effort). The signals are cross-checked and unit-tested, but there's no ground-truth flag in the files, so edge cases exist — see [How it works](#-how-it-works).
- **Cost numbers differ by source.** For terminal / Claude Code sessions, the `$` figure is a **single-price estimate**, marked with a `~` — subscription plans are **not** billed per-token, so treat it as a rough order-of-magnitude. Sandbox Cowork sessions report the **real** cost (`total_cost_usd`).
- **Monitoring only.** It watches your tasks; it does not (yet) reply to or approve them on your behalf.

## 🙌 Credits

- Inspired by OpenAI's **Codex Pets** — Clawd Pets brings that always-glanceable companion idea to the Claude ecosystem.
- **"Clawd"** is the mascot Anthropic designed for Claude Code. This project reproduces its likeness with affection as a companion tool for the Claude ecosystem, and is an independent, unofficial project not affiliated with or endorsed by Anthropic. **The Clawd likeness belongs to Anthropic.**

## 📄 License

This project's own code is licensed under the [MIT License](LICENSE).

The **"Clawd" mascot likeness belongs to Anthropic** and is not covered by this project's MIT license.

---

<p align="center">
  <sub>If Clawd Pets saves you one alt-tab, consider giving it a ⭐ — it genuinely helps.</sub>
</p>

<p align="center">
  <sub>🌏 中文说明见 <a href="README.zh-CN.md">README.zh-CN.md</a></sub>
</p>
