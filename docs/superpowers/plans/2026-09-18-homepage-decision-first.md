# 首頁決策優先改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把首頁首屏收斂成一個決策答案（大分數、一句判斷、一個主按鈕、倒數），深層區塊原地保留、改由一排錨點入口抵達。

**Architecture:** 所有可測邏輯放進新的純函式模組 `js/decision-hero.js`（沿用本專案
`window.X` + `module.exports` 雙輸出慣例，可在 node 直接 require 測試）。DOM 渲染留在
`js/app.js`，新增 `renderDecisionHero()` 並掛進既有 `render()`；既有渲染函式與它們寫入的
DOM id 一個都不動。逐站分數讀每日已 commit 的鎖定 JSON，不對 Open-Meteo 發逐站請求。

**Tech Stack:** 原生 JS（無框架、無建置步驟）、node + `assert` 測試（無測試框架、無 jsdom）、
Leaflet（既有）、GitHub Pages 靜態部署。

**Spec:** `docs/superpowers/specs/2026-09-18-homepage-decision-first-design.md`

## Global Constraints

- 測試以 `node` 直接執行，斷言用 `require('assert')`，無測試框架、無 jsdom。
  全套：`node tests/run-all-tests.js`。新測試檔要加進 `tests/run-all-tests.js` 的 require 串。
- 新模組沿用既有雙輸出慣例（見 `js/solar-calc.js` 檔尾）：
  `if (typeof window !== 'undefined') { window.X = X; }` 與
  `if (typeof module !== 'undefined' && module.exports) { module.exports = X; }`
- `js/app.js` 既有渲染函式（`renderHeroGauge`、`renderCloudCrossSection`、
  `renderSolarTimeline`、`render7DayForecastDeck`、`updateMapSunAzimuth`）與它們使用的
  DOM id 一律不改。只新增。
- 分數環漸層一律用既有 `#gaugeGradient`（`index.html:51-54`，`#ff3366 → #ff6b00 → #ffb800`）。
- 文案不寫死站數：不得出現「13 個」「13 站」等字樣（逐時段為 7 站 / 6 站，其中 12 站有分數）。
- 「巔峰」正字，不可寫成「顛峰」（全站既有用字）。
- 絕不顯示車程分鐘數，絕不拿非當前時段的鎖定分數頂替。
- 圓角與陰影用 `css/style.css` 既有 token，`--shadow-md` 必須含兩層
  （第二層 `0 8px 10px -6px rgba(0,0,0,0.3)`）。
- 台北時間 = UTC+8，全站無夏令時間處理。

---

### Task 1: 距離計算與「其他機位」挑選

**Files:**
- Create: `js/decision-hero.js`
- Test: `tests/test-decision-hero.js`
- Modify: `tests/run-all-tests.js:16`（在 `test-taiwan-scope.js` 之後加一行 require）

**Interfaces:**
- Consumes: `js/spots-taiwan.js` 的 `TAIWAN_SPOTS`（`id`/`name`/`lat`/`lng`/`category`/`liveUrl`）
- Produces:
  - `DecisionHero.distanceKm(lat1, lng1, lat2, lng2) -> number`（公里，未四捨五入）
  - `DecisionHero.NO_SCORE_REASONS = { EXCLUDED: string, SESSION_UNLOCKED: string }`
  - `DecisionHero.buildOtherSpots({ spots, locked, userLat, userLng, session, excludeSpotId, limit }) -> Row[]`
    其中 `Row = { id, name, lat, lng, liveUrl, distanceKm, score, noScoreReason, lockedAtLabel }`
    （`score` 為 `number|null`；`noScoreReason` 為 `string|null`；`lockedAtLabel` 為 `string|null`）

- [ ] **Step 1: Write the failing test**

建立 `tests/test-decision-hero.js`：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-decision-hero.js`
Expected: FAIL — `Cannot find module '../js/decision-hero.js'`

- [ ] **Step 3: Write minimal implementation**

建立 `js/decision-hero.js`：

```js
/**
 * decision-hero.js - 決策優先首頁的純邏輯（無 DOM、無 fetch）
 *
 * 逐站分數來自 scripts/lock-forecast-multi.js 每天鎖定並 commit 的
 * data/locked-{session}-multi-forecast.json，不對 Open-Meteo 發逐站請求。
 */

