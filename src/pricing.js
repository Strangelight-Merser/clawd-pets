'use strict';
// 每 1M token 单价 [input, output]（claude-api 技能表，2026-05 缓存：读≈0.1×输入、写≈1.25×输入）
// 仅用于 ①② 的成本估算；③ 沙箱有真实 total_cost_usd。订阅制不按此计费，仅作量级参考。
module.exports = {
  fable: [10, 50],
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
};
