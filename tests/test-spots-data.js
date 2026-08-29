/**
 * test-spots-data.js - 驗證全台 20 大攝影聖地資料完整度與經緯度邊界
 */

const assert = require('assert');
const TAIWAN_SPOTS = require('../js/spots-taiwan.js');

console.log('--- 🧪 測試 4: 全台 20 大攝影聖地資料庫測試 ---');

assert.strictEqual(TAIWAN_SPOTS.length, 20, '應包含 20 大全台經典攝影熱點');

const requiredFields = ['id', 'name', 'region', 'category', 'lat', 'lng', 'elevation', 'bestAzimuth', 'difficulty', 'recommendedFocal', 'description', 'traffic', 'tags'];
const validRegions = ['north', 'central', 'south', 'east', 'island'];
const validCategories = ['sunset', 'sunrise', 'both'];

TAIWAN_SPOTS.forEach(spot => {
  // 檢查所有必填欄位
  requiredFields.forEach(field => {
    assert(spot[field] !== undefined && spot[field] !== '', `景點 [${spot.name}] 缺少欄位: ${field}`);
  });

  // 檢查經緯度範圍（台灣本島及周邊離島範圍：緯度 21.8°N - 25.5°N，經度 119.5°E - 122.0°E）
  assert(spot.lat >= 21.5 && spot.lat <= 25.6, `景點 [${spot.name}] 緯度超出台灣範圍: ${spot.lat}`);
  assert(spot.lng >= 119.4 && spot.lng <= 122.2, `景點 [${spot.name}] 經度超出台灣範圍: ${spot.lng}`);

  // 檢查分類與地區
  assert(validRegions.includes(spot.region), `景點 [${spot.name}] 地區無效: ${spot.region}`);
  assert(validCategories.includes(spot.category), `景點 [${spot.name}] 類別無效: ${spot.category}`);
  assert(Array.isArray(spot.tags) && spot.tags.length > 0, `景點 [${spot.name}] 標籤應為非空陣列`);
});

console.log('✅ 20 大攝影聖地經緯度座標、地區分類與參數完整性全數檢驗合格');

console.log('🎉 攝影聖地資料庫測試全數 PASS!\n');
