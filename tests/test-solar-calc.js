/**
 * test-solar-calc.js - 測試 SolarCalc 天文太陽計算算法
 */

const assert = require('assert');
const SolarCalc = require('../js/solar-calc.js');

console.log('--- 🧪 測試 1: SolarCalc 天文算法測試 ---');

// 1. 台北測試
const taipeiDate = new Date('2026-08-16T12:00:00+08:00');
const taipeiTimes = SolarCalc.getTimes(taipeiDate, 25.0330, 121.5654);

assert(taipeiTimes.sunrise instanceof Date, '日出時間應為 Date 物件');
assert(taipeiTimes.sunset instanceof Date, '日落時間應為 Date 物件');
assert(taipeiTimes.sunrise < taipeiTimes.sunset, '日出時間必須早於日落時間');
assert(taipeiTimes.sunriseSkyfireWindow, '應包含晨霞火燒雲觀測窗口');
assert(taipeiTimes.sunsetSkyfireWindow, '應包含晚霞火燒雲觀測窗口');
assert(taipeiTimes.sunsetSkyfireWindow.peak > taipeiTimes.sunset, '日落火燒雲顛峰應在日落當刻或稍後');

console.log('✅ 台北日出/日落與火燒雲窗口計算正確:', {
  sunrise: SolarCalc.formatTime(taipeiTimes.sunrise),
  sunset: SolarCalc.formatTime(taipeiTimes.sunset),
  sunsetSkyfirePeak: SolarCalc.formatTime(taipeiTimes.sunsetSkyfireWindow.peak)
});

// 2. 太陽方位角與高度角測試
const noonPos = SolarCalc.getPosition(new Date('2026-08-16T12:00:00+08:00'), 25.0330, 121.5654);
const sunsetPos = SolarCalc.getPosition(taipeiTimes.sunset, 25.0330, 121.5654);

assert(noonPos.azimuth >= 0 && noonPos.azimuth <= 360, '方位角應在 0 到 360 度之間');
assert(noonPos.elevation > 50, '台北夏季正午太陽仰角應偏高');
assert(Math.abs(sunsetPos.elevation) <= 5, '日落當刻太陽高度角應接近地平線 (0°)');
assert(sunsetPos.azimuth >= 260 && sunsetPos.azimuth <= 310, '台北夏季日落方位角應在西北西 (270°-300°)');

console.log('✅ 太陽方位角與高度角計算精確:', {
  noonElevation: noonPos.elevation + '°',
  sunsetElevation: sunsetPos.elevation + '°',
  sunsetAzimuth: sunsetPos.azimuth + '° (' + sunsetPos.azimuthCompass + ')'
});

// 3. 台灣不同區域與離島經緯度測試
const spots = [
  { name: '高雄', lat: 22.6273, lng: 120.3014 },
  { name: '澎湖', lat: 23.5711, lng: 119.5793 },
  { name: '金門', lat: 24.4493, lng: 118.3767 }
];

spots.forEach(spot => {
  const times = SolarCalc.getTimes(taipeiDate, spot.lat, spot.lng);
  assert(times.sunrise && times.sunset, `${spot.name} 計算應成功`);
  const pos = SolarCalc.getPosition(times.sunset, spot.lat, spot.lng);
  assert(pos.azimuth >= 0 && pos.azimuth <= 360, `${spot.name} 方位角應有效`);
  console.log(`✅ ${spot.name} 計算通過: 日出 ${SolarCalc.formatTime(times.sunrise)} / 日落 ${SolarCalc.formatTime(times.sunset)}`);
});

// 4. 輔助函式測試
assert.strictEqual(SolarCalc.formatTime(null), '--:--');
assert.strictEqual(SolarCalc.formatTime(new Date('invalid')), '--:--');
console.log('✅ 時間格式化防呆測試通過');

console.log('🎉 SolarCalc 所有測試案例全數 PASS!\n');
