/**
 * test-weather-service.js - 測試 WeatherService 資料處理與離線模擬器
 */

const assert = require('assert');
const SolarCalc = require('../js/solar-calc.js');
const SkyFireEngine = require('../js/skyfire-engine.js');
const WeatherService = require('../js/weather-service.js');

console.log('--- 🧪 測試 3: WeatherService 氣象服務測試 ---');

// 1. 離線模擬生成器測試
const simulated = WeatherService.generateSimulatedForecast(25.0330, 121.5654, '台北市中心');

assert(simulated.isSimulated === true, '離線模式標記應為 true');
assert.strictEqual(simulated.daysForecast.length, 7, '應生成 7 天預報數據');
assert(simulated.daysForecast[0].sunrise.skyfire.score >= 0, '日出火燒雲分數應為有效數字');
assert(simulated.daysForecast[0].sunset.skyfire.score >= 0, '日落火燒雲分數應為有效數字');
assert(simulated.daysForecast[0].solarTimes.sunset instanceof Date, '日落時間應為有效 Date 物件');

console.log('✅ 離線模擬預報生成正確 (7 天日出/日落完整結構)');

// 2. 模擬 Open-Meteo 原始 JSON 解析測試
const mockRawData = {
  hourly: {
    time: [
      '2026-08-16T05:00', '2026-08-16T06:00', '2026-08-16T07:00',
      '2026-08-16T17:00', '2026-08-16T18:00', '2026-08-16T19:00'
    ],
    cloudcover_high: [40, 50, 60, 55, 60, 45],
    cloudcover_mid: [30, 35, 40, 40, 42, 38],
    cloudcover_low: [15, 10, 20, 12, 15, 18],
    cloudcover: [50, 60, 70, 65, 70, 60],
    visibility: [25000, 25000, 25000, 28000, 28000, 28000],
    relativehumidity_2m: [65, 60, 55, 58, 62, 65],
    precipitation_probability: [0, 0, 0, 0, 0, 0],
    temperature_2m: [26, 27, 28, 31, 30, 29],
    weathercode: [1, 1, 1, 1, 1, 1]
  }
};

const parsed = WeatherService.processRawData(mockRawData, 25.0330, 121.5654, '台北市測試點');

assert.strictEqual(parsed.isSimulated, false, '真實解析標記應為 false');
assert.strictEqual(parsed.location.name, '台北市測試點', '地點名稱應正確傳遞');
assert(parsed.daysForecast.length === 7, '應產出 7 天預報結構');
assert(parsed.hourly.length === 6, '應正確提取 6 個逐小時紀錄');

console.log('✅ Open-Meteo 原始數據解析與時程配對正確');

// 3. 最接近小時搜尋算法測試
const testTarget = new Date('2026-08-16T18:12:00');
const closest = WeatherService.getClosestHourData(parsed.hourly, testTarget);
assert.strictEqual(closest.timeStr, '2026-08-16T18:00', '18:12 最接近的小時紀錄應為 18:00');

console.log('✅ 最近氣象觀測小時配對算法精確');

console.log('🎉 WeatherService 所有測試案例全數 PASS!\n');
