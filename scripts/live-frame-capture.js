/**
 * Capture one current frame from a validated YouTube livestream.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  validateLiveMetadata,
  finalizeCaptureEvidence
} = require('./live-capture-core.js');

function runExternalTool(command, args) {
  let finalCmd = command;
  let finalArgs = args;

  if (command === 'yt-dlp') {
    // Check if yt-dlp is available or fallback to python -m yt_dlp
    const testDirect = spawnSync('yt-dlp', ['--version'], { windowsHide: true });
    if (testDirect.error || testDirect.status !== 0) {
      finalCmd = 'python';
      finalArgs = ['-m', 'yt_dlp', ...args];
    }
  }

  const result = spawnSync(finalCmd, finalArgs, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${finalCmd} exited with ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function assertJpegFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 10000) {
    throw new Error(`captured JPEG is too small: ${stat.size} bytes`);
  }

  const buffer = fs.readFileSync(filePath);
  const hasJpegHeader = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const hasJpegTrailer = buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (!hasJpegHeader || !hasJpegTrailer) {
    throw new Error('captured file is not a complete JPEG image');
  }
  return buffer;
}

// YouTube 在沒有可用縮圖時會回傳低解析度佔位圖，必須擋掉
const MIN_POSTER_WIDTH = 640;
const MIN_POSTER_HEIGHT = 360;

/**
 * 由 JPEG 的 SOF 標記直接讀出影像尺寸
 * 不依賴 ffprobe，讓降級路徑在缺少外部工具時仍可驗證解析度。
 */
function readJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('not a JPEG buffer');
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 皆帶有尺寸欄位
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) throw new Error('malformed JPEG segment');
    offset += 2 + segmentLength;
  }
  throw new Error('JPEG dimensions not found');
}

function downloadImage(url) {
  const result = spawnSync('curl', [
    '-sL', '--max-time', '30',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '--output', '-', url
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'buffer' });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`curl exited with ${result.status}`);
  return result.stdout;
}

/**
 * Tier B: 由 i.ytimg.com 靜態 CDN 取回直播海報影格。
 *
 * YouTube 對資料中心 IP 施行 bot check，yt-dlp 在 GitHub 託管 runner 上
 * 必然失敗；但 i.ytimg.com 是純 CDN，不經過該檢查。海報影格由 YouTube
 * 定期自直播畫面重新產生，是真實但可能落後數分鐘的畫面，因此以
 * kind='youtube-live-poster'、fidelity='degraded' 明確標示，
 * 不與 yt-dlp 取得的精確影格混為一談。
 */
