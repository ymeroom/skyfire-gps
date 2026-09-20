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
