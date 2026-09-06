/**
 * merge-multi-station-calibration.js
 * 把 13 站縮時的「暮光窗口峰值」實測分數，跟 lock-forecast-multi.js 事前鎖定的
 * 各站預測配對，寫成 data/multi-station-records.json 供 auto-calibrate-model.py
 * 一併讀入校準。canonical 影格另複製一份到 data/snapshots/ (進版控)，讓之後要
 * 人工比對高分區間評分器時，那張圖還在 (縮時原始幀 data/timelapse/ 不進版控、
 * 30 天後只剩 CI artifact)。
 *
 * 刻意寫「另一個檔案」而不是併進 verification-records.json：
 *   1. 避開與 auto_validate_capture.yml 對 data/ 的併發 push 衝突。
 *   2. 出處由檔案本身宣告，光學評分器若在高分段被證實有問題，直接停用一個檔案
 *      就能把這批樣本全部撤出，不必從混合檔裡逐列挑。
 *
 * 用法: node scripts/merge-multi-station-calibration.js <sunrise|sunset> [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const OUT_FILE = path.join(DATA_DIR, 'multi-station-records.json');

// canonical 影格 (data/snapshots/<date>-<session>-<stationId>.jpg) 進版控供
// 日後人工比對評分器；GitHub Pages 直接發佈 repo，所以要修剪，別讓 base
// 大小無限長。單站官方管線的 <date>-<session>.jpg 不在此列、永遠保留。
const SNAP_RETENTION_DAYS = 45;
const TIMELAPSE_SNAP_RE = /^\d{4}-\d{2}-\d{2}-(sunrise|sunset)-.+\.jpg$/;

// 跳過原因在 workflow run 列表看不見，靜默三週後才發現 sunrise 樣本從沒累積。
// 印 ::warning:: 並寫進 job summary。
function warnSkip(msg) {
  console.warn(`⚠️ ${msg}`);
  console.log(`::warning::merge-multi-station-calibration: ${msg}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      fs.appendFileSync(summary, `- ⚠️ 13 站校準合併跳過：${msg}\n`);
    } catch {
      /* summary 寫入失敗不影響主流程 */
    }
  }
}

function pruneOldSnapshots() {
  const cutoff = Date.now() - SNAP_RETENTION_DAYS * 86400 * 1000;
  let removed = 0;
  let list = [];
  try {
    list = fs.readdirSync(SNAP_DIR);
  } catch {
    return;
  }
  for (const name of list) {
    if (!TIMELAPSE_SNAP_RE.test(name)) continue;
    const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m || Date.parse(`${m[1]}T12:00:00Z`) >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(SNAP_DIR, name));
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  if (removed) console.log(`🧹 修剪 ${removed} 張超過 ${SNAP_RETENTION_DAYS} 天的縮時 canonical 影格`);
}

// 與 score-ground-truth.js 完全一致的偏差判定門檻。
function verdictFor(errorAbsolute) {
  if (errorAbsolute <= 8) return ['EXACT_MATCH', '🎯 極致精準 (誤差 ≤ 8分)'];
  if (errorAbsolute <= 18) return ['SLIGHT_DEVIATION', '⚡ 輕微偏差 (誤差 ≤ 18分)'];
  return ['MISMATCH', '⚠️ 出現偏差需校準'];
}

const MIN_FRAMES_OK = 5; // 9 幀裡至少 5 幀成功，「窗口最高分」才有意義

function assessReliability(prediction, canonical, snapshotCopied) {
  if (prediction.isSimulated) {
    return [false, '預測來自離線模擬資料 (Open-Meteo 當時不可用)'];
  }
  if (!canonical || !canonical.available) {
    return [false, `該站縮時無成功影格 (${(canonical && canonical.reason) || 'unknown'})`];
  }
  if (!snapshotCopied) {
    return [false, 'canonical 影格檔案遺失，無法複製到 data/snapshots/ 供日後人工比對'];
  }
  if (canonical.allFramesNightGated) {
    return [false, '全部成功影格都被暗夜閘門封頂，窗口最高分只是 12 分封頂假象'];
  }
  if ((canonical.framesOk || 0) < MIN_FRAMES_OK) {
    return [false, `成功影格僅 ${canonical.framesOk}/9 張，窗口取樣過稀`];
  }
  if ((canonical.peakRegionUngatedOk || 0) < 1) {
    return [false, '峰值窗口內沒有未封頂的成功影格，恐系統性低估火燒雲峰值'];
  }
  if (canonical.rainGate && canonical.rainGate.isRaining) {
    return [false, 'canonical 影格為雨天畫面，濕路面/車燈反光易誤判暖色調'];
  }
  if (canonical.nightGate && canonical.nightGate.applied) {
    return [false, 'canonical 影格自身被暗夜閘門封頂'];
  }
  return [true, null];
}

