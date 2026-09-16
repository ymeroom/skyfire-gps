/**
 * test-solar-calc.js - 測試 SolarCalc 天文太陽計算算法
 */

const assert = require('assert');
const SolarCalc = require('../js/solar-calc.js');
const TAIWAN_SPOTS = require('../js/spots-taiwan.js');

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

// 5. 地形視地平線與「實際見日」時刻
//    天文日出用的 -0.833° 是海平面無遮蔽的定義；西部與山區機位東方有中央山脈
//    擋著，太陽要再爬一段才看得見。剖面由 scripts/measure-sunrise-horizon.js
//    掃 DEM 量出，存在 spots-taiwan.js 的 sunriseHorizonProfile。

// 5-1 方位角內插
const demoProfile = [[64, 2.0], [70, 3.0], [76, 2.0]];
assert.strictEqual(SolarCalc.horizonAngleAt(demoProfile, 67), 2.5, '應在量測點之間線性內插');
assert.strictEqual(SolarCalc.horizonAngleAt(demoProfile, 70), 3.0, '量測點上應回傳該點值');
// 超出量測範圍夾在兩端，不外插 —— 外插會在冬至前後憑空長出角度
assert.strictEqual(SolarCalc.horizonAngleAt(demoProfile, 20), 2.0, '低於範圍應夾在首點');
assert.strictEqual(SolarCalc.horizonAngleAt(demoProfile, 200), 2.0, '高於範圍應夾在末點');
assert.strictEqual(SolarCalc.horizonAngleAt(null, 87), 0, '無剖面應回傳 0');
assert.strictEqual(SolarCalc.horizonAngleAt([], 87), 0, '空剖面應回傳 0');

const testDay = new Date('2026-09-16T00:00:00+08:00');

// 5-2 海平面機位 (剖面全 0) 不應產生任何延遲。
//     -0.833° 已含大氣折射與太陽視半徑，若再要求仰角爬到 0° 等於重算一次折射，
//     海邊機位會平白多出約 2.5 分鐘。
const seaSpot = TAIWAN_SPOTS.find(s => s.id === 'qixingtan');
const seaVisible = SolarCalc.getVisibleSunrise(testDay, seaSpot.lat, seaSpot.lng, seaSpot.sunriseHorizonProfile);
assert.strictEqual(seaVisible.delayMinutes, 0, '海平面機位不應有地形延遲');
assert.strictEqual(
  seaVisible.time.getTime(),
  SolarCalc.getTimes(testDay, seaSpot.lat, seaSpot.lng).sunrise.getTime(),
  '海平面機位的見日時刻應等於天文日出'
);

// 5-3 西部機位應延後約 10-20 分鐘 (實測 2026-09-16 望高寮 14.5 分)
const westSpot = TAIWAN_SPOTS.find(s => s.id === 'gaowangliao');
const westVisible = SolarCalc.getVisibleSunrise(testDay, westSpot.lat, westSpot.lng, westSpot.sunriseHorizonProfile);
assert(
  westVisible.delayMinutes >= 8 && westVisible.delayMinutes <= 25,
  `望高寮日出應因中央山脈延後 8-25 分鐘，實際 ${westVisible.delayMinutes} 分`
);
assert(westVisible.horizonAngleDeg > 1, '望高寮的視地平線仰角應明顯大於 0');

// 5-4 沒有剖面時退回天文日出，不得拋錯 (日落機位沒有這個欄位)
const noProfile = SolarCalc.getVisibleSunrise(testDay, westSpot.lat, westSpot.lng, undefined);
assert.strictEqual(noProfile.delayMinutes, 0, '無剖面應退回天文日出');

// 5-5 每個日出機位都必須備妥剖面，且涵蓋全年日出方位角擺盪範圍 (約 64°-116°)
TAIWAN_SPOTS
  .filter(s => s.category === 'sunrise' || s.category === 'both')
  .forEach(s => {
    assert(Array.isArray(s.sunriseHorizonProfile) && s.sunriseHorizonProfile.length > 0,
      `${s.name} 應有 sunriseHorizonProfile`);
    const azs = s.sunriseHorizonProfile.map(p => p[0]);
    assert(Math.min(...azs) <= 64 && Math.max(...azs) >= 116,
      `${s.name} 的剖面應涵蓋 64°-116° 的日出方位角範圍`);
  });

console.log('✅ 地形視地平線與實際見日時刻計算正確');

console.log('🎉 SolarCalc 所有測試案例全數 PASS!\n');
