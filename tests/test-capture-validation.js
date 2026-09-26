/**
 * test-capture-validation.js - 主站實況擷取：DVR 回溯失敗時不得拿錯時刻的畫面頂替
 *
 * 09:00 / 21:00 的補拍要從 YouTube DVR 倒回日出／日落當刻。舊版在回溯片段已被
 * CDN 回收時，默默改抓「現在」的直播畫面（或頻道的靜態宣傳縮圖），仍標成 exact，
 * 還覆蓋掉 05:30 / 18:45 已經拍好的紀錄（rec-2026-09-25-sunrise 等四筆）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureLiveFrame } = require('../scripts/live-frame-capture.js');
const { runCapturePipeline } = require('../scripts/capture-validation.js');
const { OFFICIAL_STREAMS } = require('../scripts/live-capture-core.js');
const SolarCalc = require('../js/solar-calc.js');

console.log('--- 🧪 測試 9: 實況擷取 DVR 回溯失敗的處理 ---');

const STREAM_URL = 'https://manifest.example/live-edge.m3u8';
const SEGMENT_MANIFEST_URL = 'https://manifest.example/format-93.m3u8';

// 可通過 assertJpegFile 的假 JPEG：SOI 開頭、EOI 結尾、大於 10KB
function fakeJpeg(fill) {
  const buf = Buffer.alloc(20000, fill);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  buf[buf.length - 2] = 0xff; buf[buf.length - 1] = 0xd9;
  return buf;
}

/**
 * 模擬 yt-dlp / curl / ffmpeg / ffprobe。
 * segmentAvailable=false 代表回溯目標片段已被 CDN 回收（curl 下載不到東西）。
 */
function makeRunTool({ source, segmentAvailable }) {
  const calls = [];
  const runTool = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'yt-dlp') {
      return JSON.stringify({
        id: source.videoId,
        uploader_id: source.uploaderId,
        is_live: true,
        live_status: 'is_live',
        protocol: 'm3u8_native',
        url: STREAM_URL,
        formats: [{ format_id: '93', url: SEGMENT_MANIFEST_URL }]
      });
    }
    if (cmd === 'curl' && args.includes('-o')) {
      if (segmentAvailable) fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.alloc(60000, 1));
      return '';
    }
    if (cmd === 'curl') {
      return 'https://seg.example/videoplayback/sq/5000/dur/5.0/file.ts\n';
    }
    if (cmd === 'ffmpeg') {
      fs.writeFileSync(args[args.length - 1], fakeJpeg(args.includes(STREAM_URL) ? 7 : 3));
      return '';
    }
    if (cmd === 'ffprobe') {
      return JSON.stringify({ streams: [{ codec_name: 'mjpeg', width: 640, height: 360 }] });
    }
    throw new Error(`unexpected tool ${cmd}`);
  };
  return { runTool, calls };
}

const usedLiveEdge = (calls) => calls.some(c => c.cmd === 'ffmpeg' && c.args.includes(STREAM_URL));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-capture-'));
const sunriseSource = OFFICIAL_STREAMS.sunrise;

// 1. 需要回溯（+195 分鐘）且片段已被回收 → 拋錯，不得退回直播當下
{
  const outputPath = path.join(tmpRoot, 'unit-reclaimed.jpg');
  const { runTool, calls } = makeRunTool({ source: sunriseSource, segmentAvailable: false });
  assert.throws(
    () => captureLiveFrame({
      source: sunriseSource,
      outputPath,
      windowEvidence: { eventTime: '2026-09-24T21:44:35.213Z', offsetMinutes: 195, maxOffsetMinutes: 600 },
      capturedAt: new Date('2026-09-25T01:00:04Z'),
      runTool
    }),
    /DVR/,
    '回溯失敗必須拋錯'
  );
  assert(!usedLiveEdge(calls), '回溯失敗時不可改抓直播當下的畫面');
  assert(!fs.existsSync(outputPath), '回溯失敗時不可寫出影格');
  console.log('✅ 回溯片段被回收時拒絕以直播當下畫面頂替');
}

// 2. 需要回溯且片段還在 → 用回溯片段，不碰直播當下
{
  const outputPath = path.join(tmpRoot, 'unit-rewound.jpg');
  const { runTool, calls } = makeRunTool({ source: sunriseSource, segmentAvailable: true });
  const evidence = captureLiveFrame({
    source: sunriseSource,
    outputPath,
    windowEvidence: { eventTime: '2026-09-24T21:44:35.213Z', offsetMinutes: 195, maxOffsetMinutes: 600 },
    capturedAt: new Date('2026-09-25T01:00:04Z'),
    runTool
  });
  assert(!usedLiveEdge(calls), '回溯成功時不該再抓直播當下');
  assert.strictEqual(fs.readFileSync(outputPath)[100], 3, '寫出的應是回溯片段的影格');
  assert.strictEqual(evidence.dvrRewound, true, '證據應註明影格來自 DVR 回溯');
  console.log('✅ 回溯成功時使用出景當刻的片段');
}

// 3. 不需回溯（05:30 在日出前 15 分鐘）→ 照舊抓直播當下
{
  const outputPath = path.join(tmpRoot, 'unit-live.jpg');
  const { runTool, calls } = makeRunTool({ source: sunriseSource, segmentAvailable: false });
  const evidence = captureLiveFrame({
    source: sunriseSource,
    outputPath,
    windowEvidence: { eventTime: '2026-09-24T21:44:35.213Z', offsetMinutes: -15, maxOffsetMinutes: 600 },
    capturedAt: new Date('2026-09-24T21:30:04Z'),
    runTool
  });
  assert(usedLiveEdge(calls), '不需回溯時應抓直播當下');
  assert.strictEqual(evidence.dvrRewound, false);
  console.log('✅ 不需回溯的時段照舊擷取直播當下');
}

