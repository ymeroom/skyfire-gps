/**
 * score-ground-truth.js - Phase 2: 執行光學色彩分析並更新驗證資料庫 (SkyFire GPS)
 *
 * 加入 taipei-skyfire 的兩項硬化：(1) 用 spawnSync 傳陣列參數呼叫 Python
 * 分析器 (不再用字串組 shell 指令)，並附上 SHA-256 完整性驗證與
 * isValidatedLiveCaptureRecord 真偽把關；(2) 分析失敗時不再用隨機噪聲
 * 「假造」ground truth 分數混進校準迴圈 —— 舊版這裡會用
 * `predScore + (Math.random()-0.45)*12` 捏造一個看似合理的觀測值，
 * 這比擷取失敗更危險，因為它會被 auto-calibrate-model.py 當成真實觀測
 * 拿去訓練權重。分析失敗現在誠實記錄為 analysis_failed，不寫入假分數。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  OFFICIAL_STREAMS,
  isValidatedLiveCaptureRecord,
  validateOpticalResult
} = require('./live-capture-core.js');

function runPythonAnalyzer(scriptPath, snapshotPath, capturedAtIso, lat, lng) {
  const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const args = [scriptPath, snapshotPath];
  if (capturedAtIso) {
    args.push(capturedAtIso);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      args.push(String(lat), String(lng));
    }
  }
  const result = spawnSync(pythonBin, args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `analyzer exited with ${result.status}`).trim());
  }
  return validateOpticalResult(JSON.parse(result.stdout));
}

function assertSnapshotIntegrity(snapshotPath, expectedSha256) {
  if (!expectedSha256) return; // 舊紀錄可能沒有 sha256，不因此擋掉評分
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`validated snapshot is missing: ${snapshotPath}`);
  }
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('snapshot SHA-256 does not match capture provenance');
  }
}

function runGroundTruthScoring(targetDateStr = null, targetSession = 'sunset') {
  console.log('====================================================');
  console.log('🔬 啟動 SkyFire GPS Phase 2: 天空光學色彩直方圖分析與誤差檢驗');
  console.log('====================================================\n');

  const dataDir = path.join(__dirname, '../data');
  const recordsFile = path.join(dataDir, 'verification-records.json');
  const snapshotsDir = path.join(dataDir, 'snapshots');

  if (!fs.existsSync(recordsFile)) {
    console.log('⚠️ 尚未找到 verification-records.json，請先執行 Phase 1 擷取影像。');
    return;
  }

  let records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  const nowStr = targetDateStr || new Date().toISOString().split('T')[0];
  const targetId = `rec-${nowStr}-${targetSession}`;

  let record = records.find(r => r.id === targetId);
  if (!record) {
    console.log(`⚠️ 找不到今日紀錄 ${targetId}，尚無可驗證的紀錄。`);
    return;
  }

  if (!isValidatedLiveCaptureRecord(record)) {
    console.log(`⚠️ ${targetId} 不是已驗證的真實直播影格，跳過評分 (避免對未經驗證的證據評分)。`);
    return;
  }

  const snapshotFile = path.resolve(path.join(__dirname, '..'), record.snapshotUrl);
  const snapshotsRoot = path.resolve(snapshotsDir);
  if (!snapshotFile.startsWith(`${snapshotsRoot}${path.sep}`)) {
    console.log('⚠️ snapshot 路徑逸出驗證影像目錄，拒絕評分。');
    return;
  }
  try {
    assertSnapshotIntegrity(snapshotFile, record.capture && record.capture.sha256);
  } catch (err) {
    console.log(`⚠️ 影像完整性驗證失敗，拒絕評分: ${err.message}`);
    return;
  }

  console.log(`📸 分析目標檔案: ${record.snapshotUrl}`);

  // targetTime (非 capture.capturedAt) 才是影格畫面實際所屬的天文時刻 ——
  // capturedAt 記的是腳本執行的當下，DVR 回溯量大時兩者可能差到數小時。
  const source = OFFICIAL_STREAMS[record.session];
  const lat = source ? source.lat : undefined;
  const lng = source ? source.lng : undefined;

  let opticalResult = null;
  try {
    const scriptPath = path.join(__dirname, 'analyze_sky_ground_truth.py');
    opticalResult = validateOpticalResult(runPythonAnalyzer(scriptPath, snapshotFile, record.targetTime, lat, lng));
    console.log('✅ Python 光學色彩直方圖分析成功！');
  } catch (err) {
    console.error(`❌ Python 光學分析失敗，誠實記錄 analysis_failed，未捏造 ground truth: ${err.message}`);
    record.verification = {
      status: 'analysis_failed',
      groundTruthScore: null,
      errorAbsolute: null,
      error: err.message,
      verifiedAt: new Date().toISOString()
    };
    fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
    return;
  }

  const predictedScore = record.prediction.score;
  const groundTruthScore = opticalResult.score;
  const errorAbsolute = Math.abs(predictedScore - groundTruthScore);

  let accuracyVerdict = 'MISMATCH';
  let verdictBadge = '⚠️ 出現偏差需校準';
  if (errorAbsolute <= 8) {
    accuracyVerdict = 'EXACT_MATCH';
    verdictBadge = '🎯 極致精準 (誤差 ≤ 8分)';
  } else if (errorAbsolute <= 18) {
    accuracyVerdict = 'SLIGHT_DEVIATION';
    verdictBadge = '⚡ 輕微偏差 (誤差 ≤ 18分)';
  }

  record.verification = {
    status: 'verified_completed',
    groundTruthScore: groundTruthScore,
    groundTruthBadge: opticalResult.badge,
    groundTruthLevel: opticalResult.level,
    errorAbsolute: errorAbsolute,
    verdict: accuracyVerdict,
    verdictBadge: verdictBadge,
    chromaticPurity: opticalResult.chromatic_purity,
    skyCoveragePct: opticalResult.sky_coverage_pct,
    nightGate: opticalResult.nightGate || null,
    rainGate: opticalResult.rainGate || null,
    verifiedAt: new Date().toISOString(),
    engine: 'Optical Chromatic Histogram Analysis (CIELAB/HSV)',
    isSimulated: false
  };

  const verifiedList = records.filter(r => r.verification && r.verification.groundTruthScore !== null);
  const totalVerified = verifiedList.length;
  const totalError = verifiedList.reduce((acc, cur) => acc + cur.verification.errorAbsolute, 0);
  const avgMAE = totalVerified > 0 ? (totalError / totalVerified).toFixed(1) : 0;
  const withinToleranceCount = verifiedList.filter(r => r.verification.errorAbsolute <= 15).length;
  const accuracyPct = totalVerified > 0 ? ((withinToleranceCount / totalVerified) * 100).toFixed(1) : 100;

  console.log('\n📊 SkyFire GPS 驗證結果對比 summary:');
  console.log(`- 模型預測分數: ${predictedScore} 分 (${record.prediction.rating})`);
  console.log(`- 實況觀測分數: ${groundTruthScore} 分 (${opticalResult.badge})`);
  console.log(`- 絕對誤差: ${errorAbsolute} 分 [${verdictBadge}]`);
  console.log(`- 歷史累計觀測天數: ${totalVerified} 場`);
  console.log(`- 歷史累計平均誤差 (MAE): ${avgMAE} 分`);
  console.log(`- 歷史累計準確率 (±15分內): ${accuracyPct}%\n`);

  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  console.log('💾 驗證紀錄與評分已更新至 data/verification-records.json');
  console.log('====================================================\n');
}

const sessionArg = process.argv[2] || 'sunset';
runGroundTruthScoring(null, sessionArg);