const DecisionHero = {
  // 南投金龍山：lock-forecast-multi.js 的 EXCLUDED_FROM_LOCK 刻意不鎖
  // （YouTube 直播 DVR 只剩約 25 秒，鎖了也永遠配不到實測），故永遠無分數。
  EXCLUDED_SPOT_IDS: ['jinlongshan'],

  NO_SCORE_REASONS: {
    EXCLUDED: '無預報（直播 DVR 過短，未納入驗證）',
    SESSION_UNLOCKED: '該時段尚未鎖定逐站預報'
  },

  /** Haversine 距離（公里），不四捨五入，顯示端自行決定精度 */
  distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dPhi = toRad(lat2 - lat1);
    const dLambda = toRad(lng2 - lng1);
    const a = Math.sin(dPhi / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  },

  /**
   * 組出「今晚其他機位」清單。
   * locked 為 null（或時段對不上，由呼叫端先以 lockedSessionMatches 判定）時，
   * 所有列的 score 為 null、原因為 SESSION_UNLOCKED——絕不拿別的時段的分數頂替。
   */
  buildOtherSpots({ spots, locked, userLat, userLng, session, excludeSpotId, limit }) {
    const wanted = session === 'sunrise' ? ['sunrise', 'both'] : ['sunset', 'both'];
    const scoreById = new Map();
    if (locked && Array.isArray(locked.stations)) {
      locked.stations.forEach((s) => {
        if (s && s.skyfire && typeof s.skyfire.score === 'number') {
          scoreById.set(s.id, s.skyfire.score);
        }
      });
    }
    const lockedAtLabel = locked ? DecisionHero.formatLockedAt(locked.lockedAt) : null;

    return spots
      .filter((s) => wanted.includes(s.category) && s.id !== excludeSpotId)
      .map((s) => {
        const hasScore = scoreById.has(s.id);
        let noScoreReason = null;
        if (!hasScore) {
          noScoreReason = DecisionHero.EXCLUDED_SPOT_IDS.includes(s.id)
            ? DecisionHero.NO_SCORE_REASONS.EXCLUDED
            : DecisionHero.NO_SCORE_REASONS.SESSION_UNLOCKED;
        }
        return {
          id: s.id,
          name: s.name,
          category: s.category,
          lat: s.lat,
          lng: s.lng,
          liveUrl: s.liveUrl || null,
          distanceKm: DecisionHero.distanceKm(userLat, userLng, s.lat, s.lng),
          score: hasScore ? scoreById.get(s.id) : null,
          noScoreReason,
          lockedAtLabel: hasScore ? lockedAtLabel : null
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);
  }
};

// 支援全域與模組
if (typeof window !== 'undefined') {
  window.DecisionHero = DecisionHero;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DecisionHero;
}
```

注意：上面用到 `DecisionHero.formatLockedAt`，該函式在 Task 2 才實作。為讓本任務的測試
先通過，這一步先加入一個最小版本，Task 2 會為它補上測試與正式實作：

```js
  /** ISO 時間 → 台北時間 HH:MM（Task 2 補測試） */
  formatLockedAt(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const taipei = new Date(d.getTime() + 8 * 3600 * 1000);
    const hh = String(taipei.getUTCHours()).padStart(2, '0');
    const mm = String(taipei.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-decision-hero.js`
Expected: PASS — 三組 ✅ 訊息（距離、日落挑選、金龍山無預報）

- [ ] **Step 5: 加進全套測試並確認全套通過**

在 `tests/run-all-tests.js` 的 `require('./test-taiwan-scope.js');` 之後加一行：

```js
  require('./test-decision-hero.js');
```

Run: `node tests/run-all-tests.js`
Expected: PASS，結尾出現 🏆 訊息

- [ ] **Step 6: Commit**

```bash
git add js/decision-hero.js tests/test-decision-hero.js tests/run-all-tests.js
git commit -m "feat(homepage): add distance + other-spots logic for decision hero"
```

---

### Task 2: 鎖定檔時段對應與鎖定時間顯示

**Files:**
- Modify: `js/decision-hero.js`（新增 `lockedSessionMatches`，補 `formatLockedAt` 正式實作）
- Test: `tests/test-decision-hero.js`（append）

**Interfaces:**
- Consumes: Task 1 的 `DecisionHero`
- Produces:
  - `DecisionHero.lockedSessionMatches(locked, activeSessionType, todayStr) -> boolean`
  - `DecisionHero.formatLockedAt(iso) -> string|null`（台北時間 `HH:MM`）

**為什麼需要這個判定：** `js/app.js:290-340` 的 `activeSessionType` 可以是
`today-sunrise` / `today-sunset` / `tomorrow-sunrise` / `tomorrow-sunset` / `day2-sunrise` /
`custom`，但鎖定檔只涵蓋「今天的那一場」。且 `scripts/local-trigger/run-job.sh:86` 對鎖定
失敗是容錯的（`|| echo "⚠️ 多機位鎖定失敗"`），所以資料過期是預期狀態。

- [ ] **Step 1: Write the failing test**

在 `tests/test-decision-hero.js` 末端加入：

```js
// 4. 鎖定檔時段對應：只有「今天的那一場」才算對得上
const lockedToday = { date: '2026-09-17', session: 'sunset', lockedAt: '2026-09-17T07:30:10.934Z' };

assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'today-sunset', '2026-09-17'), true,
  '今日日落 + 當天的日落鎖定檔 → 對得上'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'today-sunrise', '2026-09-17'), false,
  '時段別不同（日出 vs 日落）→ 對不上'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'tomorrow-sunset', '2026-09-17'), false,
  '明日日落沒有鎖定檔 → 對不上，不可拿今天的頂替'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'day2-sunrise', '2026-09-17'), false,
  '後日日出沒有鎖定檔 → 對不上'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'custom', '2026-09-17'), false,
  '自訂時段 → 對不上'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(lockedToday, 'today-sunset', '2026-09-18'), false,
  '鎖定檔日期不是今天（鎖定工作失敗過）→ 對不上，絕不顯示昨天的分數'
);
assert.strictEqual(
  DecisionHero.lockedSessionMatches(null, 'today-sunset', '2026-09-17'), false,
  '抓取失敗 → 對不上'
);

console.log('✅ 鎖定檔時段對應正確（過期與非當日時段皆不顯示分數）');

// 5. 鎖定時間轉台北時間
assert.strictEqual(DecisionHero.formatLockedAt('2026-09-16T15:45:24.562Z'), '23:45', 'UTC 15:45 → 台北 23:45');
assert.strictEqual(DecisionHero.formatLockedAt('2026-09-17T07:30:10.934Z'), '15:30', 'UTC 07:30 → 台北 15:30');
assert.strictEqual(DecisionHero.formatLockedAt(null), null, '缺值回 null');
assert.strictEqual(DecisionHero.formatLockedAt('not-a-date'), null, '無效值回 null');

console.log('✅ 鎖定時間正確轉為台北時間');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-decision-hero.js`
Expected: FAIL — `DecisionHero.lockedSessionMatches is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `js/decision-hero.js` 的 `buildOtherSpots` 之前加入：

```js
  /**
   * 鎖定檔是否對應到當前選中的時段。
   * 鎖定檔只涵蓋「今天的那一場」，其餘時段（明日、後日、自訂）一律回 false，
   * 日期不是今天時（鎖定工作失敗）也回 false——絕不拿前一天的分數頂替。
   */
  lockedSessionMatches(locked, activeSessionType, todayStr) {
    if (!locked || !locked.date || !locked.session) return false;
    if (locked.date !== todayStr) return false;
    if (activeSessionType === 'today-sunrise') return locked.session === 'sunrise';
    if (activeSessionType === 'today-sunset') return locked.session === 'sunset';
    return false;
  },
```

