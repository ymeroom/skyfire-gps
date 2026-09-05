/**
 * lock-forecast.js
 * 提前向 Open-Meteo 請求氣象資料並計算預測分數，將結果鎖定存入 JSON，
 * 供之後的歷史日報 (Ground Truth) 驗證使用。
 */

const fs = require('fs');
const path = require('path');
const WeatherService = require('../js/weather-service.js');
const { OFFICIAL_STREAMS, getTaipeiDateString } = require('./live-capture-core.js');

async function lockForecast() {
  const schedule = process.env.EVENT_SCHEDULE || '';
  const manualSession = process.env.MANUAL_SESSION || '';
  
  let sessionType = 'sunset';
  if (manualSession) {
    sessionType = manualSession;
  } else if (schedule.includes('50 15')) {
    // 23:50 (UTC 15:50) 鎖定隔日日出
    sessionType = 'sunrise';
  } else if (schedule.includes('30 8')) {
    // 16:30 (UTC 08:30) 鎖定當日日落
    sessionType = 'sunset';
  }

  const now = new Date();
  let targetDate = new Date(now);
  
  if (sessionType === 'sunrise') {
    // 鎖定日出預測：如果是在午夜 (0點~12點) 執行，目標就是「今天」的日出
    // 如果是在下午/晚上 (12點~24點) 執行，目標就是「明天」的日出
    if (now.getHours() >= 12) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
  }
  const dateStr = getTaipeiDateString(targetDate);

  console.log(`[Lock Forecast] 準備鎖定 ${dateStr} 的 ${sessionType} 預測`);

  // 注意：WeatherService.fetchForecast 的簽名是 {lat,lng,locationName,forceRefresh}
  // 物件，不是單一 boolean —— 先前這裡直接傳 `true`，解構後會全部落回
  // DEFAULT_COORDS (台北市中心) 且 forceRefresh 永遠是 false (never true)，
  // 等於鎖定作業一直在讀 15 分鐘快取、也從未真正對到本次驗證機位的座標。
  const source = OFFICIAL_STREAMS[sessionType];
  const forecastData = await WeatherService.fetchForecast({
    lat: source.lat,
    lng: source.lng,
    locationName: source.name,
    forceRefresh: true
  });
  const matchingDay = forecastData.daysForecast.find(day =>
    getTaipeiDateString(new Date(day.date)) === dateStr
  ) || forecastData.daysForecast[0];
  
  const sessionForecast = matchingDay[sessionType];
  
  if (!sessionForecast || !sessionForecast.skyfire) {
    throw new Error('無法取得預測資料');
  }

  const scoreData = {
    date: dateStr,
    session: sessionType,
    lockedAt: now.toISOString(),
    skyfire: sessionForecast.skyfire,
    // skyfire.diagnostics 是文字診斷清單 (label/status/desc)，不含
    // highCloud/midCloud/lowCloud 數值欄位；capture-validation.js 需要
    // 這些數值來記錄「鎖定當時的雲量」，故與 skyfire 分開存一份 weather。
    weather: sessionForecast.weather
  };

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const lockFile = path.join(dataDir, `locked-${sessionType}-forecast.json`);
  fs.writeFileSync(lockFile, JSON.stringify(scoreData, null, 2), 'utf8');

  console.log(`[Lock Forecast] 已鎖定預測分數: ${scoreData.skyfire.score} 分`);
  console.log(`[Lock Forecast] 檔案已儲存至: ${lockFile}`);
}

lockForecast().catch(err => {
  console.error('[Lock Forecast] Error:', err);
  process.exit(1);
});
