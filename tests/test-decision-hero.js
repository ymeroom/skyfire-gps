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

// 9. 「接下來三場」必須從當前這一場之後起算
// 看「明日日出」時，清單第一筆不可又是明日日出——那會讓主畫面、主按鈕、
// 清單三處出現同一個數字，正是本次改版要避免的自相矛盾。
const afterTomorrowSunrise = DecisionHero.nextThreeSessions(daysForecast, 'tomorrow-sunrise');
assert.strictEqual(afterTomorrowSunrise[0].type, 'sunset', '明日日出之後應為明日日落');
assert.strictEqual(afterTomorrowSunrise[0].score, 31, '應為明日日落 31 分');
assert.deepStrictEqual(
  afterTomorrowSunrise.map(s => s.score), [31, 57, 20],
  '應為明日日落、後日日出、後日日落'
);

const afterTodaySunrise = DecisionHero.nextThreeSessions(daysForecast, 'today-sunrise');
assert.strictEqual(afterTodaySunrise[0].score, 12, '今日日出之後應為今日日落');

const afterTomorrowSunset = DecisionHero.nextThreeSessions(daysForecast, 'tomorrow-sunset');
assert.strictEqual(afterTomorrowSunset[0].score, 57, '明日日落之後應為後日日出');

const afterDay2Sunrise = DecisionHero.nextThreeSessions(daysForecast, 'day2-sunrise');
assert.strictEqual(afterDay2Sunrise[0].score, 20, '後日日出之後應為後日日落');

// 當前這一場永遠不可出現在清單裡
['today-sunrise', 'today-sunset', 'tomorrow-sunrise', 'tomorrow-sunset'].forEach((sess) => {
  const dayIdx = sess.startsWith('today') ? 0 : 1;
  const type = sess.endsWith('sunrise') ? 'sunrise' : 'sunset';
  const selfLabel = `${daysForecast[dayIdx].dateFormatted} ${type === 'sunrise' ? '日出' : '日落'}`;
  const list = DecisionHero.nextThreeSessions(daysForecast, sess);
  assert(!list.some(s => s.label === selfLabel), `${sess}：清單不可包含當前這一場 (${selfLabel})`);
});

console.log('✅ 接下來三場從當前場次之後起算，不重複當前這一場');

// 10. 每一場都要帶回實際的 Date，呼叫端才不必假設日期索引
const seqCheck = DecisionHero.nextThreeSessions(daysForecast, 'tomorrow-sunset');
assert(seqCheck[0].time instanceof Date, '應回傳該場次的 Date');
assert.strictEqual(seqCheck[0].time.getDate(), 19, '明日日落之後應為 9/19 當天');
assert.strictEqual(seqCheck[0].time.getHours(), 5, '應為該日日出時刻 05:48');

console.log('✅ 場次帶回實際 Date（行事曆不再假設日期索引）');

// 11. 場次用語：判斷句要跟著實際日期與時段走，看「明日日落」不能寫成「今晚」
assert.strictEqual(DecisionHero.sessionPhrase(0, 'sunset', '今天 (9/22 週二)'), '今晚');
assert.strictEqual(DecisionHero.sessionPhrase(0, 'sunrise', '今天 (9/22 週二)'), '今早');
assert.strictEqual(DecisionHero.sessionPhrase(1, 'sunrise', '明天 (9/23 週三)'), '明早');
assert.strictEqual(DecisionHero.sessionPhrase(1, 'sunset', '明天 (9/23 週三)'), '明晚',
  '明日日落是「明晚」，不是「今晚」');
