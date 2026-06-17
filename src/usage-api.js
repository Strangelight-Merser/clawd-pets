'use strict';
/*
 * 实时用量（可选，默认关闭）。
 * 调 Anthropic 官方未公开但客户端自用的 OAuth 用量端点，拿 5h/7d/Sonnet/Opus/Cowork 真实利用率%。
 * 方法参考开源可审计实现 jens-duttke/usage-monitor-for-claude（docs/api-reference.md）。
 *
 * 凭据：复用 Claude Code 已存好的 OAuth token —— 优先 $CLAUDE_CONFIG_DIR/.credentials.json 的
 * claudeAiOauth.accessToken；macOS 上该文件不存在时，从登录钥匙串读（会触发系统授权框 = 用户同意点）。
 * token 只用于 Authorization 头，绝不打印/落盘/外传第三方。仅与 api.anthropic.com 通信。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code', 'Claude-credentials', 'Claude'];

// 关键：此端点按 User-Agent 分限流桶——claude-code/<ver> 进宽松桶，其它任何 UA 进极严格桶→持续 429。
// 必须伪装成本机真实 Claude Code 版本；取不到则用已知有效的回退常量(仍是 claude-code/x 进宽松桶)。
const FALLBACK_UA = 'claude-code/2.1.85';
let uaCache = null;
function userAgent() {
  if (uaCache) return Promise.resolve(uaCache);
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10000 }, (err, stdout) => {
      const m = !err && stdout && String(stdout).trim().match(/(\d+\.\d+\.\d+)/);
      uaCache = m ? `claude-code/${m[1]}` : FALLBACK_UA;
      resolve(uaCache);
    });
  });
}

function credFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}
function pickToken(text) {
  try {
    const c = JSON.parse(text); const o = c.claudeAiOauth;
    if (o && o.accessToken) return { token: o.accessToken, exp: typeof o.expiresAt === 'number' ? o.expiresAt : 0 };
  } catch {}
  return null;
}
function tokenFromFile() {
  try { return pickToken(fs.readFileSync(credFile(), 'utf8')); } catch { return null; }
}
function keychainRaw(service) {
  // -w 读取密钥值时 macOS 会向用户弹钥匙串授权框（首次）。这是用户的同意点。不存在的 service 直接报错不弹框。
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'],
      { timeout: 8000 }, (err, stdout) => resolve(err || !stdout ? null : stdout.trim()));
  });
}
async function readToken() {
  const cands = [];                                  // 跨来源(文件 + 多个钥匙串 service)收集候选，优选未过期者
  const f = tokenFromFile(); if (f) cands.push(f);
  if (process.platform === 'darwin') for (const s of KEYCHAIN_SERVICES) { const raw = await keychainRaw(s); const t = raw && pickToken(raw); if (t) cands.push(t); }
  if (!cands.length) return null;
  const now = Date.now();
  const fresh = cands.find((c) => c.exp > now + 30000);   // 留 30s 余量；都过期则退回第一个(尽力一试)
  return (fresh || cands[0]).token;
}

function bucket(o) { return o && typeof o.utilization === 'number' ? { util: o.utilization, resetsAt: o.resets_at } : null; }
function normalize(j) {
  return {
    five_hour: bucket(j.five_hour),
    seven_day: bucket(j.seven_day),
    seven_day_sonnet: bucket(j.seven_day_sonnet),
    seven_day_opus: bucket(j.seven_day_opus),
    seven_day_cowork: bucket(j.seven_day_cowork),
    extra_usage: j.extra_usage || null,
  };
}

async function fetchUsage() {
  const token = await readToken();
  if (!token) return { ok: false, reason: 'no-token' };
  const ua = await userAgent();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);   // 端点是未公开接口，加超时防卡死
  try {
    const resp = await fetch(USAGE_URL, {
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': BETA,
        'User-Agent': ua,   // ← 修 429 的关键一行
      },
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'unauthorized' };
    if (resp.status === 429) {   // 透出 retry-after 供上层退避；退避期不再发请求，避免继续污染 token
      const ra = parseInt(resp.headers.get('retry-after') || '', 10);
      return { ok: false, reason: 'rate-limited', retryAfter: Number.isFinite(ra) ? Math.max(ra, 0) : null };
    }
    if (!resp.ok) return { ok: false, reason: 'http-' + resp.status };
    return { ok: true, quota: normalize(await resp.json()), fetchedAt: Date.now() };
  } catch (e) {
    return { ok: false, reason: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchUsage };
