'use strict';
/*
 * 极简设置持久化：JSON 落 app.getPath('userData')/settings.json，无第三方依赖。
 * main 启动时 init(userDataDir) 读回；托盘/拖拽改动时 set() 防抖落盘。
 */
const fs = require('fs');
const path = require('path');

let file = null;
let cache = {};
let timer = null;

function init(dir) {
  file = path.join(dir, 'settings.json');
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); cache = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }  // 仅接受对象；数字/数组/字符串等非法内容归零，避免后续 set 抛错
  catch { cache = {}; }
  return cache;
}
function get(k, dflt) { return (cache && Object.prototype.hasOwnProperty.call(cache, k)) ? cache[k] : dflt; }
function write() { if (file) { try { fs.writeFileSync(file, JSON.stringify(cache, null, 2)); } catch {} } }
function set(k, v) {
  if (!cache) cache = {};
  cache[k] = v;
  if (!file) return;
  clearTimeout(timer);
  timer = setTimeout(write, 400);  // 防抖：拖拽/缩放会高频调用
}
function flush() { clearTimeout(timer); write(); }  // 退出前同步刷盘，防丢最后一次改动

module.exports = { init, get, set, flush };