function main() {
  const session = process.argv[2];
  if (session !== 'sunrise' && session !== 'sunset') {
    console.error('用法: node scripts/merge-multi-station-calibration.js <sunrise|sunset> [YYYY-MM-DD]');
    process.exit(1);
  }

  const lockFile = path.join(DATA_DIR, `locked-${session}-multi-forecast.json`);
  if (!fs.existsSync(lockFile)) {
    warnSkip(`找不到鎖定預測 locked-${session}-multi-forecast.json (lock-forecast-multi.js 可能尚未跑)`);
    return;
  }
  const locked = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (!Array.isArray(locked.stations) || !locked.stations.length) {
    warnSkip('鎖定預測沒有 stations 陣列');
    return;
  }

  const dateStr = process.argv[3] || locked.date;
  const timelapseFile = path.join(DATA_DIR, 'timelapse', `${dateStr}-${session}.json`);
  if (!fs.existsSync(timelapseFile)) {
    warnSkip(`找不到縮時評分檔 ${dateStr}-${session}.json`);
    return;
  }
  const timelapse = JSON.parse(fs.readFileSync(timelapseFile, 'utf8'));

  if (locked.date !== dateStr || timelapse.date !== dateStr) {
    warnSkip(
      `日期不一致 (lock=${locked.date} timelapse=${timelapse.date} target=${dateStr})，跳過避免張冠李戴`
    );
    return;
  }

  const predById = new Map(locked.stations.map((s) => [s.id, s]));
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
  pruneOldSnapshots();

  const nowIso = new Date().toISOString();
  const newRecords = [];

  for (const st of timelapse.stations || []) {
    const pred = predById.get(st.id);
    if (!pred) {
      console.log(`  – ${st.id}: 無對應鎖定預測，略過`);
      continue;
    }
    const canonical = st.canonical || null;

    // canonical 影格 → data/snapshots/<date>-<session>-<id>.jpg
    let snapshotCopied = false;
    const snapName = `${dateStr}-${session}-${st.id}.jpg`;
    const snapDest = path.join(SNAP_DIR, snapName);
    if (canonical && canonical.available && canonical.imagePath) {
      const src = path.join(__dirname, '..', canonical.imagePath);
      try {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, snapDest);
          snapshotCopied = true;
        }
      } catch (e) {
        console.warn(`  ⚠️ ${st.id} 複製 canonical 影格失敗: ${e.message}`);
      }
    }

    const [reliable, unreliableReason] = assessReliability(pred, canonical, snapshotCopied);

    const w = pred.weather || {};
    const m = (pred.skyfire && pred.skyfire.metrics) || {};
    // 欄位刻意跟單站管線 capture-validation.js 寫的 prediction 對齊 (不含
    // humidity/precipProb)：auto-calibrate 的 calculate_score 對兩批樣本用
    // 同一組 weights，若只有這批帶 humidity/precipProb，moistureMax 項就只在
    // 一半樣本上有變化，等於兩批樣本的特徵完整度不一致。
    const prediction = {
      score: pred.skyfire.score,
      rating: pred.skyfire.rating && pred.skyfire.rating.badge,
      color: pred.skyfire.rating && pred.skyfire.rating.color,
      highCloud: w.cloudHigh || 0,
      midCloud: w.cloudMid || 0,
      lowCloud: w.cloudLow || 0,
      horizonClearance: m.horizonClearance,
      visibilityKm: m.visKm,
      isSimulated: pred.isSimulated === true,
      lockedAt: locked.lockedAt
    };

    const hasGt = !!(canonical && canonical.available);
    const offLabel = hasGt
      ? `T${canonical.offsetMin >= 0 ? '+' : ''}${canonical.offsetMin}`
      : '未擷取';
    const gt = hasGt ? canonical.score : null;
    const errorAbsolute = gt === null ? null : Math.abs(prediction.score - gt);
    const [verdict, verdictBadge] = errorAbsolute === null ? [null, null] : verdictFor(errorAbsolute);

    newRecords.push({
      id: `rec-${dateStr}-${session}-${st.id}`,
      date: dateStr,
      session,
      provenance: 'multi-station-timelapse',
      source: `${pred.name}（13 站縮時 ${offLabel}）`,
      targetTime: (canonical && canonical.capturedAtUtc) || null,
      prediction,
      snapshotUrl: snapshotCopied ? `data/snapshots/${snapName}` : null,
      capture: {
        kind: 'youtube-live-frame',
        fidelity: 'exact',
        validated: snapshotCopied,
        canonicalOffsetMin: canonical ? canonical.offsetMin : null,
        framesOk: canonical ? canonical.framesOk : 0,
        framesTotal: canonical ? canonical.framesTotal : 9,
        ungatedFramesOk: canonical ? canonical.ungatedFramesOk : 0,
        peakRegionUngatedOk: canonical ? canonical.peakRegionUngatedOk : 0,
        sourceFramePath: canonical ? canonical.imagePath : null,
        capturedAt: nowIso
      },
      verification: {
        status: gt === null ? 'capture_unavailable' : 'verified_completed',
        groundTruthScore: gt,
        groundTruthBadge: canonical && canonical.badge,
        groundTruthLevel: canonical && canonical.level,
        errorAbsolute,
        verdict,
        verdictBadge,
        chromaticPurity: canonical && canonical.chromaticPurity,
        skyCoveragePct: canonical && canonical.skyCoveragePct,
        nightGate: (canonical && canonical.nightGate) || null,
        rainGate: (canonical && canonical.rainGate) || null,
        reliable,
        unreliableReason,
        verifiedAt: nowIso,
        engine: 'Optical Chromatic Histogram Analysis (CIELAB/HSV) · 13-station timelapse window peak',
        isSimulated: false
      }
    });
  }

  // 併入既有檔案，同 id 覆寫 (同一天重跑冪等)
  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  const newIds = new Set(newRecords.map((r) => r.id));
  const merged = existing.filter((r) => !newIds.has(r.id)).concat(newRecords);
  merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2), 'utf8');

  const reliableCount = newRecords.filter((r) => r.verification.reliable).length;
  console.log(
    `✅ 合併 ${newRecords.length} 站 (${reliableCount} 可靠 / ${newRecords.length - reliableCount} 不可靠) → ${OUT_FILE}`
  );
  console.log(`   檔案現有 ${merged.length} 筆 (${new Set(merged.map((r) => r.date)).size} 個不同日期)`);
}

main();
