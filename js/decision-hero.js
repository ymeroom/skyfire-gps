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

  /** ISO 時間 → 台北時間 HH:MM（全站無夏令時間處理，UTC+8） */
  formatLockedAt(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const taipei = new Date(d.getTime() + 8 * 3600 * 1000);
    const hh = String(taipei.getUTCHours()).padStart(2, '0');
    const mm = String(taipei.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  },

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
  },

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
    // 一律從「當前這一場的下一場」起算。若從固定的明日日出起算，看「明日日出」
    // 時第一筆就會是當前這一場，主畫面、主按鈕與清單會出現同一個數字三次。
    const CURRENT = {
      'today-sunrise': { idx: 0, type: 'sunrise' },
      'today-sunset': { idx: 0, type: 'sunset' },
      'tomorrow-sunrise': { idx: 1, type: 'sunrise' },
      'tomorrow-sunset': { idx: 1, type: 'sunset' },
      'day2-sunrise': { idx: 2, type: 'sunrise' }
    };
    const cur = CURRENT[afterSessionType];
    // 自訂時段（地圖／7 天卡片點選）無法對應到固定場次，退回今日日落之後
    const curIndex = cur
      ? seq.findIndex((s) => s.idx === cur.idx && s.type === cur.type)
      : seq.findIndex((s) => s.idx === 0 && s.type === 'sunset');
    const startAt = curIndex + 1;
    return seq.slice(startAt, startAt + 3).map((s) => ({
      type: s.type,
      label: `${s.day.dateFormatted} ${s.type === 'sunrise' ? '日出' : '日落'}`,
      timeLabel: s.data.time instanceof Date
        ? `${String(s.data.time.getHours()).padStart(2, '0')}:${String(s.data.time.getMinutes()).padStart(2, '0')}`
        : '--:--',
      score: s.data.skyfire ? s.data.skyfire.score : null,
      // 該場次的實際 Date：呼叫端據此組行事曆，不可自行假設日期索引
      time: s.data.time instanceof Date ? s.data.time : null
    }));
  }
};

// 支援全域與模組
if (typeof window !== 'undefined') {
  window.DecisionHero = DecisionHero;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DecisionHero;
}
