/**
 * test-taiwan-scope.js - 台灣限定服務範圍測試
 */

const assert = require('assert');
const taiwanSpots = require('../js/spots-taiwan.js');

let TaiwanScope = null;
try {
  TaiwanScope = require('../js/taiwan-scope.js');
} catch (error) {
  // RED phase: the production module does not exist yet.
}

console.log('--- 🧪 測試 6: 台灣限定服務範圍 ---');

assert(TaiwanScope, '應提供 TaiwanScope 台灣服務範圍模組');

const supportedLocations = [
  { name: '台北 101', lat: 25.0330, lng: 121.5654 },
  { name: '日月潭', lat: 23.8697, lng: 120.9189 },
  { name: '澎湖奎壁山', lat: 23.6015, lng: 119.6710 },
  { name: '金門', lat: 24.4493, lng: 118.3767 },
  { name: '馬祖南竿', lat: 26.1598, lng: 119.9517 },
  { name: '烏坵', lat: 24.9918, lng: 119.4510 },
  { name: '綠島', lat: 22.6617, lng: 121.4933 },
  { name: '蘭嶼', lat: 22.0567, lng: 121.5500 }
];

supportedLocations.forEach(({ name, lat, lng }) => {
  assert.strictEqual(TaiwanScope.contains(lat, lng), true, `${name} 應位於台灣服務範圍`);
});

taiwanSpots.forEach(({ name, lat, lng }) => {
  assert.strictEqual(
    TaiwanScope.contains(lat, lng),
    true,
    `內建景點 ${name} 應位於台灣服務範圍`
  );
});

const unsupportedLocations = [
  { name: '東京', lat: 35.6762, lng: 139.6503 },
  { name: '倫敦', lat: 51.5074, lng: -0.1278 },
  { name: '上海', lat: 31.2304, lng: 121.4737 },
  { name: '廈門', lat: 24.4798, lng: 118.0894 },
  { name: '台灣海峽', lat: 23.5000, lng: 120.0500 },
  { name: '台灣東南外海', lat: 21.7500, lng: 122.1500 },
  { name: '廈門東岸', lat: 24.4800, lng: 118.1800 }
];

unsupportedLocations.forEach(({ name, lat, lng }) => {
  assert.strictEqual(TaiwanScope.contains(lat, lng), false, `${name} 不應位於台灣服務範圍`);
});

assert.strictEqual(TaiwanScope.contains(NaN, 121), false, 'NaN 座標應被拒絕');
assert.strictEqual(TaiwanScope.contains(25, Infinity), false, '無限大座標應被拒絕');
assert.strictEqual(TaiwanScope.contains('25.03', 121.56), false, '字串座標應被拒絕');

assert.strictEqual(
  TaiwanScope.formatGpsLocation(25.0330, 121.5654),
  'GPS: 25.033°N, 121.565°E',
  '台灣服務範圍內的 GPS 應產生拍立得位置標籤'
);
assert.strictEqual(
  TaiwanScope.formatGpsLocation(35.6762, 139.6503),
  null,
  '台灣服務範圍外的 GPS 不應產生拍立得位置標籤'
);

console.log('🎉 TaiwanScope 台灣範圍測試全數 PASS!\n');