function capturePosterFrame({
  source,
  outputPath,
  windowEvidence,
  capturedAt = new Date(),
  fetchImage = downloadImage
}) {
  if (!source || !source.videoId || !outputPath) {
    throw new Error('source.videoId and outputPath are required');
  }
  if (!windowEvidence || !Number.isFinite(windowEvidence.offsetMinutes)) {
    throw new Error('capture window was not validated');
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error('invalid capture timestamp');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const candidates = ['maxresdefault', 'sddefault', 'hqdefault'];
  const failures = [];

  for (const quality of candidates) {
    const url = `https://i.ytimg.com/vi/${source.videoId}/${quality}.jpg`;
    let buffer;
    try {
      buffer = fetchImage(url);
    } catch (error) {
      failures.push(`${quality}: ${error.message}`);
      continue;
    }

    if (!Buffer.isBuffer(buffer) || buffer.length < 10000) {
      failures.push(`${quality}: payload too small (${buffer ? buffer.length : 0} bytes)`);
      continue;
    }
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
      failures.push(`${quality}: not a JPEG`);
      continue;
    }

    let dimensions;
    try {
      dimensions = readJpegDimensions(buffer);
    } catch (error) {
      failures.push(`${quality}: ${error.message}`);
      continue;
    }
    if (dimensions.width < MIN_POSTER_WIDTH || dimensions.height < MIN_POSTER_HEIGHT) {
      failures.push(`${quality}: resolution too small (${dimensions.width}x${dimensions.height})`);
      continue;
    }

    fs.writeFileSync(outputPath, buffer);
    return {
      kind: 'youtube-live-poster',
      fidelity: 'degraded',
      validated: true,
      sourceId: source.id,
      videoId: source.videoId,
      uploaderId: source.uploaderId || null,
      posterQuality: quality,
      posterUrl: url,
      capturedAt: capturedAt.toISOString(),
      eventTime: windowEvidence.eventTime,
      offsetMinutes: windowEvidence.offsetMinutes,
      maxOffsetMinutes: windowEvidence.maxOffsetMinutes,
      width: dimensions.width,
      height: dimensions.height,
      codec: 'mjpeg',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  throw new Error(`poster frame unavailable — ${failures.join('; ')}`);
}

// 啟動時間距出景當刻超過這個秒數，直播當下的畫面就不能代表那一刻，必須走 DVR 回溯
const DVR_REWIND_MIN_SECONDS = 60;

function requiresDvrRewind(offsetMinutes) {
  return Number.isFinite(offsetMinutes) && offsetMinutes * 60 > DVR_REWIND_MIN_SECONDS;
}

/**
 * 依 HLS 片段序號 (sq) 倒回 offsetSeconds 秒，把該片段第一格寫到 temporaryPath。
 * 成功回傳 null，失敗回傳原因字串，由呼叫端決定是否視為錯誤。
 * 最常見的失敗是目標片段已超出 DVR 視窗、被 CDN 回收，下載回來是空檔。
 */
function seekDvrSegment({ metadata, offsetSeconds, temporaryPath, runTool }) {
  const tempTs = `${temporaryPath}.ts`;
  try {
    const formats = (metadata.formats || []).filter(f => ['95', '96', '94', '93'].includes(String(f.format_id)) && f.url);
    const m3u8UrlToFetch = formats.length > 0 ? formats[0].url : metadata.manifest_url;
    if (!m3u8UrlToFetch) return 'no HLS manifest';

    const m3u8Content = runTool('curl', ['-s', m3u8UrlToFetch]) || '';
    const lines = m3u8Content.split('\n').filter(l => l.startsWith('http'));
    if (lines.length === 0) return 'empty HLS manifest';

    const latestUrl = lines[lines.length - 1];
    const sqMatch = latestUrl.match(/\/sq\/(\d+)\//);
    if (!sqMatch) return 'segment URL has no sequence number';
    const durMatch = latestUrl.match(/\/dur\/([\d\.]+)\//);
    const latestSq = parseInt(sqMatch[1], 10);
    const dur = durMatch ? parseFloat(durMatch[1]) : 5.0;

    const targetSq = latestSq - Math.floor(offsetSeconds / dur);
    const targetSegUrl = latestUrl.replace(/\/sq\/\d+\//, `/sq/${targetSq}/`);
    runTool('curl', ['-s', '-L', '-o', tempTs, targetSegUrl]);

    // 有效的 ts 片段通常 > 50KB
    if (!fs.existsSync(tempTs) || fs.statSync(tempTs).size <= 10000) {
      return `segment sq=${targetSq} reclaimed by CDN`;
    }
    runTool('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', tempTs,
      '-frames:v', '1',
      '-q:v', '2',
      temporaryPath
    ]);
    if (!fs.existsSync(temporaryPath)) return 'ffmpeg produced no frame from segment';
    return null;
  } catch (error) {
    return error.message;
  } finally {
    if (fs.existsSync(tempTs)) fs.rmSync(tempTs, { force: true });
  }
}

function captureLiveFrame({
  source,
  outputPath,
  windowEvidence,
  capturedAt = new Date(),
  runTool = runExternalTool
}) {
  if (!source || !outputPath) {
    throw new Error('source and outputPath are required');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp.jpg`;

  try {
    const metadataText = runTool('yt-dlp', [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--format',
      'best[protocol^=m3u8]/best',
      source.url
    ]);
    const metadata = JSON.parse(metadataText);
    const liveEvidence = validateLiveMetadata(metadata, source);

    const streamUrl = metadata.url;
    const offsetSeconds = windowEvidence && windowEvidence.offsetMinutes ? Math.max(0, windowEvidence.offsetMinutes * 60) : 0;
    const dvrRewound = requiresDvrRewind(windowEvidence && windowEvidence.offsetMinutes);

    if (dvrRewound) {
      // 直播當下離出景當刻太遠，只有回溯片段才代表那一刻。回溯失敗就是失敗：
      // 舊版在這裡退回直播當下，把早上九點的市景當成日出評分，還標成 exact。
      const failure = seekDvrSegment({ metadata, offsetSeconds, temporaryPath, runTool });
      if (failure) {
        throw new Error(`DVR rewind of ${windowEvidence.offsetMinutes} min failed (${failure}); live-edge frame would not show the event`);
      }
    } else {
      runTool('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-rw_timeout', '15000000',
        '-i', streamUrl,
        '-frames:v', '1',
        '-q:v', '2',
        temporaryPath
      ]);
    }

    const jpegBuffer = assertJpegFile(temporaryPath);
    const probeText = runTool('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'json',
      temporaryPath
    ]);
    const sha256 = crypto.createHash('sha256').update(jpegBuffer).digest('hex');
    const evidence = finalizeCaptureEvidence({
      liveEvidence,
      windowEvidence,
      probe: JSON.parse(probeText),
      sha256,
      capturedAt
    });

    fs.renameSync(temporaryPath, outputPath);
    return { ...evidence, dvrRewound };
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
    throw error;
  }
}

module.exports = {
  runExternalTool,
  assertJpegFile,
  readJpegDimensions,
  downloadImage,
  capturePosterFrame,
  captureLiveFrame,
  requiresDvrRewind,
  DVR_REWIND_MIN_SECONDS,
  MIN_POSTER_WIDTH,
  MIN_POSTER_HEIGHT
};
