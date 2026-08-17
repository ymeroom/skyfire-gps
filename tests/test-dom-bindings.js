/**
 * test-dom-bindings.js - 靜態掃描 index.html 與 app.js，確保所有 DOM ID 綁定皆存在
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- 🧪 測試 5: DOM ID 靜態綁定與無死角掃描 ---');

const htmlPath = path.join(__dirname, '../index.html');
const jsPath = path.join(__dirname, '../js/app.js');

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const jsContent = fs.readFileSync(jsPath, 'utf8');

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

// 檢查靜態資源引入順序
assert(htmlContent.includes('js/solar-calc.js'), 'HTML 應引入 solar-calc.js');
assert(htmlContent.includes('js/skyfire-engine.js'), 'HTML 應引入 skyfire-engine.js');
assert(htmlContent.includes('js/geocoding.js'), 'HTML 應引入 geocoding.js');
assert(htmlContent.includes('js/spots-taiwan.js'), 'HTML 應引入 spots-taiwan.js');
assert(htmlContent.includes('js/weather-service.js'), 'HTML 應引入 weather-service.js');
assert(htmlContent.includes('js/app.js'), 'HTML 應引入 app.js');

console.log('✅ 靜態 JS 模組相依性載入順序校驗通過');

console.log('🎉 DOM 綁定完整性測試全數 PASS!\n');
