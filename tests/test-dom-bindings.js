/**
 * test-dom-bindings.js - 靜態掃描 index.html 與 app.js，確保所有 DOM ID 綁定皆存在
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- 🧪 測試 5: DOM ID 靜態綁定與無死角掃描 ---');

const htmlPath = path.join(__dirname, '../index.html');
const jsPath = path.join(__dirname, '../js/app.js');
const cameraPath = path.join(__dirname, '../camera.html');

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const jsContent = fs.readFileSync(jsPath, 'utf8');
const cameraContent = fs.readFileSync(cameraPath, 'utf8');

// 找出 app.js 中所有 document.getElementById('xxx')
const getElementRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
let match;
const usedIds = new Set();

while ((match = getElementRegex.exec(jsContent)) !== null) {
  usedIds.add(match[1]);
}

console.log(`在 app.js 中檢測到 ${usedIds.size} 個 DOM ID 引用。`);

// 逐一檢查 index.html 中是否存在 id="xxx"
const missingIds = [];
usedIds.forEach(id => {
  const idRegex = new RegExp(`id=['"]${id}['"]`);
  if (!idRegex.test(htmlContent)) {
    missingIds.push(id);
  }
});

if (missingIds.length > 0) {
  console.error('❌ 發現遺失的 DOM ID:', missingIds);
  assert.fail(`index.html 缺少以下在 app.js 中使用的 DOM ID: ${missingIds.join(', ')}`);
} else {
  console.log('✅ 所有 app.js 引用的 DOM ID 在 index.html 中皆 100% 存在且吻合！');
}

// 檢查靜態資源引入與相依順序
const scopeScriptIndex = htmlContent.indexOf('js/taiwan-scope.js');
const appScriptIndex = htmlContent.indexOf('js/app.js');
assert(scopeScriptIndex >= 0, 'HTML 應引入 taiwan-scope.js');
assert(scopeScriptIndex < appScriptIndex, 'taiwan-scope.js 應在 app.js 前載入');
assert(htmlContent.includes('js/solar-calc.js'), 'HTML 應引入 solar-calc.js');
assert(htmlContent.includes('js/skyfire-engine.js'), 'HTML 應引入 skyfire-engine.js');
assert(htmlContent.includes('js/geocoding.js'), 'HTML 應引入 geocoding.js');
assert(htmlContent.includes('js/spots-taiwan.js'), 'HTML 應引入 spots-taiwan.js');
assert(htmlContent.includes('js/weather-service.js'), 'HTML 應引入 weather-service.js');
assert(htmlContent.includes('js/app.js'), 'HTML 應引入 app.js');

const cameraScopeScriptIndex = cameraContent.indexOf('js/taiwan-scope.js');
const cameraInlineScriptIndex = cameraContent.indexOf('<script>', cameraScopeScriptIndex);
assert(cameraScopeScriptIndex >= 0, '相機頁應引入 taiwan-scope.js');
assert(cameraInlineScriptIndex > cameraScopeScriptIndex, '相機頁應先載入 TaiwanScope 再執行 GPS 程式');
assert(
  cameraContent.includes('TaiwanScope.formatGpsLocation'),
  '相機頁 GPS 標籤必須經過台灣服務範圍驗證'
);

console.log('✅ 靜態 JS 模組相依性載入順序校驗通過');

console.log('🎉 DOM 綁定完整性測試全數 PASS!\n');

// 決策優先版面：骨架與錨點必須齊備
const decisionIds = [
  'decisionHero', 'decisionScoreNum', 'decisionGaugeFill', 'decisionVerdictBadge',
  'decisionVerdictLine', 'decisionReasonText', 'decisionPrimaryBtn', 'decisionSecondaryBtn',
  'decisionCountdown', 'decisionPeakTime', 'otherSpotsTitle', 'otherSpotsList',
  'otherSpotsNote', 'deepDiveNav'
];
const missingDecisionIds = decisionIds.filter(id => !new RegExp(`id=['"]${id}['"]`).test(htmlContent));
assert.strictEqual(missingDecisionIds.length, 0, `index.html 缺少決策區 DOM ID: ${missingDecisionIds.join(', ')}`);

// 決策區必須排在既有儀表板之前（首屏只回答一個問題）
const decisionIndex = htmlContent.indexOf('id="decisionHero"');
const heroGridIndex = htmlContent.indexOf('class="hero-dashboard-grid"');
assert(decisionIndex >= 0 && heroGridIndex >= 0, '兩個區塊都應存在');
assert(decisionIndex < heroGridIndex, '決策區應插在 hero-dashboard-grid 之前');

// 四個入口的錨點目標都必須真的存在於同一頁（方案 A：同頁錨點，不新增頁面）
['cloudProfileSection', 'forecast7daySection', 'interactiveMapSection', 'verifySection']
  .forEach((anchorId) => {
    assert(new RegExp(`id=['"]${anchorId}['"]`).test(htmlContent), `錨點目標 #${anchorId} 應存在`);
    assert(htmlContent.includes(`href="#${anchorId}"`), `入口列應有連往 #${anchorId} 的連結`);
  });

// decision-hero.js 必須在 app.js 之前載入
const decisionScriptIndex = htmlContent.indexOf('js/decision-hero.js');
assert(decisionScriptIndex >= 0, 'HTML 應引入 decision-hero.js');
assert(decisionScriptIndex < htmlContent.indexOf('js/app.js'), 'decision-hero.js 應在 app.js 前載入');

// 文案不得寫死站數（逐時段 7 站 / 6 站，其中 12 站有分數）
assert(!/13\s*(個|站)/.test(htmlContent), 'index.html 不應寫死「13 個/13 站」');
// 全站正字為「巔峰」
assert(!htmlContent.includes('顛峰'), 'index.html 不應出現錯字「顛峰」');

console.log('✅ 決策優先版面骨架、錨點與載入順序皆正確');