assert.strictEqual(DecisionHero.sessionPhrase(2, 'sunrise', '後天 (9/24 週四)'), '後天早上');
assert.strictEqual(DecisionHero.sessionPhrase(2, 'sunset', '後天 (9/24 週四)'), '後天晚上');
// 第 4 天起沒有口語說法，退回日期；dateFormatted 形如「9/25 (週五)」
assert.strictEqual(DecisionHero.sessionPhrase(3, 'sunset', '9/25 (週五)'), '9/25 晚上');
assert.strictEqual(DecisionHero.sessionPhrase(4, 'sunrise', '9/26 (週六)'), '9/26 早上');
// 缺資料時不可組出「undefined 晚上」
assert.strictEqual(DecisionHero.sessionPhrase(5, 'sunset', undefined), '這一場');

console.log('✅ 判斷句用語跟著日期與時段');

// 12. 低分夜的行事曆推薦：只推「真的比現在好」的場次，不可推更低分的下一場
const lowSessions = [
  { label: '後天 (9/24) 日出', score: 19, level: 'OVERCAST', time: new Date(2026, 8, 24, 5, 44) },
  { label: '後天 (9/24) 日落', score: 35, level: 'FAINT', time: new Date(2026, 8, 24, 17, 50) },
  { label: '9/25 日出', score: 5, level: 'OVERCAST', time: new Date(2026, 8, 25, 5, 44) }
];
assert.strictEqual(DecisionHero.pickPlannedSession(lowSessions, 35), null,
  '三場都不比現在好（且都是低分評級）時不可推薦');

const mixedSessions = [
  { label: '後天日出', score: 19, level: 'OVERCAST', time: new Date(2026, 8, 24, 5, 44) },
  { label: '後天日落', score: 71, level: 'GREAT', time: new Date(2026, 8, 24, 17, 50) },
  { label: '9/25 日出', score: 55, level: 'MODERATE', time: new Date(2026, 8, 25, 5, 44) }
];
assert.strictEqual(DecisionHero.pickPlannedSession(mixedSessions, 35).score, 71,
  '應挑三場裡分數最高的那一場');

// 分數雖高於現在，但評級仍屬低分夜 → 不值得特地安排
assert.strictEqual(
  DecisionHero.pickPlannedSession(
    [{ label: 'x', score: 40, level: 'FAINT', time: new Date() }], 35
  ),
  null,
  '比現在高但仍是 FAINT 的場次不算值得出門'
);

// 同分時取較早的那一場
const tieSessions = [
  { label: '早', score: 60, level: 'MODERATE', time: new Date(2026, 8, 24, 5, 44) },
  { label: '晚', score: 60, level: 'MODERATE', time: new Date(2026, 8, 24, 17, 50) }
];
assert.strictEqual(DecisionHero.pickPlannedSession(tieSessions, 35).label, '早', '同分取較早的一場');

// 沒有 level 時（舊資料）退回分數門檻
assert.strictEqual(DecisionHero.pickPlannedSession([{ label: 'y', score: 60, time: new Date() }], 35).score, 60);
assert.strictEqual(DecisionHero.pickPlannedSession([{ label: 'y', score: 40, time: new Date() }], 35), null);
// 無分數、無時間的場次不可入選（行事曆會組不出來）
assert.strictEqual(DecisionHero.pickPlannedSession([{ label: 'z', score: null, time: new Date() }], 10), null);
assert.strictEqual(DecisionHero.pickPlannedSession([{ label: 'z', score: 80, level: 'EPIC', time: null }], 10), null);
assert.strictEqual(DecisionHero.pickPlannedSession([], 10), null);

console.log('✅ 低分夜只推薦真的比現在好的場次');

// nextThreeSessions 要帶回評級，上面的挑選才有依據
const withLevels = DecisionHero.nextThreeSessions([
  { dateFormatted: '9/17', sunrise: { time: new Date(2026, 8, 17, 5, 46), skyfire: { score: 12, rating: { level: 'OVERCAST' } } },
    sunset: { time: new Date(2026, 8, 17, 18, 1), skyfire: { score: 70, rating: { level: 'GREAT' } } } }
], 'today-sunrise');
assert.strictEqual(withLevels[0].level, 'GREAT', '場次應帶回 rating.level');

console.log('✅ 接下來三場帶回評級');