`formatLockedAt` 沿用 Task 1 Step 3 已加入的實作（UTC+8，全站無夏令時間處理）。

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-decision-hero.js`
Expected: PASS — 五組 ✅ 訊息

- [ ] **Step 5: Commit**

```bash
git add js/decision-hero.js tests/test-decision-hero.js
git commit -m "feat(homepage): match locked forecast to active session, never stale"
```

---

### Task 3: 導航連結、行事曆檔、接下來三場

**Files:**
- Modify: `js/decision-hero.js`
- Test: `tests/test-decision-hero.js`（append）

**Interfaces:**
- Consumes: Task 1–2 的 `DecisionHero`
- Produces:
  - `DecisionHero.mapsDirectionsUrl(lat, lng) -> string`
  - `DecisionHero.buildIcs({ title, start, durationMinutes, location, description }) -> string`
    （`start` 為 `Date`；回傳字串以 CRLF 斷行）
  - `DecisionHero.nextThreeSessions(daysForecast, afterSessionType) -> Session[]`
    （`Session = { label, timeLabel, score, type }`）

- [ ] **Step 1: Write the failing test**

在 `tests/test-decision-hero.js` 末端加入：

```js
// 6. Google 地圖路線連結（車程分鐘數交給 Google，不自己合成）
const mapsUrl = DecisionHero.mapsDirectionsUrl(24.31284018839888, 120.54737671005434);
assert(mapsUrl.startsWith('https://www.google.com/maps/dir/?api=1&destination='), '應為 Maps 路線 deep link');
assert(mapsUrl.includes('24.31284'), '應帶入緯度');
assert(mapsUrl.includes('120.54737'), '應帶入經度');
assert(!/分鐘|minute/.test(mapsUrl), '不自行合成車程時間');

console.log('✅ 導航連結格式正確:', mapsUrl);

// 7. .ics 行事曆（零後端，離線可用）
const ics = DecisionHero.buildIcs({
  title: '明日日出火燒雲 64 分',
  start: new Date('2026-09-18T05:47:00+08:00'),
  durationMinutes: 30,
  location: '台中・望高寮',
  description: '霞光指數 64，巔峰 05:47'
});

assert(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'ics 必須以 BEGIN:VCALENDAR 起始且用 CRLF');
assert(ics.trimEnd().endsWith('END:VCALENDAR'), 'ics 必須以 END:VCALENDAR 結尾');
assert(ics.includes('BEGIN:VEVENT\r\n'), '應含 VEVENT');
assert(ics.includes('DTSTART:20260917T214700Z'), '05:47+08:00 應為 UTC 21:47（前一日），不可算錯時區');
assert(ics.includes('DTEND:20260917T221700Z'), '結束時間應為起始 +30 分');
assert(ics.includes('SUMMARY:明日日出火燒雲 64 分'), '應含標題');
assert(ics.includes('LOCATION:台中・望高寮'), '應含地點');
assert(ics.includes('巔峰'), '用字為「巔峰」而非「顛峰」');
assert(!ics.includes('顛峰'), '不可出現錯字「顛峰」');
assert(ics.split('\r\n').every(l => l.length <= 75 || l.startsWith(' ')), 'ics 行長應符合折行規範');

console.log('✅ .ics 行事曆字串格式正確');

// 8. 接下來三場：直接讀記憶體中的 7 天預報，不新增抓取
// 注意：時刻以本機時區的 Date 建構（new Date(y, m, d, h, min)），使 timeLabel 的斷言
// 不受執行機器時區影響——nextThreeSessions 用的是 getHours()，與 app.js 一致。
const daysForecast = [
  { dateFormatted: '9/17', sunrise: { time: new Date(2026, 8, 17, 5, 46), skyfire: { score: 12 } },
    sunset: { time: new Date(2026, 8, 17, 18, 1), skyfire: { score: 12 } } },
  { dateFormatted: '9/18', sunrise: { time: new Date(2026, 8, 18, 5, 47), skyfire: { score: 64 } },
    sunset: { time: new Date(2026, 8, 18, 18, 0), skyfire: { score: 31 } } },
  { dateFormatted: '9/19', sunrise: { time: new Date(2026, 8, 19, 5, 48), skyfire: { score: 57 } },
    sunset: { time: new Date(2026, 8, 19, 17, 59), skyfire: { score: 20 } } }
];

const next3 = DecisionHero.nextThreeSessions(daysForecast, 'today-sunset');
assert.strictEqual(next3.length, 3, '應回傳三場');
assert.deepStrictEqual(next3.map(s => s.score), [64, 31, 57], '應為明日日出、明日日落、後日日出');
assert.strictEqual(next3[0].type, 'sunrise', '第一場為日出');
assert(next3[0].timeLabel.includes('05:47'), '應帶巔峰/場次時刻');

console.log('✅ 接下來三場取自既有 7 天預報:', next3.map(s => `${s.label} ${s.score}`));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-decision-hero.js`
Expected: FAIL — `DecisionHero.mapsDirectionsUrl is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `js/decision-hero.js` 的 `buildOtherSpots` 之後加入：

