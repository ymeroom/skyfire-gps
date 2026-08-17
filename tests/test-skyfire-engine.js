/**
 * test-skyfire-engine.js - 測試 SkyFireEngine 大氣光學火燒雲物理評分引擎
 */

const assert = require('assert');
const SkyFireEngine = require('../js/skyfire-engine.js');

console.log('--- 🧪 測試 2: SkyFireEngine 大氣物理模型測試 ---');

// 1. 史詩級大景情境 (理想高雲 55%、中雲 40%、低雲 10%、高能見度 30km、透光窗 90%)
const epicResult = SkyFireEngine.calculate({
  highCloud: 55,
  midCloud: 40,
  lowCloud: 10,
  totalCloud: 65,
  visibility: 30000,
  humidity: 60,
  precipProb: 0,
  horizonClearance: 90,
  type: 'sunset',
  locationName: '高美濕地'
});

assert(epicResult.score >= 82, `理想條件應評為 EPIC (>=82 分)，實際得分: ${epicResult.score}`);
assert.strictEqual(epicResult.rating.level, 'EPIC', '評級應為 EPIC');
assert(epicResult.photoTips.whiteBalance, '應提供攝影白平衡建議');
assert(epicResult.diagnostics.length >= 4, '應包含至少 4 項物理診斷指標');
console.log('✅ 史詩級大景 (EPIC) 評分正確:', epicResult.score, '分 -', epicResult.rating.badge);

// 2. 厚重陰雨天情境 (低雲 90%、降雨率 80%、能見度 5km)
const overcastResult = SkyFireEngine.calculate({
  highCloud: 10,
  midCloud: 20,
  lowCloud: 90,
  totalCloud: 100,
  visibility: 5000,
  humidity: 95,
  precipProb: 80,
  type: 'sunset'
});

assert(overcastResult.score <= 20, `厚低雲陰雨天應壓制在低分 (<=20 分)，實際得分: ${overcastResult.score}`);
assert.strictEqual(overcastResult.rating.level, 'OVERCAST', '評級應為 OVERCAST');
console.log('✅ 陰雨天 (OVERCAST) 壓制邊界正確:', overcastResult.score, '分 -', overcastResult.rating.badge);

// 3. 晴空無雲邊界測試 (高雲 0%、中雲 0%、低雲 0%)
const clearSkyResult = SkyFireEngine.calculate({
  highCloud: 0,
  midCloud: 0,
  lowCloud: 0,
  totalCloud: 0,
  visibility: 35000,
  humidity: 50,
  precipProb: 0,
  type: 'sunset'
});

assert(clearSkyResult.score <= 35, `完全無雲不屬於火燒雲，分數應 <= 35，實際得分: ${clearSkyResult.score}`);
console.log('✅ 晴空無雲 (非火燒雲) 防呆邊界正確:', clearSkyResult.score, '分');

// 4. 低雲出景殺手測試 (低雲 > 85% 強制壓制至 <= 15)
const lowCloudKiller = SkyFireEngine.calculate({
  highCloud: 70,
  midCloud: 50,
  lowCloud: 88,
  totalCloud: 95,
  visibility: 25000,
  type: 'sunset'
});

assert(lowCloudKiller.score <= 15, `低雲 > 85% 應強制限制在 15 分以下，實際得分: ${lowCloudKiller.score}`);
console.log('✅ 低雲阻擋遮蔽扣分強制壓制正確:', lowCloudKiller.score, '分');

// 5. 評級分界連續性測試 (5 個等級齊全)
const levels = ['EPIC', 'GREAT', 'MODERATE', 'FAINT', 'OVERCAST'];
[95, 75, 55, 35, 10].forEach((testScore, idx) => {
  const r = SkyFireEngine.getRatingLevel(testScore);
  assert.strictEqual(r.level, levels[idx], `分數 ${testScore} 應對應等級 ${levels[idx]}`);
  assert(r.color, '評級應具備顏色屬性');
  assert(r.badge, '評級應具備標籤徽章');
});
console.log('✅ 評級區間連續性校驗完全吻合');

console.log('🎉 SkyFireEngine 所有測試案例全數 PASS!\n');
