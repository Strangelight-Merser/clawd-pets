'use strict';
/*
 * 渲染端 i18n。默认英文（面向国际/外网）；系统语言为中文(zh-*)时切中文。
 * 可用 ?lang=en|zh 覆盖（用于生成英文演示图）。在 renderer.js 之前加载，暴露 window.T / window.LANG。
 */
(function () {
  var override = (location.search.match(/[?&]lang=([a-z-]+)/i) || [])[1];
  var nav = (override || navigator.language || 'en').toLowerCase();
  var lang = /^zh/.test(nav) ? 'zh' : 'en';
  var DICT = {
    en: {
      think: 'Thinking…',
      bErr: function (t) { return t + ' errored'; },
      bRate: function (t) { return t + ' hit a rate limit'; },
      bWait: function (t) { return t + ' needs you'; },
      bDone: function (t) { return t + ' done'; },
      more: function (n) { return '+' + n + ' more running'; },
      phaseDefault: 'Working',
      phaseRun: 'Running command', phaseEdit: 'Writing changes', phaseRead: 'Reading / searching',
      phaseTest: 'Running tests', phaseWeb: 'Browsing', phasePlan: 'Planning',
      state: { RUNNING: 'running', WAIT: 'waiting', AWAITING: 'done', IDLE: 'idle', ERROR: 'error', RATE: 'rate-limited' },
      rlLabel: '5h limit', empty: 'No active sessions in this window',
      active: 'active', stale: 'stale',
      out: 'out', estimate: 'estimate', liveFail: 'live usage unavailable',
      qb: { five_hour: '5-hour', seven_day: 'Weekly · all', seven_day_sonnet: 'Weekly · Sonnet', seven_day_opus: 'Weekly · Opus', seven_day_cowork: 'Weekly · Cowork' },
      extra: 'Extra usage', used: 'used', limit: 'limit',
      liveAge: function (a) { return 'live usage · ' + a + ' ago'; },
      reset: 'reset', wasReset: 'reset', overage: 'over',
      petTitle: function (n, needs, out) { return n + ' sessions · ' + needs + ' need you · ' + out + ' tok out'; },
      quotaUsed: function (label, util, remainStr) { return label + ' quota ' + util + '% used' + (remainStr ? ' · resets in ' + remainStr : ''); },
      tCollapse: 'Collapse', tMinimize: 'Minimize (Clawd only)', tResize: 'Drag to resize Clawd',
      openDir: 'Open project folder',
    },
    zh: {
      think: '思考中…',
      bErr: function (t) { return t + ' 出错了'; },
      bRate: function (t) { return t + ' 触发限流，等额度恢复'; },
      bWait: function (t) { return t + ' 在等你确认'; },
      bDone: function (t) { return t + ' 完成'; },
      more: function (n) { return '还有 ' + n + ' 个进行中'; },
      phaseDefault: '处理中',
      phaseRun: '运行命令', phaseEdit: '写改动', phaseRead: '读取/检索',
      phaseTest: '跑测试', phaseWeb: '联网/浏览', phasePlan: '整理计划',
      state: { RUNNING: '运行中', WAIT: '等你确认', AWAITING: '等输入', IDLE: '空闲', ERROR: '出错', RATE: '限流' },
      rlLabel: '5h 限额', empty: '窗口内无活跃会话',
      active: '活动中', stale: '久未处理',
      out: '输出', estimate: '订阅不计费', liveFail: '实时用量未取到',
      qb: { five_hour: '5 小时', seven_day: '每周·所有模型', seven_day_sonnet: '每周·Sonnet', seven_day_opus: '每周·Opus', seven_day_cowork: '每周·Cowork' },
      extra: '额外用量', used: '已用', limit: '上限',
      liveAge: function (a) { return '实时用量 · ' + a + '前'; },
      reset: '重置', wasReset: '已重置', overage: '超额',
      petTitle: function (n, needs, out) { return n + ' 个会话 · ' + needs + ' 需要你 · 出 ' + out + ' tok'; },
      quotaUsed: function (label, util, remainStr) { return label + '配额已用 ' + util + '%' + (remainStr ? ' · ' + remainStr + '后重置' : ''); },
      tCollapse: '收起', tMinimize: '最小化（只看 Clawd）', tResize: '拖动调整 Clawd 大小',
      openDir: '打开项目目录',
    },
  };
  window.LANG = lang;
  window.T = DICT[lang];
})();
