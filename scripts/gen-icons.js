'use strict';
/*
 * 图标生成器（可重复运行，幂等）。从 src/renderer/index.html 提取官方 Clawd 几何，产出：
 *   assets/tray.png        菜单栏 template image @1x（纯黑剪影 + 镂空眼，真·透明底）
 *   assets/tray@2x.png     同上 @2x（nativeImage 按屏幕 DPI 自动选）
 *   assets/icon.png        .app/Dock 图标 1024（橙 Clawd + 深炭 squircle，四角透明）
 *   assets/icon.icns       同上，打包用（iconutil 合成）
 *
 * 关键：qlmanage 会把 SVG 合成到不透明白底（实测 tray 角落 alpha=255）→ 菜单栏会渲成白方块。
 * 故 qlmanage 只负责"画内容"，alpha 由本脚本接管：
 *   - 菜单栏：alpha = 255 − 亮度（白底/眼洞→透明，黑形状→不透明，AA 边缘按比例），RGB 归零（template 只看 alpha）。
 *   - 应用图标：保留 qlmanage 的彩色内容，alpha 用几何圆角遮罩（四角透明），透明处 RGB 填炭色防降采样渗色。
 * PNG 解码/编码、box 降采样全在 node 内做；仅 qlmanage(SVG→PNG) + iconutil(.icns) 用系统自带。
 * 跑：npm run icons
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

// ---- 提取官方 Clawd 几何 ----
const bodyM = html.match(/<g id="sprite"><path class="px" d="([^"]+)"/);
if (!bodyM) throw new Error('未找到 Clawd body path（index.html #sprite）');
const BODY = bodyM[1];
const EYES = [...html.matchAll(/<rect class="px" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
if (EYES.length !== 2) throw new Error('期望 2 个眼洞 rect，实得 ' + EYES.length);

const VB_W = 47, VB_H = 38;
const CHARCOAL = [31, 30, 29];   // #1f1e1d

function traySvg() {            // 黑剪影 + 镂空眼（mask 抠眼洞），qlmanage 会垫白底 → 后续 alpha=255−亮度 处理
  const pad = 7, side = VB_W + pad * 2, ox = pad, oy = (side - VB_H) / 2;
  const holes = EYES.map(e => `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="black"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}">
  <defs><mask id="m"><rect width="${side}" height="${side}" fill="black"/>
    <g transform="translate(${ox},${oy})"><path d="${BODY}" fill="white"/>${holes}</g>
  </mask></defs>
  <rect width="${side}" height="${side}" fill="black" mask="url(#m)"/>
</svg>`;
}
function appSvg() {             // 深炭圆角方 + 橙 Clawd（眼洞填炭看作镂空）；四角透明由后续几何遮罩处理
  const S = 1024, r = Math.round(S * 0.2237);
  const scale = (S * 0.6) / VB_W, cw = VB_W * scale, ch = VB_H * scale;
  const ox = (S - cw) / 2, oy = (S - ch) / 2;
  const holes = EYES.map(e => `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="#1f1e1d"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="${r}" ry="${r}" fill="#1f1e1d"/>
  <g transform="translate(${ox},${oy}) scale(${scale})"><path d="${BODY}" fill="#d97757"/>${holes}</g>
</svg>`;
}

// ---- PNG 解码（RGBA8）----
function decodePNG(file) {
  const b = fs.readFileSync(file);
  let o = 8, w, h, ct, bd, idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.slice(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    o += 12 + len;
  }
  if (ct !== 6 || bd !== 8) throw new Error(`期望 RGBA8，实得 ct=${ct} bd=${bd}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const bb = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[q++];
      if (f === 1) v = (v + a) & 255; else if (f === 2) v = (v + bb) & 255;
      else if (f === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (f === 4) { const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c); v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc) ? bb : c)) & 255; }
      out[y * stride + x] = v;
    }
  }
  return { w, h, data: out };
}

// ---- PNG 编码（RGBA8）----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- box 降采样（RGBA）----
function downscale(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
    const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    let r = 0, g = 0, bl = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * sw + xx) * 4; r += src[i]; g += src[i + 1]; bl += src[i + 2]; a += src[i + 3]; n++; }
    const o = (y * dw + x) * 4; out[o] = r / n | 0; out[o + 1] = g / n | 0; out[o + 2] = bl / n | 0; out[o + 3] = a / n | 0;
  }
  return out;
}

// ---- qlmanage：SVG → RGBA（仅取内容，alpha 后处理）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-icons-'));
const QL = path.join(TMP, 'ql'); fs.mkdirSync(QL, { recursive: true });
function qlRaster(svg, size, tag) {
  const sp = path.join(TMP, tag + '.svg'); fs.writeFileSync(sp, svg);
  execFileSync('qlmanage', ['-t', '-s', String(size), '-o', QL, sp], { stdio: 'ignore' });
  const produced = path.join(QL, path.basename(sp) + '.png');
  if (!fs.existsSync(produced)) throw new Error('qlmanage 未产出: ' + produced);
  return decodePNG(produced);
}

// 圆角方 SDF：点(px,py)在边长 S、角半径 rx 的圆角方内 → true
function inRoundRect(px, py, S, rx) {
  const hw = S / 2, cx = Math.abs(px - hw) - (hw - rx), cy = Math.abs(py - hw) - (hw - rx);
  const out = Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) + Math.min(Math.max(cx, cy), 0) - rx;
  return out <= 0;
}

fs.mkdirSync(ASSETS, { recursive: true });

// ===== 菜单栏 template：alpha = 255 − 亮度，RGB 归零 =====
{
  const m = qlRaster(traySvg(), 256, 'tray');   // 黑 Clawd on 白底
  const buf = Buffer.alloc(m.w * m.h * 4);
  for (let i = 0; i < m.w * m.h; i++) {
    const lum = m.data[i * 4];                  // 灰度图 R=G=B
    buf[i * 4] = 0; buf[i * 4 + 1] = 0; buf[i * 4 + 2] = 0;
    buf[i * 4 + 3] = 255 - lum;                 // 白→0(透明) 黑→255(不透明) 灰边→按比例
  }
  for (const [sz, name] of [[18, 'tray.png'], [36, 'tray@2x.png']]) {
    fs.writeFileSync(path.join(ASSETS, name), encodePNG(sz, sz, downscale(buf, m.w, m.h, sz, sz)));
  }
}

// ===== 应用图标：保留 qlmanage 彩色内容，alpha 用几何圆角遮罩（四角透明）=====
let appMaster;
{
  const S = 1024, rx = Math.round(S * 0.2237), SS = 3;   // 3x3 超采样遮罩边缘
  const m = qlRaster(appSvg(), S, 'app');
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let cov = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++)
      if (inRoundRect(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, S, rx)) cov++;
    cov /= SS * SS;
    const i = (y * S + x) * 4;
    if (cov > 0) { buf[i] = m.data[i]; buf[i + 1] = m.data[i + 1]; buf[i + 2] = m.data[i + 2]; }
    else { buf[i] = CHARCOAL[0]; buf[i + 1] = CHARCOAL[1]; buf[i + 2] = CHARCOAL[2]; }   // 透明处填炭色，防降采样渗白
    buf[i + 3] = Math.round(cov * 255);
  }
  appMaster = { w: S, h: S, data: buf };
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePNG(S, S, buf));
}

// ===== .icns =====
{
  const iconset = path.join(TMP, 'icon.iconset'); fs.mkdirSync(iconset, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), encodePNG(s, s, downscale(appMaster.data, appMaster.w, appMaster.h, s, s)));
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), encodePNG(s * 2, s * 2, downscale(appMaster.data, appMaster.w, appMaster.h, s * 2, s * 2)));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')], { stdio: 'ignore' });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('✓ 生成: assets/tray.png, tray@2x.png, icon.png, icon.icns');
for (const f of ['tray.png', 'tray@2x.png', 'icon.png', 'icon.icns']) {
  console.log(`  ${f.padEnd(14)} ${fs.statSync(path.join(ASSETS, f)).size} bytes`);
}