```js
  /** Google 地圖路線 deep link；車程時間交給 Google 算，本專案無此資料來源 */
  mapsDirectionsUrl(lat, lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  },

  /** Date → ics 的 UTC 基本格式 YYYYMMDDTHHMMSSZ */
  toIcsUtc(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
      `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  },

  /**
   * 組 .ics 字串。零後端、離線可用：呼叫端以 Blob + createObjectURL 下載，
   * 提醒交給使用者自己的行事曆。
   */
  buildIcs({ title, start, durationMinutes, location, description }) {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SkyFire GPS//Taiwan//TW',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:skyfire-${start.getTime()}@skyfire-gps`,
      `DTSTAMP:${DecisionHero.toIcsUtc(new Date())}`,
      `DTSTART:${DecisionHero.toIcsUtc(start)}`,
      `DTEND:${DecisionHero.toIcsUtc(end)}`,
      `SUMMARY:${esc(title)}`,
      `LOCATION:${esc(location)}`,
      `DESCRIPTION:${esc(description)}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    // RFC 5545 的 75 octet 折行：超長行以 CRLF + 單一空格續行
    const folded = lines.map((line) => {
      if (line.length <= 75) return line;
      const parts = [line.slice(0, 75)];
      let rest = line.slice(75);
      while (rest.length > 74) {
        parts.push(' ' + rest.slice(0, 74));
        rest = rest.slice(74);
      }
      if (rest.length) parts.push(' ' + rest);
      return parts.join('\r\n');
    });
    return folded.join('\r\n') + '\r\n';
  },

  /**
   * 接下來三場（日出/日落交錯），資料取自 app.js 已載入的
   * this.currentForecastData.daysForecast，不新增任何抓取。
   */
  nextThreeSessions(daysForecast, afterSessionType) {
    const seq = [];
    daysForecast.forEach((day, idx) => {
      seq.push({ idx, type: 'sunrise', data: day.sunrise, day });
      seq.push({ idx, type: 'sunset', data: day.sunset, day });
    });
    // 'today-sunset' 之後 = 明日日出起算；'today-sunrise' 之後 = 今日日落起算
    const startAt = afterSessionType === 'today-sunrise'
      ? seq.findIndex((s) => s.idx === 0 && s.type === 'sunset')
      : seq.findIndex((s) => s.idx === 1 && s.type === 'sunrise');
    return seq.slice(startAt, startAt + 3).map((s) => ({
      type: s.type,
      label: `${s.day.dateFormatted} ${s.type === 'sunrise' ? '日出' : '日落'}`,
      timeLabel: s.data.time instanceof Date
        ? `${String(s.data.time.getHours()).padStart(2, '0')}:${String(s.data.time.getMinutes()).padStart(2, '0')}`
        : '--:--',
      score: s.data.skyfire ? s.data.skyfire.score : null
    }));
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-decision-hero.js`
Expected: PASS — 八組 ✅ 訊息

- [ ] **Step 5: 全套測試**

Run: `node tests/run-all-tests.js`
Expected: PASS，結尾 🏆

- [ ] **Step 6: Commit**

```bash
git add js/decision-hero.js tests/test-decision-hero.js
git commit -m "feat(homepage): add maps deep link, ics builder, next-three-sessions"
```

---

### Task 4: index.html 決策區與入口列骨架

**Files:**
- Modify: `index.html`（決策區插在 `<section class="hero-dashboard-grid">` 之前；
  雲層剖面 section 與 `.forecast-7day-section` 補 id；`js/decision-hero.js` script 標籤
  加在 `js/app.js` 之前）
- Test: `tests/test-dom-bindings.js`（append 新版面的結構斷言）

**Interfaces:**
- Consumes: Task 1–3 的 `js/decision-hero.js`（瀏覽器端以 `window.DecisionHero` 取用）
- Produces（Task 5 的 `app.js` 會寫入這些 id）：
  `decisionHero`、`decisionScoreNum`、`decisionGaugeFill`、`decisionVerdictBadge`、
  `decisionVerdictLine`、`decisionReasonText`、`decisionPrimaryBtn`、`decisionSecondaryBtn`、
  `decisionCountdown`、`decisionPeakTime`、`otherSpotsTitle`、`otherSpotsList`、
  `otherSpotsNote`、`deepDiveNav`

- [ ] **Step 1: Write the failing test**

在 `tests/test-dom-bindings.js` 末端（既有斷言之後）加入：

```js
// 決策優先版面：骨架與錨點必須齊備
const decisionIds = [
  'decisionHero', 'decisionScoreNum', 'decisionGaugeFill', 'decisionVerdictBadge',
  'decisionVerdictLine', 'decisionReasonText', 'decisionPrimaryBtn', 'decisionSecondaryBtn',
  'decisionCountdown', 'decisionPeakTime', 'otherSpotsTitle', 'otherSpotsList',
  'otherSpotsNote', 'deepDiveNav'
];
const missingDecisionIds = decisionIds.filter(id => !new RegExp(`id=['"]${id}['"]`).test(htmlContent));
assert.strictEqual(missingDecisionIds.length, 0, `index.html 缺少決策區 DOM ID: ${missingDecisionIds.join(', ')}`);

// 決策區必須排在既有儀表板之前（首屏只回答一個問題）
const decisionIndex = htmlContent.indexOf('id="decisionHero"');
const heroGridIndex = htmlContent.indexOf('class="hero-dashboard-grid"');
assert(decisionIndex >= 0 && heroGridIndex >= 0, '兩個區塊都應存在');
assert(decisionIndex < heroGridIndex, '決策區應插在 hero-dashboard-grid 之前');

// 四個入口的錨點目標都必須真的存在於同一頁（方案 A：同頁錨點，不新增頁面）
['cloudProfileSection', 'forecast7daySection', 'interactiveMapSection', 'verifySection']
  .forEach((anchorId) => {
    assert(new RegExp(`id=['"]${anchorId}['"]`).test(htmlContent), `錨點目標 #${anchorId} 應存在`);
    assert(htmlContent.includes(`href="#${anchorId}"`), `入口列應有連往 #${anchorId} 的連結`);
  });

// decision-hero.js 必須在 app.js 之前載入
const decisionScriptIndex = htmlContent.indexOf('js/decision-hero.js');
assert(decisionScriptIndex >= 0, 'HTML 應引入 decision-hero.js');
assert(decisionScriptIndex < htmlContent.indexOf('js/app.js'), 'decision-hero.js 應在 app.js 前載入');

// 文案不得寫死站數（逐時段 7 站 / 6 站，其中 12 站有分數）
assert(!/13\s*(個|站)/.test(htmlContent), 'index.html 不應寫死「13 個/13 站」');
// 全站正字為「巔峰」
assert(!htmlContent.includes('顛峰'), 'index.html 不應出現錯字「顛峰」');

console.log('✅ 決策優先版面骨架、錨點與載入順序皆正確');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dom-bindings.js`
Expected: FAIL — `index.html 缺少決策區 DOM ID: decisionHero, decisionScoreNum, ...`

- [ ] **Step 3: Write minimal implementation**

3a. 在 `index.html` 中 `<section class="hero-dashboard-grid">` 之前插入：

```html
    <!-- 決策區：首屏只回答一個問題「現在值得出門嗎」。
         深層資訊全部退到下方，由 #deepDiveNav 的錨點抵達。 -->
    <section class="decision-hero" id="decisionHero" data-verdict="pending">
      <div class="decision-gauge-wrap">
        <svg class="decision-gauge" viewBox="0 0 160 160">
          <circle class="decision-gauge-track" cx="80" cy="80" r="70"></circle>
          <!-- 漸層沿用既有 #gaugeGradient（#ff3366 → #ff6b00 → #ffb800） -->
          <circle class="decision-gauge-fill" id="decisionGaugeFill" cx="80" cy="80" r="70"></circle>
        </svg>
        <div class="decision-gauge-center">
          <div class="decision-score-num" id="decisionScoreNum">--</div>
          <div class="decision-score-label">霞光指數</div>
        </div>
      </div>

      <div class="decision-answer">
        <div class="decision-verdict-badge" id="decisionVerdictBadge">分析中...</div>
        <h2 class="decision-verdict-line" id="decisionVerdictLine">正在判斷今晚值不值得出門</h2>
        <p class="decision-reason" id="decisionReasonText">正在初始化台灣 Open-Meteo 大氣觀測連線...</p>

        <div class="decision-actions">
          <a class="decision-primary-btn" id="decisionPrimaryBtn" href="#" target="_blank" rel="noopener">計算中...</a>
          <a class="decision-secondary-btn" id="decisionSecondaryBtn" href="#" target="_blank" rel="noopener" hidden>看直播就好</a>
        </div>

        <div class="decision-timing">
          <span class="decision-timing-label">最佳拍攝時刻</span>
          <strong id="decisionPeakTime">--:--</strong>
          <span id="decisionCountdown">倒數計算中...</span>
        </div>
      </div>
    </section>

    <!-- 今晚其他機位：分數來自每日鎖定檔，逐列標鎖定時間；
         當前所選機位會被排除，避免現算分數與鎖定分數互相矛盾。 -->
    <section class="other-spots-section" id="otherSpotsSection">
      <div class="card-title-bar">
        <h3 id="otherSpotsTitle">今晚其他機位</h3>
        <a class="info-chip" href="#interactiveMapSection">看全部機位</a>
      </div>
      <div class="other-spots-list" id="otherSpotsList"></div>
      <p class="other-spots-note" id="otherSpotsNote"></p>
    </section>

    <!-- 深層資訊入口：同頁錨點，四個目標都是既有區塊 -->
    <nav class="deep-dive-nav" id="deepDiveNav">
      <a href="#cloudProfileSection">
        <strong>垂直雲層剖面</strong>
        <span>高／中／低雲與上游光路取樣</span>
      </a>
      <a href="#forecast7daySection">
        <strong>未來一週趨勢</strong>
        <span>日出與日落雙軌 7 天預報</span>
      </a>
      <a href="#interactiveMapSection">
        <strong>全台機位地圖</strong>
        <span>同時比較各站今晚指數</span>
      </a>
      <a href="#verifySection">
        <strong>每日實況日報</strong>
        <span>昨日預測 vs 實測，逐日歸檔</span>
      </a>
    </nav>
```

3b. 為兩個既有區塊補上錨點 id（只加 id，其他屬性不動）：

- 雲層剖面所在的 section（`index.html:231` 的 `card-title-bar` 往上最近的
  `<section ...>` 開標籤）加上 `id="cloudProfileSection"`
- `<section class="forecast-7day-section">` 加上 `id="forecast7daySection"`

3c. 在 `<script defer src="js/app.js"></script>` 之前加入：

```html
  <script defer src="js/decision-hero.js"></script>
```

3d. 錨點平滑捲動與定位（加到 `css/style.css` 末端，Task 6 會補其餘樣式）：

```css
html { scroll-behavior: smooth; }
#cloudProfileSection, #forecast7daySection, #interactiveMapSection, #verifySection {
  scroll-margin-top: 24px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dom-bindings.js`
Expected: PASS — 含新增的 ✅ 決策優先版面骨架訊息

- [ ] **Step 5: 全套測試**

Run: `node tests/run-all-tests.js`
Expected: PASS，結尾 🏆
（注意：`test-dom-bindings.js` 會掃 `app.js` 用到但 HTML 沒有的 id。Task 5 才寫
`app.js`，所以此時不應有新缺口。）

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css tests/test-dom-bindings.js
git commit -m "feat(homepage): add decision hero + deep-dive nav markup"
```

---

### Task 5: app.js 串接（渲染決策區與其他機位）

**Files:**
- Modify: `js/app.js`（`render()` 內新增呼叫；新增三個方法）
- Test: `tests/test-dom-bindings.js`（既有的靜態掃描會驗證新 id 都存在於 HTML）

**Interfaces:**
- Consumes: `window.DecisionHero`（Task 1–3）、Task 4 的 DOM id、
  既有 `this.currentForecastData`、`this.activeSessionType`、`getActiveSessionData()`
- Produces: `SkyFireGPSApp.prototype.loadLockedStations()`、`renderDecisionHero(currentData)`、
  `renderOtherSpots(currentData)`、`downloadNextSessionIcs()`

**既有程式的真實名稱（已核對，照抄勿改）：**

| 用途 | 正確寫法 | 出處 |
|---|---|---|
| 使用者位置 | `this.currentLocation.lat` / `.lng` / `.name` | `js/app.js:7`、`160` |
| 當前選中機位 | `this.selectedSpot`（可為 `null`，有 `.id`/`.name`/`.lat`/`.lng`/`.liveUrl`） | `js/app.js:21`、`914` |
| 火燒雲窗口 | `data.dayMeta.solarTimes.sunsetSkyfireWindow` / `sunriseSkyfireWindow`，各有 `.start`/`.end`/`.peak` | `js/app.js:413-418` |
| 時刻格式化 | `SolarCalc.formatTime(date)` | `js/app.js:418` |
| 分數環週長 | `440`（r=70），既有 `gaugeFillCircle` 用同一個值 | `js/app.js:216` |
| 評級等級 | `EPIC` / `GREAT` / `MODERATE` / `FAINT` / `OVERCAST` | `js/skyfire-engine.js:195-235` |

**不存在、不要用：** `SolarCalc.formatCountdown`（無此函式，倒數是 `js/app.js:963` 的
`setInterval`）、`this.currentLat` / `this.currentLng`（正確為 `this.currentLocation.*`）、
`data.skyfireWindow`（正確為 `data.dayMeta.solarTimes.*SkyfireWindow`）。

- [ ] **Step 1: 寫入實作（本任務無新單元測試，行為由 Task 1–3 的單元測試 + Task 7 的手動版面檢查覆蓋）**

5a. 在 `js/app.js` 的 `render()`（`js/app.js:209`）中，`this.renderHeroGauge(currentData);`
**之前**插入兩行：

```js
    this.renderDecisionHero(currentData);
    this.renderOtherSpots(currentData);
```

5b. 新增鎖定檔載入。放在 `render()` 之前，並在建構流程中（`loadWeather` 成功後、
`this.render()` 之前）呼叫一次 `await this.loadLockedStations();`：

```js
  /**
   * 載入每日鎖定的逐站預報。scripts/lock-forecast-multi.js 每天算好並 commit，
   * 前端只抓這一個靜態檔——不對 Open-Meteo 發逐站請求，也不需要自己做快取
   * （sw.js 對同源檔案是 network-first，離線才回退）。
   * 鎖定工作是容錯的（run-job.sh:86），抓不到或過期都只是少顯示分數，不擋主流程。
   */
  async loadLockedStations() {
    this.lockedStations = { sunrise: null, sunset: null };
    await Promise.all(['sunrise', 'sunset'].map(async (session) => {
      try {
        const res = await fetch(`data/locked-${session}-multi-forecast.json`);
        if (!res.ok) return;
        this.lockedStations[session] = await res.json();
      } catch (err) {
        console.warn(`鎖定逐站預報載入失敗 (${session})，將只顯示距離`, err);
      }
    }));
  }
```

5c. 新增決策區渲染：

```js
  /**
   * 渲染決策區。資料全部來自 getActiveSessionData()，與 renderHeroGauge 同一份，
   * 不發任何新請求。
   */
  renderDecisionHero(data) {
    const hero = document.getElementById('decisionHero');
    if (!hero || !data) return;

    const score = data.skyfire.score;
    const rating = data.skyfire.rating;
    const isLow = ['OVERCAST', 'FAINT'].includes(rating.level);
    hero.dataset.verdict = isLow ? 'low' : 'go';

    document.getElementById('decisionScoreNum').textContent = score;
    document.getElementById('decisionVerdictBadge').textContent = `${rating.icon} ${rating.badge}`;
    document.getElementById('decisionVerdictLine').textContent = isLow
      ? (data.type === 'sunrise' ? '明早不用特地出門' : '今晚不用特地出門')
      : (data.type === 'sunrise' ? '明早值得出門' : '今晚值得出門');
    document.getElementById('decisionReasonText').textContent = rating.summary;

    // 分數環：週長 440（r=70），與既有 gaugeFillCircle 用同一個值
    const fill = document.getElementById('decisionGaugeFill');
    fill.style.strokeDasharray = '440';
    fill.style.strokeDashoffset = `${440 - (440 * score) / 100}`;

    // 巔峰時刻：照既有 peakWindowText 的取法（js/app.js:413-418）
    const windowObj = data.type === 'sunset'
      ? data.dayMeta.solarTimes.sunsetSkyfireWindow
      : data.dayMeta.solarTimes.sunriseSkyfireWindow;
    document.getElementById('decisionPeakTime').textContent =
      windowObj ? SolarCalc.formatTime(windowObj.peak) : SolarCalc.formatTime(data.time);
    // 倒數不在這裡算——接到既有的 setInterval 上（見 5e），避免兩份倒數各走各的

    const primary = document.getElementById('decisionPrimaryBtn');
    const secondary = document.getElementById('decisionSecondaryBtn');
    const spot = this.selectedSpot;

    if (isLow) {
      // 低分夜：主按鈕改為加入行事曆（零後端），次要按鈕看直播
      const next = DecisionHero.nextThreeSessions(
        this.currentForecastData.daysForecast, this.activeSessionType
      )[0];
      primary.textContent = next
        ? `${next.label}有 ${next.score} 分，加入行事曆`
        : '加入行事曆';
      primary.removeAttribute('target');
      primary.onclick = (e) => {
        e.preventDefault();
        this.downloadNextSessionIcs();
      };
      if (spot && spot.liveUrl) {
        secondary.hidden = false;
        secondary.href = spot.liveUrl;
      } else {
        secondary.hidden = true;
      }
    } else {
      primary.onclick = null;
      primary.setAttribute('target', '_blank');
      if (spot) {
        primary.textContent = `導航到${spot.name}`;
        primary.href = DecisionHero.mapsDirectionsUrl(spot.lat, spot.lng);
      } else {
        primary.textContent = '選一個機位';
        primary.href = '#interactiveMapSection';
      }
      secondary.hidden = true;
    }
  }

  /** 低分夜：把下一場寫成 .ics 下載（提醒交給使用者自己的行事曆） */
  downloadNextSessionIcs() {
    const next = DecisionHero.nextThreeSessions(
      this.currentForecastData.daysForecast, this.activeSessionType
    )[0];
    if (!next) return;
    const spotName = this.selectedSpot ? this.selectedSpot.name : '所選機位';
    const [hh, mm] = next.timeLabel.split(':').map(Number);
    const start = new Date(this.currentForecastData.daysForecast[1][next.type].time);
    start.setHours(hh, mm, 0, 0);
    const ics = DecisionHero.buildIcs({
      title: `${next.label}火燒雲 ${next.score} 分`,
      start,
      durationMinutes: 30,
      location: spotName,
      description: `霞光指數 ${next.score}，巔峰 ${next.timeLabel}（SkyFire GPS 預報）`
    });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `skyfire-${next.type}-${next.timeLabel.replace(':', '')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  }
```

5d. 新增其他機位渲染：

```js
  /**
   * 渲染「今晚其他機位」。分數只在鎖定檔的日期與時段都對得上時顯示，
   * 且排除當前所選機位——否則畫面上會同時出現現算分數與鎖定分數。
   */
  renderOtherSpots(data) {
    const list = document.getElementById('otherSpotsList');
    const note = document.getElementById('otherSpotsNote');
    const title = document.getElementById('otherSpotsTitle');
    if (!list || !data) return;

    const session = data.type;
    const isLow = ['OVERCAST', 'FAINT'].includes(data.skyfire.rating.level);

    // 低分夜換成「接下來三場」——同一塊版位，相反的答案
    if (isLow) {
      title.textContent = '接下來三場';
      const sessions = DecisionHero.nextThreeSessions(
        this.currentForecastData.daysForecast, this.activeSessionType
      );
      list.innerHTML = sessions.map((s) => `
        <div class="other-spot-row">
          <div class="other-spot-main">
            <div class="other-spot-name">${s.label} ${s.timeLabel}</div>
          </div>
          <div class="other-spot-score">${s.score}</div>
        </div>
      `).join('');
      note.textContent = '分數為模型預報，日齡越大信心越低。';
      return;
    }

    title.textContent = session === 'sunrise' ? '明早其他機位' : '今晚其他機位';

    // sv-SE 的日期格式恰為 YYYY-MM-DD，與鎖定檔的 date 欄位對得起來
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const locked = this.lockedStations ? this.lockedStations[session] : null;
    const matches = DecisionHero.lockedSessionMatches(locked, this.activeSessionType, todayStr);
    // 距離原點：已選機位優先，否則用使用者定位（this.currentLocation，app.js:7）
    const origin = this.selectedSpot || this.currentLocation;

    const rows = DecisionHero.buildOtherSpots({
      spots: TAIWAN_SPOTS,
      locked: matches ? locked : null,
      userLat: origin.lat,
      userLng: origin.lng,
      session,
      excludeSpotId: this.selectedSpot ? this.selectedSpot.id : null,
      limit: 3
    });

    list.innerHTML = rows.map((r) => `
      <div class="other-spot-row">
        <div class="other-spot-main">
          <div class="other-spot-name">${r.name}</div>
          <div class="other-spot-meta">
            ${r.distanceKm.toFixed(0)} 公里${r.lockedAtLabel ? ` · ${r.lockedAtLabel} 鎖定` : ''}
          </div>
        </div>
        ${r.score !== null
          ? `<div class="other-spot-score">${r.score}</div>`
          : `<div class="other-spot-noscore">${r.noScoreReason}</div>`}
        <a class="other-spot-nav" href="${DecisionHero.mapsDirectionsUrl(r.lat, r.lng)}"
           target="_blank" rel="noopener">導航</a>
      </div>
    `).join('');

    note.textContent = matches
      ? '分數為當日預先鎖定的逐站預報，與上方現算分數不同時刻產生。'
      : '此時段尚未鎖定逐站預報，僅顯示距離。';
  }
```

5e. **倒數接到既有的 setInterval 上，不要新寫第二份。** `js/app.js:963` 起已有一個每秒
更新 `countdownText` 的更新器。在它每一個寫入 `countdownText.innerText` 的分支之後，
把同一段文字也寫進 `decisionCountdown`。最省事的做法是在該函式開頭多取一個元素，
並改為同時寫入兩處：

```js
      const countdownText = document.getElementById('countdownText');
      const decisionCountdown = document.getElementById('decisionCountdown');
      if (!countdownText || !this.currentForecastData) return;

      // 既有三個分支的文字改為先存進變數，最後統一寫入兩處
      // （原本是直接 countdownText.innerText = '...'）
      // ...計算 diff 的既有邏輯不變...
      const label = /* 既有三個分支各自的字串 */;
      countdownText.innerText = label;
      if (decisionCountdown) decisionCountdown.innerText = label;
```

兩份倒數各自 `setInterval` 會在跨秒時顯示不同時間，同一畫面上看起來像 bug——
所以共用同一個更新器。

- [ ] **Step 2: 執行全套測試**

Run: `node tests/run-all-tests.js`
Expected: PASS。`test-dom-bindings.js` 會掃出 `app.js` 新用到的每個
`getElementById` 是否都存在於 `index.html`——若失敗，訊息會列出缺哪一個 id。

- [ ] **Step 3: 確認沒有用到不存在的名稱**

Run: `grep -n "formatCountdown\|currentLat\|currentLng\|data.skyfireWindow" js/app.js`
Expected: **無輸出**。有輸出代表用了本任務開頭「不存在、不要用」表列的名稱，必須改掉。

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(homepage): wire decision hero and locked per-spot scores"
```

---

### Task 6: 樣式（含低分夜與 390px）

**Files:**
- Modify: `css/style.css`（append 新區塊樣式）

**Interfaces:**
- Consumes: Task 4 的 class 名稱與 `data-verdict` 屬性

- [ ] **Step 1: 確認既有 token 名稱**

Run: `grep -n "^\s*--" css/style.css | head -30`
Expected: 列出既有 CSS 變數（圓角、陰影、色彩）。下一步必須使用這些既有 token 名稱，
不可自創數值。`--shadow-md` 必須含兩層（第二層 `0 8px 10px -6px rgba(0,0,0,0.3)`）。

- [ ] **Step 2: 寫入樣式**

在 `css/style.css` 末端加入決策區、其他機位、入口列三組樣式。要求：

- `.decision-hero` 桌機為兩欄（分數環 + 答案），390px 改為單欄。
- `.decision-gauge-fill` 用 `stroke: url(#gaugeGradient)`、`transform: rotate(-90deg)`
  與 `transform-origin: center`，`stroke-linecap: round`。
- `[data-verdict="low"]` 時：`.decision-gauge-fill` 改為灰色
  （用既有低分色 `#5A6275` / `#7B88A8`）且 **`stroke-linecap: butt`**——
  `round` 在低分那種短弧上會多出約 12 單位圓頭，12 分看起來像 15 分。
- 所有可點區域（`.decision-primary-btn`、`.decision-secondary-btn`、`.other-spot-nav`、
  `.deep-dive-nav a`）`min-height: 44px`。
- `.deep-dive-nav` 桌機四欄 `grid`，390px 改兩欄。
- 圓角與陰影只用既有 token。

- [ ] **Step 3: 瀏覽器實測（照 browser-cli skill 的做法）**

啟一個本機靜態伺服器後開啟首頁，分別在 1440px 與 390px 寬檢查：

1. 390px 下**沒有水平捲動**：`document.documentElement.scrollWidth <= 390`
2. 決策區在首屏內可完整看到分數、判斷句與主按鈕
3. 四個入口點下去會捲到正確區塊
4. 每個可點元素的 `getBoundingClientRect().height >= 44`

Expected: 四項全部成立；不成立就改樣式再測。

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "style(homepage): decision hero, other spots, deep-dive nav"
```

---

### Task 7: Service Worker 版號與五種狀態實測

**Files:**
- Modify: `sw.js:2`（`CACHE_NAME`）、`sw.js:3-15`（`ASSETS_TO_CACHE`）

**Interfaces:**
- Consumes: Task 4 新增的 `js/decision-hero.js`

**已確認：** `sw.js:43-60` 對同源檔案已是 network-first（成功就更新快取、離線才回退），
所以每天更新的 `data/locked-*-multi-forecast.json` 不會被凍住。只需 bump 版號並把新的
JS 檔加進預快取清單。

- [ ] **Step 1: 改 sw.js**

- `sw.js:2`：`skyfire-gps-taiwan-v5` → `skyfire-gps-taiwan-v6`
- `sw.js:3-15` 的 `ASSETS_TO_CACHE`：在 `'./js/spots-taiwan.js',` 之後加入
  `'./js/decision-hero.js',`

- [ ] **Step 2: 全套測試**

Run: `node tests/run-all-tests.js`
Expected: PASS，結尾 🏆

- [ ] **Step 3: 五種狀態實測**

在瀏覽器中逐一驗證（可用 DevTools 改檔案回應或暫時改 `activeSessionType` 觸發）：

1. **鎖定檔時段吻合**（今日日落 + 當天日落鎖定檔）→ 每列有分數與「HH:MM 鎖定」
2. **時段不吻合**（切到「明日日落」）→ 只有距離，附註寫「此時段尚未鎖定逐站預報」，
   **畫面上不得出現任何逐站分數**
3. **抓取失敗**（DevTools 封鎖該 JSON 請求）→ 同上，且 console 只有一行 warn、主流程不中斷
4. **金龍山**（日出時段、以南投附近為原點）→ 該列顯示「無預報（直播 DVR 過短，未納入驗證）」，
   不是 0 分
5. **當前機位被排除** → 「其他機位」清單中不出現上方決策區的那個機位

Expected: 五種狀態的畫面都與上述一致。

- [ ] **Step 4: 既有行為不回歸**

在瀏覽器中切換 `sessionSwitcher` 的每一個分頁，確認：
決策區、儀表板、雲層剖面、太陽時間軸、7 天預報、地圖方位角**全部同步更新**；
Leaflet 地圖仍正常顯示（同頁錨點不改變它的初始化時機）。

Expected: 無 console error，各區塊數字一致。

- [ ] **Step 5: Commit**

```bash
git add sw.js
git commit -m "chore(sw): bump cache to v6 and precache decision-hero.js"
```

---

## 自我檢查對照（spec → task）

| Spec 章節 | 由哪個 Task 實作 |
|---|---|
| §1 頁面結構（同頁錨點、四個入口） | Task 4 |
| §2 決策區資料來源（不發新請求、用既有 `#gaugeGradient`） | Task 4（骨架）、Task 5（渲染） |
| §3 資料來源與六條規則 | Task 1（挑選、金龍山、距離）、Task 2（時段對應、鎖定時間）、Task 3（導航連結）、Task 5（渲染與附註） |
| §4 低分夜（灰環 butt、看直播、接下來三場） | Task 3（接下來三場）、Task 5（切換）、Task 6（灰環樣式） |
| §5 加入行事曆 | Task 3（`.ics` 產生）、Task 5（下載） |
| §6 Service Worker | Task 7 |
| 測試（單元／五種狀態／版面／不回歸） | Task 1–3（單元）、Task 6（版面）、Task 7（狀態與不回歸） |
