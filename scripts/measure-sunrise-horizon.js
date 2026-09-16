/**
 * measure-sunrise-horizon.js —— 量測各日出機位的「視地平線剖面」
 *
 * 產出 spots-taiwan.js 裡 sunriseHorizonProfile 欄位的內容。平常不需要跑，
 * 只有在新增日出機位、或修正機位座標之後才要重新量一次。
 *
 * 原理：從機位沿各個方位角往外掃 DEM 高度，逐點算出「該點高出視線多少度」
 * (高差扣掉地球曲率下沉)，取整條線上最大的那個角度，就是該方位角上真正的
 * 地平線仰角。solar-calc.js 的 getVisibleSunrise 再用它算出太陽要爬到幾點
 * 才真的看得見。
 *
 * 為什麼是整條剖面而不是單一角度：日出方位角一年之間從約 64° (夏至) 擺到
 * 116° (冬至)，跨 52 度，不同季節擋在前面的是山脈的不同段落。
 *
 * 注意：高度基準用 DEM 在機位座標上的讀值，不是 spots-taiwan.js 的
 * elevation 欄位 —— 兩者若不一致 (2026-09-16 實測金龍山差 622m，疑為座標
 * 有誤)，用欄位值會讓整條剖面跟著偏掉。
 *
 * 用法: node scripts/measure-sunrise-horizon.js [輸出.json]
 */
const path = require('path');
const fs = require('fs');
const WeatherService = require(path.join(__dirname, '..', 'js', 'weather-service.js'));
const TAIWAN_SPOTS = require(path.join(__dirname, '..', 'js', 'spots-taiwan.js'));

const EARTH_RADIUS_KM = 6371;
const AZIMUTHS = [];
for (let a = 64; a <= 118; a += 6) AZIMUTHS.push(a);
const DISTANCES_KM = [];
for (let d = 2; d <= 72; d += 2) DISTANCES_KM.push(d);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open-Meteo 的 elevation 端點有每分鐘請求上限，撞到就退避重試。
async function fetchElevations(lats, lngs) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lngs.join(',')}`;
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { await sleep(65000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elevation)) throw new Error('回應缺少 elevation 陣列');
      return json.elevation;
    } catch (e) {
      lastErr = e;
      await sleep(8000);
    }
  }
  throw new Error(`多次重試後仍失敗: ${lastErr}`);
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

(async () => {
  const outPath = process.argv[2] || path.join(__dirname, '..', 'sunrise-horizon-profiles.json');
  const spots = TAIWAN_SPOTS.filter((s) => s.category === 'sunrise' || s.category === 'both');
  const baseElevations = await fetchElevations(spots.map((s) => s.lat), spots.map((s) => s.lng));
  await sleep(6000);

  const result = {};
  for (let k = 0; k < spots.length; k++) {
    const spot = spots[k];
    const base = baseElevations[k];
    if (Math.abs(base - spot.elevation) > 200) {
      console.warn(`  ⚠️ ${spot.name}: DEM 高度 ${Math.round(base)}m 與資料庫 ${spot.elevation}m 相差超過 200m，座標可能有誤`);
    }

    const points = [];
    for (const az of AZIMUTHS) {
      for (const distanceKm of DISTANCES_KM) {
        points.push({ az, distanceKm, ...WeatherService.calculateUpstreamCoords(spot.lat, spot.lng, az, distanceKm) });
      }
    }

    const elevations = [];
    for (const part of chunk(points, 100)) {
      elevations.push(...await fetchElevations(part.map((p) => p.lat), part.map((p) => p.lng)));
      await sleep(6000);
    }

    const maxByAz = {};
    points.forEach((p, i) => {
      const curvatureDropM = ((p.distanceKm * p.distanceKm) / (2 * EARTH_RADIUS_KM)) * 1000;
      const riseM = Math.max(0, elevations[i] - base - curvatureDropM);
      const angleDeg = Math.atan2(riseM, p.distanceKm * 1000) * (180 / Math.PI);
      if (!maxByAz[p.az] || angleDeg > maxByAz[p.az]) maxByAz[p.az] = angleDeg;
    });

    result[spot.id] = AZIMUTHS.map((az) => [az, Number(maxByAz[az].toFixed(2))]);
    console.log(`${spot.name} (基準 ${Math.round(base)}m): ` +
      AZIMUTHS.map((az) => `${az}°=${maxByAz[az].toFixed(1)}°`).join('  '));
  }

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n已寫入 ${outPath} —— 將各機位的陣列貼進 spots-taiwan.js 的 sunriseHorizonProfile。`);
})();
