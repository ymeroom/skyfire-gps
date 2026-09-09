/**
 * lock-forecast-multi.js
 * 多機位版的預測鎖定：對 js/spots-taiwan.js 裡「本時段」的每一個攝影聖地
 * 各自向 Open-Meteo 請求氣象、算出預測分數，一次鎖定成一份 stations 陣列，
 * 供 merge-multi-station-calibration.js 之後跟 13 站縮時的實測 ground truth 配對。
 *
 * 與單站的 lock-forecast.js 完全獨立：後者鎖的是象山/大稻埕兩個官方 4K 機位
 * (OFFICIAL_STREAMS)，寫 data/locked-<session>-forecast.json；本檔鎖的是使用者
 * 實測的 13 個聖地，寫 data/locked-<session>-multi-forecast.json，兩條線互不影響。
 *
 * 時段解析與目標日期推算沿用 lock-forecast.js 的規則。
 */

const fs = require('fs');
const path = require('path');
const WeatherService = require('../js/weather-service.js');
const TAIWAN_SPOTS = require('../js/spots-taiwan.js');
const { getTaipeiDateString } = require('./live-capture-core.js');

function resolveSession() {
  const schedule = process.env.EVENT_SCHEDULE || '';
  const manualSession = process.env.MANUAL_SESSION || '';
  if (manualSession) return manualSession;
  if (schedule.includes('45 15')) return 'sunrise'; // 23:45 台灣，鎖隔日日出
  return 'sunset'; // 15:30 台灣，鎖當日日落
}

function resolveTargetDate(sessionType) {
  const now = new Date();
  const targetDate = new Date(now);
  // 日出：中午前執行 → 今天日出；中午後執行 → 明天日出 (與 lock-forecast.js 一致)
  if (sessionType === 'sunrise' && now.getHours() >= 12) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  return getTaipeiDateString(targetDate);
}

function spotsForSession(sessionType) {
  // 晨昏雙絕 (both) 的機位在日出與日落時段都要鎖。縮時腳本兩個時段的
  // 站點清單也都各自包含 alishan-xiaoluji，靠 id 對得起來。
  const wanted = sessionType === 'sunrise' ? ['sunrise', 'both'] : ['sunset', 'both'];
  return TAIWAN_SPOTS.filter((s) => wanted.includes(s.category));
}

async function lockOneSpot(spot, sessionType, dateStr) {
  const forecastData = await WeatherService.fetchForecast({
    lat: spot.lat,
    lng: spot.lng,
    locationName: spot.name,
    forceRefresh: true
  });
  const matchingDay =
    forecastData.daysForecast.find(
      (day) => getTaipeiDateString(new Date(day.date)) === dateStr
    ) || forecastData.daysForecast[0];

  const sessionForecast = matchingDay[sessionType];
  if (!sessionForecast || !sessionForecast.skyfire) {
    throw new Error(`${spot.id} 無法取得 ${sessionType} 預測資料`);
  }

  return {
    id: spot.id,
    name: spot.name,
    lat: spot.lat,
    lng: spot.lng,
    category: spot.category,
    isSimulated: forecastData.isSimulated === true,
    skyfire: sessionForecast.skyfire,
    // 數值雲量欄位在 weather 裡，skyfire.diagnostics 只有文字診斷。
    weather: sessionForecast.weather
  };
}

async function run() {
  const sessionType = resolveSession();
  const dateStr = resolveTargetDate(sessionType);
  const spots = spotsForSession(sessionType);

  console.log(
    `[Lock Forecast Multi] 準備鎖定 ${dateStr} 的 ${sessionType} 預測，共 ${spots.length} 個機位`
  );

  const stations = [];
  const failures = [];
  for (const spot of spots) {
    try {
      const locked = await lockOneSpot(spot, sessionType, dateStr);
      stations.push(locked);
      console.log(`  ✅ ${spot.name} (${spot.id}): ${locked.skyfire.score} 分`);
    } catch (err) {
      failures.push({ id: spot.id, error: err.message });
      console.warn(`  ⚠️ ${spot.name} (${spot.id}) 鎖定失敗: ${err.message}`);
    }
  }

  if (!stations.length) {
    throw new Error('所有機位都鎖定失敗，不寫出空檔案');
  }

  const out = {
    date: dateStr,
    session: sessionType,
    lockedAt: new Date().toISOString(),
    stationCount: stations.length,
    failures,
    stations
  };

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, `locked-${sessionType}-multi-forecast.json`);
  fs.writeFileSync(lockFile, JSON.stringify(out, null, 2), 'utf8');

  console.log(
    `[Lock Forecast Multi] 已鎖定 ${stations.length}/${spots.length} 個機位 → ${lockFile}`
  );
}

run().catch((err) => {
  console.error('[Lock Forecast Multi] Error:', err);
  process.exit(1);
});