// --- 整條管線 ---

function setupDataDir(name, { withExistingExact }) {
  const dataDir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'locked-sunrise-forecast.json'), JSON.stringify({
    date: '2026-09-25',
    lockedAt: '2026-09-24T15:45:00.000Z',
    skyfire: {
      score: 26,
      rating: { badge: '陰沉沉寂', color: '#5A6275' },
      metrics: { horizonClearance: 60, visKm: 20 }
    },
    weather: { cloudHigh: 0, cloudMid: 0, cloudLow: 1 }
  }));
  if (withExistingExact) {
    const snapshot = fakeJpeg(9);
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-09-25-sunrise.jpg'), snapshot);
    fs.writeFileSync(path.join(dataDir, 'verification-records.json'), JSON.stringify([{
      id: 'rec-2026-09-25-sunrise',
      date: '2026-09-25',
      session: 'sunrise',
      snapshotUrl: 'data/snapshots/2026-09-25-sunrise.jpg',
      prediction: { score: 26 },
      capture: {
        kind: 'youtube-live-frame', fidelity: 'exact', validated: true,
        width: 1920, height: 1080, offsetMinutes: -15,
        capturedAt: '2026-09-24T21:30:04.379Z', sha256: 'a'.repeat(64)
      },
      verification: { status: 'verified_completed', groundTruthScore: 19, isSimulated: false }
    }], null, 2));
  }
  return dataDir;
}

// 09:00 TPE，日出後約 195 分鐘：必須回溯
const nineAm = new Date('2026-09-25T01:00:04Z');
const sunriseAt = SolarCalc.getTimes(new Date('2026-09-25T12:00:00+08:00'), sunriseSource.lat, sunriseSource.lng).sunrise;
assert((nineAm - sunriseAt) / 60000 > 60, '測試前提：09:00 距日出超過一小時');

const silence = (fn) => async (...args) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(...args); } finally { Object.assign(console, { log, warn, error }); }
};

(async () => {
  // 4. 已有 05:30 的精確紀錄，09:00 回溯失敗 → 原紀錄與影格原封不動，也不去抓海報
  {
    const dataDir = setupDataDir('pipe-keep', { withExistingExact: true });
    const recordsFile = path.join(dataDir, 'verification-records.json');
    const snapshotFile = path.join(dataDir, 'snapshots', '2026-09-25-sunrise.jpg');
    const recordsBefore = fs.readFileSync(recordsFile, 'utf8');
    const snapshotBefore = fs.readFileSync(snapshotFile);
    let posterFetched = false;
    const { runTool, calls } = makeRunTool({ source: sunriseSource, segmentAvailable: false });

    const record = await silence(runCapturePipeline)('sunrise', {
      now: nineAm,
      dataDir,
      runTool,
      fetchImage: () => { posterFetched = true; throw new Error('should not be called'); }
    });

    assert(!usedLiveEdge(calls), '管線不可改抓直播當下');
    assert(!posterFetched, '需要回溯的時段不可退到海報影格（海報只代表現在，甚至只是頻道縮圖）');
    assert.strictEqual(fs.readFileSync(recordsFile, 'utf8'), recordsBefore, '既有的精確紀錄不可被覆蓋');
    assert(fs.readFileSync(snapshotFile).equals(snapshotBefore), '既有影格不可被覆蓋');
    assert.strictEqual(record.verification.groundTruthScore, 19, '應回傳保留下來的原紀錄');
    console.log('✅ 補拍失敗時保留 05:30 的精確紀錄');
  }

  // 5. 沒有既有紀錄，09:00 回溯失敗 → 誠實記錄 capture_unavailable，不抓海報
  {
    const dataDir = setupDataDir('pipe-empty', { withExistingExact: false });
    let posterFetched = false;
    const { runTool } = makeRunTool({ source: sunriseSource, segmentAvailable: false });

    const record = await silence(runCapturePipeline)('sunrise', {
      now: nineAm,
      dataDir,
      runTool,
      fetchImage: () => { posterFetched = true; throw new Error('should not be called'); }
    });

    assert(!posterFetched, '需要回溯的時段不可退到海報影格');
    assert.strictEqual(record.verification.status, 'capture_unavailable');
    assert.strictEqual(record.capture.validated, false);
    console.log('✅ 沒有可用畫面時誠實記錄 capture_unavailable');
  }

  // 6. 已有 05:30 紀錄，09:00 回溯成功 → 照設計以回溯影格定稿
  {
    const dataDir = setupDataDir('pipe-final', { withExistingExact: true });
    const { runTool } = makeRunTool({ source: sunriseSource, segmentAvailable: true });

    const record = await silence(runCapturePipeline)('sunrise', { now: nineAm, dataDir, runTool });

    assert.strictEqual(record.capture.fidelity, 'exact');
    assert.strictEqual(record.verification.status, 'captured_ready_for_scoring', '回溯成功應以新影格定稿');
    console.log('✅ 補拍回溯成功時照常定稿');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
})().catch((err) => {
  console.error('\n❌ 實況擷取測試未通過:', err.message);
  process.exit(1);
});
