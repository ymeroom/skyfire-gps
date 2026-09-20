/**
 * test-decision-hero.js - 測試決策優先首頁的純邏輯（距離、機位挑選、鎖定檔對應、行事曆）
 */

const assert = require('assert');
const DecisionHero = require('../js/decision-hero.js');
const TAIWAN_SPOTS = require('../js/spots-taiwan.js');

console.log('--- 🧪 測試 8: 決策優先首頁純邏輯 ---');

// 1. Haversine 距離：以高美濕地為原點，對既有座標的已知值
const gaomei = TAIWAN_SPOTS.find(s => s.id === 'gaomei');
const yongan = TAIWAN_SPOTS.find(s => s.id === 'yongan');
const eryanping = TAIWAN_SPOTS.find(s => s.id === 'alishan-eryanping');

const dYongan = DecisionHero.distanceKm(gaomei.lat, gaomei.lng, yongan.lat, yongan.lng);
const dEryanping = DecisionHero.distanceKm(gaomei.lat, gaomei.lng, eryanping.lat, eryanping.lng);

assert(Math.abs(dYongan - 88.752) < 0.05, `高美→永安應約 88.75km，實得 ${dYongan}`);
assert(Math.abs(dEryanping - 99.342) < 0.05, `高美→二延平應約 99.34km，實得 ${dEryanping}`);
assert(dEryanping > dYongan, '二延平比永安遠（設計稿早期版本寫反了）');
assert.strictEqual(DecisionHero.distanceKm(24.5, 120.5, 24.5, 120.5), 0, '同一點距離為 0');

console.log('✅ Haversine 距離對既有座標吻合:', {
  yongan: dYongan.toFixed(2) + 'km',
  eryanping: dEryanping.toFixed(2) + 'km'
});

// 2. buildOtherSpots：日落時段、以高美為當前機位
const lockedSunset = {
  date: '2026-09-17',
  session: 'sunset',
  lockedAt: '2026-09-17T07:30:10.934Z',
  stations: [
    { id: 'gaomei', skyfire: { score: 35 } },
    { id: 'yongan', skyfire: { score: 64 } },
    { id: 'alishan-xiaoluji', skyfire: { score: 44 } },
    { id: 'alishan-eryanping', skyfire: { score: 11 } },
    { id: 'dagushan', skyfire: { score: 22 } },
    { id: 'baihe-biyun', skyfire: { score: 13 } }
  ]
};

const rows = DecisionHero.buildOtherSpots({
  spots: TAIWAN_SPOTS,
  locked: lockedSunset,
  userLat: gaomei.lat,
  userLng: gaomei.lng,
  session: 'sunset',
  excludeSpotId: 'gaomei',
  limit: 3
});

assert.strictEqual(rows.length, 3, '應回傳 3 筆');
assert(!rows.some(r => r.id === 'gaomei'), '當前機位必須被排除（避免現算分數與鎖定分數打對台）');
assert.deepStrictEqual(
  rows.map(r => r.id),
  ['yongan', 'alishan-xiaoluji', 'alishan-eryanping'],
  '應依距離由近到遠排序'
);
assert.strictEqual(rows[0].score, 64, '永安分數應取自鎖定檔');
assert.strictEqual(rows[0].noScoreReason, null, '有分數時不應帶無分數原因');
assert(!rows.some(r => r.category === 'sunrise'), '日落時段不應出現純日出機位');

console.log('✅ 日落時段「其他機位」挑選正確:', rows.map(r => `${r.name} ${r.score}`));

// 3. 日出時段：金龍山永遠沒有鎖定分數（lock-forecast-multi.js 的 EXCLUDED_FROM_LOCK）
const lockedSunrise = {
  date: '2026-09-17',
  session: 'sunrise',
  lockedAt: '2026-09-16T15:45:24.562Z',
  stations: [
    { id: 'gaowangliao', skyfire: { score: 25 } },
    { id: 'erliao', skyfire: { score: 38 } }
  ]
};

const jinlongshan = TAIWAN_SPOTS.find(s => s.id === 'jinlongshan');
const sunriseRows = DecisionHero.buildOtherSpots({
  spots: TAIWAN_SPOTS,
  locked: lockedSunrise,
  userLat: jinlongshan.lat,
  userLng: jinlongshan.lng,
  session: 'sunrise',
  excludeSpotId: 'gaowangliao',
  limit: 10
});

const jinRow = sunriseRows.find(r => r.id === 'jinlongshan');
assert(jinRow, '金龍山仍應出現在清單中，不可靜默略過');
assert.strictEqual(jinRow.score, null, '金龍山不可顯示 0 分，應為 null');
assert.strictEqual(jinRow.noScoreReason, DecisionHero.NO_SCORE_REASONS.EXCLUDED, '應標示未納入驗證的原因');

console.log('✅ 金龍山正確標示為無預報:', jinRow.noScoreReason);
