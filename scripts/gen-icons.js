'use strict';
/*
 * 图标生成器（可重复运行，幂等）。从 src/renderer/index.html 提取官方 Clawd 几何，产出：
 *   assets/tray.png        菜单栏 template image @1x（纯黑剪影 + 镂空眼，透明底）
 *   assets/tray@2x.png     同上 @2x（nativeImage 按屏幕 DPI 自动选）
 *   assets/icon.png        .app/Dock 图标 1024（橙 Clawd + 深色 squircle）
 *   assets/icon.icns       同上，打包用（iconutil 合成）
 * 仅依赖 macOS 自带：qlmanage(SVG→PNG)/sips(缩放)/iconutil(.icns)。
 * 跑：npm run icons
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

// ---- 从 index.html 提取官方 Clawd 几何（单一事实来源，避免漂移）----
const bodyM = html.match(/<g id="sprite"><path class="px" d="([^"]+)"/);
if (!bodyM) throw new Error('未找到 Clawd body path（index.html #sprite）');
const BODY = bodyM[1];
const EYES = [...html.matchAll(/<rect class="px" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
if (EYES.length !== 2) throw new Error('期望 2 个眼洞 rect，实得 ' + EYES.length);

const VB_W = 47, VB_H = 38;   // 官方 clawd.svg viewBox

// 菜单栏：方形画布、Clawd 按宽留白居中；黑剪影 + 镂空眼（用 mask 抠出眼洞）
function traySvg() {
  const pad = 7;
  const side = VB_W + pad * 2;            // 方形边长
  const ox = pad, oy = (side - VB_H) / 2;  // 居中偏移
  const eyeHoles = EYES.map(e => `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="black"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}">
  <defs><mask id="m">
    <rect width="${side}" height="${side}" fill="black"/>
    <g transform="translate(${ox},${oy})"><path d="${BODY}" fill="white"/>${eyeHoles}</g>
  </mask></defs>
  <rect width="${side}" height="${side}" fill="black" mask="url(#m)"/>
</svg>`;
}

// .app/Dock：深炭圆角方 + 橙 Clawd，眼洞填同色背景看作镂空
function appSvg() {
  const S = 1024, r = Math.round(S * 0.2237);   // Big Sur 风格圆角
  const scale = (S * 0.6) / VB_W;
  const cw = VB_W * scale, ch = VB_H * scale;
  const ox = (S - cw) / 2, oy = (S - ch) / 2;
  const eyeHoles = EYES.map(e => `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="#1f1e1d"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="${r}" ry="${r}" fill="#1f1e1d"/>
  <g transform="translate(${ox},${oy}) scale(${scale})"><path d="${BODY}" fill="#d97757"/>${eyeHoles}</g>
</svg>`;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-icons-'));
const QL = path.join(TMP, 'ql');
fs.mkdirSync(QL, { recursive: true });

// SVG → PNG：qlmanage 渲染大图（保 alpha），再 sips 精确缩放到目标方形尺寸
function raster(svg, size, outPng) {
  const svgPath = path.join(TMP, `s${size}_${Math.round(size)}.svg`);
  fs.writeFileSync(svgPath, svg);
  const renderAt = Math.max(size * 4, 256);   // 先渲大图再缩，边缘干净
  execFileSync('qlmanage', ['-t', '-s', String(renderAt), '-o', QL, svgPath], { stdio: 'ignore' });
  const produced = path.join(QL, path.basename(svgPath) + '.png');
  if (!fs.existsSync(produced)) throw new Error('qlmanage 未产出: ' + produced);
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  execFileSync('sips', ['-z', String(size), String(size), produced, '--out', outPng], { stdio: 'ignore' });
}

fs.mkdirSync(ASSETS, { recursive: true });
const tray = traySvg(), appI = appSvg();

// 1) 菜单栏 template（18 / 36）
raster(tray, 18, path.join(ASSETS, 'tray.png'));
raster(tray, 36, path.join(ASSETS, 'tray@2x.png'));

// 2) .app 1024 PNG
raster(appI, 1024, path.join(ASSETS, 'icon.png'));

// 3) .icns（iconset → iconutil）
const iconset = path.join(TMP, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) {
  raster(appI, s, path.join(iconset, `icon_${s}x${s}.png`));
  raster(appI, s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')], { stdio: 'ignore' });

fs.rmSync(TMP, { recursive: true, force: true });
console.log('✓ 生成: assets/tray.png, tray@2x.png, icon.png, icon.icns');
for (const f of ['tray.png', 'tray@2x.png', 'icon.png', 'icon.icns']) {
  const st = fs.statSync(path.join(ASSETS, f));
  console.log(`  ${f.padEnd(14)} ${st.size} bytes`);
}
