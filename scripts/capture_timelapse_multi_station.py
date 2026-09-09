#!/usr/bin/env python3
"""
capture_timelapse_multi_station.py

日出/日落前後 40 分鐘、每 10 分鐘一張的多機位縮時光學評分 (13 站版)。

  日出：望高寮、阿里山生力農場、二寮觀日亭、七星潭月牙灣、
      三仙台八拱跨海步橋、華源曙光觀景台、阿里山小笠原山觀景台
      (晨昏雙絕)                                    → 7 站 × 9 張 = 63 張
      (金龍山 DVR 過短已移出，見 SUNRISE_STATIONS 上方註解)
  日落：高美濕地、阿里山二延平步道、白河火山碧雲寺、桃園大古山、
      永安漁港、阿里山小笠原山觀景台 (晨昏雙絕)      → 6 站 × 9 張 = 54 張

時間點: T-40, T-30, T-20, T-10, T, T+10, T+20, T+30, T+40 (共 9 個)。

全台 13 站共用「同一組」錨點時刻 T 與暗夜閘門窗口 (見下方 REFERENCE_LAT/
REFERENCE_LNG)。日出/日落時刻主要由季節決定，站點間的地理差距 (緯度、
海拔) 影響很小 —— 例如 2026-09-05 平地日出 05:36/日落 18:09 (中央氣象署)，
阿里山日出 05:41/日落 18:13 (山區觀日網站)，只差 4-5 分鐘，遠小於本工具
10 分鐘一格的取樣間距，故不需要逐站個別計算天文時刻。

作法是「事後 DVR 回溯」而非即時等待 —— 在事件發生 40 分鐘後（或任何時間，只要
在直播 DVR 緩衝範圍內）執行一次，靠 yt-dlp 抓到的 m3u8 用 /sq/<n>/ 序號往回抓
9 個不同時間點的切片，一次 yt-dlp -J 呼叫打完 9 張，不必真的等 80 分鐘。

輸出:
  data/timelapse/<date>-<session>/<station>-t±NN.jpg   (原始影格，本機用，不進 git)
  data/timelapse/<date>-<session>.json                 (結構化評分資料)
  data/timelapse/<date>-<session>-report.html          (單檔 HTML 報告，圖片皆內嵌 base64)

用法:
  python scripts/capture_timelapse_multi_station.py sunrise [YYYY-MM-DD]
  python scripts/capture_timelapse_multi_station.py sunset  [YYYY-MM-DD]
"""

import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.dirname(__file__))
from analyze_sky_ground_truth import (  # noqa: E402
    analyze_image_optics,
    get_twilight_window,
    fetch_hourly_weather_series,
)

OFFSETS_MIN = [-40, -30, -20, -10, 0, 10, 20, 30, 40]

# 火燒雲峰值通常落在事件前後這段窗口 (日落後 / 日出前的暮光橘紅段)。
# 校準用的 canonical ground truth 必須在這裡「有一張沒被暗夜閘門封頂的
# 成功影格」，否則窗口取樣太稀、系統性低估峰值 —— merge 腳本會據此把
# 該站標成 unreliable。
PEAK_OFFSETS = {
    "sunset": {0, 10, 20, 30},
    "sunrise": {-20, -10, 0, 10},
}


def compute_canonical_ground_truth(session, frames):
    """從一站 9 幀裡挑出代表當日的 ground truth ＝暮光窗口內分數最高的成功影格。

    「窗口最高分」是「今天到底有沒有燒」的標準標記法：火燒雲可能只燒 10-15
    分鐘，天文時刻那一幀往往還沒開始。回傳 dict 一律帶齊 reliability 判斷所需
    的欄位，實際可不可信由 merge 腳本裁定。
    """
    ok_frames = [f for f in frames if f.get("ok") and f.get("score") is not None]
    ungated = [f for f in ok_frames if not (f.get("nightGate") or {}).get("applied")]
    peak_set = PEAK_OFFSETS.get(session, set())
    peak_ungated = [f for f in ungated if f.get("offsetMin") in peak_set]

    summary = {
        "framesOk": len(ok_frames),
        "framesTotal": len(frames),
        "ungatedFramesOk": len(ungated),
        "peakRegionUngatedOk": len(peak_ungated),
    }

    if not ok_frames:
        # 把失敗原因歸類 (每格的訊息帶不同 sq/分鐘數，不歸類會 9 格全不同)，
        # 記下主要類別 + 一則樣本，供 merge 腳本寫進 multi-station-records.json
        # 的 unreliableReason —— 下次同樣狀況不必再翻 workflow log。
        def _bucket(err):
            if "DVR 回溯範圍" in err:
                return "直播 DVR 視窗過短 (清單下緣)"
            if "實際可回溯範圍" in err or "CDN 回收" in err or "404" in err:
                return "目標時刻已被 CDN 回收 (清單宣稱視窗 > 實際)"
            if "manifest" in err or "is_live" in err or "m3u8" in err:
                return "無法取得直播串流 manifest"
            if "檔案過小" in err:
                return "擷取影格損毀 / 過小"
            if "尚未發生" in err:
                return None
            return err.split("(")[0].strip() or "unknown"

        buckets = Counter(b for f in frames if (b := _bucket(f.get("error", ""))))
        if buckets:
            top, n = buckets.most_common(1)[0]
            reason = f"{top} (9 格中 {n} 格)" if n < len([f for f in frames if f.get("error")]) else top
        else:
            reason = "no successful frame"
        return {**summary, "available": False, "reason": reason}

    # canonical 分數＝「峰值窗口內、未被暗夜閘門封頂」的成功影格裡最高分。
    # 刻意限制在峰值窗口 (日落後 0~30 分 / 日出前 20 分~日出後 10 分)：
    # 火燒雲的橘紅段就在這裡，取全 ±40 分窗口的 max 會把日落前 20-40 分的
    # 白亮天空或鏡頭耀光也算進來，系統性高估 (2026-09-05 實測就有站點在
    # T-20 被評到 100 分)。峰值窗口內沒有可用影格時 available 仍為 True (要
    # 有 groundTruthScore 可記)，但下方 merge 腳本會依 peakRegionUngatedOk
    # 把該站標成 unreliable。
    if peak_ungated:
        pool = peak_ungated
    elif ungated:
        pool = ungated
    else:
        pool = ok_frames
    best = max(pool, key=lambda f: f.get("score", 0))

    return {
        **summary,
        "available": True,
        "allFramesNightGated": not ungated,
        "canonicalFromPeakWindow": bool(peak_ungated),
        "offsetMin": best.get("offsetMin"),
        "capturedAtUtc": best.get("capturedAtUtc"),
        "imagePath": best.get("imagePath"),
        "score": best.get("score"),
        "level": best.get("level"),
        "badge": best.get("badge"),
        "chromaticPurity": best.get("chromatic_purity"),
        "skyCoveragePct": best.get("sky_coverage_pct"),
        "nightGate": best.get("nightGate"),
        "rainGate": best.get("rainGate"),
    }

# 座標與直播網址取自 js/spots-taiwan.js，2026-09-05 已用 yt-dlp -J
# 逐一實測確認 is_live=true / live_status=is_live。
# 金龍山 (tEcHWBlxAGM) 已移出縮時擷取清單：該直播的 DVR 視窗僅 ~25 秒
# (播放清單只有 5 個 segment)，任何排程延遲都拿不到日出當刻的回溯影格，
# 連準時執行也撈不到 T-40。目前無其他在線的金龍山 4K 直播可替代。它仍
# 保留在 js/spots-taiwan.js 作為可造訪的攝影點 (地圖 / 直播連結不受影響)，
# 只是不列入 ground truth 光學驗證。找到有 DVR 的替代源再加回。
SUNRISE_STATIONS = [
    {"id": "gaowangliao", "name": "望高寮", "url": "https://www.youtube.com/watch?v=lhXXhDyjFtI",
     "lat": 24.151718912445833, "lng": 120.58055599700907},
    {"id": "alishan-shengli", "name": "阿里山生力農場", "url": "https://www.youtube.com/watch?v=agEzlv9n9Eg",
     "lat": 23.432136451292212, "lng": 120.66435735771614},
    {"id": "erliao", "name": "二寮觀日亭", "url": "https://www.youtube.com/watch?v=xbojeDKjcaM",
     "lat": 22.99299131190427, "lng": 120.40992624428871},
    {"id": "qixingtan", "name": "七星潭月牙灣", "url": "https://www.youtube.com/watch?v=qg-aHp2mvS8",
     "lat": 24.13771518032825, "lng": 121.6590659570023},
    {"id": "sanxiantai", "name": "三仙台八拱跨海步橋", "url": "https://www.youtube.com/watch?v=X_fchztvqI0",
     "lat": 23.12428403334014, "lng": 121.40828968445186},
    {"id": "huayuan", "name": "華源曙光觀景台", "url": "https://www.youtube.com/watch?v=TY4qQElcUrA",
     "lat": 22.655120037370978, "lng": 121.02292067880808},
    {"id": "alishan-xiaoluji", "name": "阿里山小笠原山觀景台 (日出)", "url": "https://www.youtube.com/watch?v=6Y97q9KrhwA",
     "lat": 23.50633556703892, "lng": 120.82379800316035},
]

SUNSET_STATIONS = [
    {"id": "gaomei", "name": "高美濕地木棧道", "url": "https://www.youtube.com/watch?v=fjhg3gAnMFg",
     "lat": 24.31284018839888, "lng": 120.54737671005434},
    {"id": "alishan-eryanping", "name": "阿里山二延平步道", "url": "https://www.youtube.com/watch?v=j2L_559nCjc",
     "lat": 23.42464002262141, "lng": 120.65270096094285},
    {"id": "baihe-biyun", "name": "白河火山碧雲寺", "url": "https://www.youtube.com/watch?v=zkX6X9p-6iA",
     "lat": 23.325448310944992, "lng": 120.4802254991732},
    {"id": "dagushan", "name": "桃園大古山", "url": "https://www.youtube.com/watch?v=BxMeMnX6Qqw",
     "lat": 25.105746562588735, "lng": 121.28990867601294},
    {"id": "yongan", "name": "永安漁港", "url": "https://www.youtube.com/watch?v=tD_a03trUvE",
     "lat": 24.988000105826483, "lng": 121.01577075570127},
    {"id": "alishan-xiaoluji", "name": "阿里山小笠原山觀景台 (日落)", "url": "https://www.youtube.com/watch?v=6Y97q9KrhwA",
     "lat": 23.50633556703892, "lng": 120.82379800316035},
]


# 全台日出/日落時刻主要由「季節」決定，站點間的地理差距 (緯度/海拔) 影響
# 很小 —— 例如 2026-09-05 平地日出 05:36、日落 18:09 (中央氣象署)，阿里山
# 日出 05:41、日落 18:13 (山區觀日網站)，只差 4-5 分鐘。使用者確認「台高
# 差距不大」，故全部 13 站統一用同一組參考座標算出的錨點時刻，不再逐站
# 個別計算 (與 analyze_sky_ground_truth.py 的暗夜閘門共用同一組時刻)。
REFERENCE_LAT = 23.9737  # 台灣本島地理中心 (南投縣埔里鎮) 附近，作為全台代表座標
REFERENCE_LNG = 120.9820

# ⚠️ 這組參考座標「只」用於算錨點時刻 (get_anchor_time_utc) 與暗夜閘門的
# 暮光窗口 (get_twilight_window) —— 這兩者由季節決定，全台各站差距僅
# 4-5 分鐘，可以共用。降雨與否是真正因地點而異的天氣現象 (下方
# run_station 仍用各站自己的 station["lat"]/station["lng"] 呼叫
# fetch_hourly_weather_series 抓雨量)，兩者刻意不對稱、不要「為了一致性」
# 把雨天判定也改成用這組參考座標，那會讓雨天閘門對每一站都套用同一份
# (可能完全不相關地點的) 降雨資料，反而是錯的。


def get_anchor_time_utc(session, date_str):
    """透過 js/solar-calc.js (SolarCalc, 單一事實來源) 取得全台統一代表座標的當日日出/日落時刻。

    刻意不在 Python 重寫天文公式，避免跟網站本身的計算結果分歧。以中午為
    錨點日期基準 —— 全台皆為 UTC+8，用中午避免 UTC 換日抓錯一天。
    """
    node_script = (
        "const SolarCalc = require('./js/solar-calc.js');"
        "const t = SolarCalc.getTimes(new Date(process.argv[1] + 'T12:00:00+08:00'), "
        "parseFloat(process.argv[2]), parseFloat(process.argv[3]));"
        "console.log(JSON.stringify({sunrise: t.sunrise, sunset: t.sunset}));"
    )
    r = subprocess.run(
        ["node", "-e", node_script, date_str, str(REFERENCE_LAT), str(REFERENCE_LNG)],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=30
    )
    if r.returncode != 0:
        raise RuntimeError(f"SolarCalc 呼叫失敗: {r.stderr.strip()}")
    times = json.loads(r.stdout)
    key = "sunrise" if session == "sunrise" else "sunset"
    iso = times[key]
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def fetch_stream_manifest(watch_url):
    """呼叫一次 yt-dlp -J，回傳 (latest_sq, dur, latest_url_template) 供多次 sq 位移套用。"""
    r = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-J", watch_url],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 失敗: {r.stderr.strip()[:300]}")
    data = json.loads(r.stdout)
    if not data.get("is_live"):
        raise RuntimeError("直播目前非 is_live 狀態")

    # 依偏好順序挑格式：480p 為主。360p (fmt 93) 對夜景 / 日出前的暗畫面
    # 壓縮到 8KB 以下，會被 capture_frame_at 的體積下限判成「檔案過小」
    # (三仙台 X_fchztvqI0 就是這樣連續 0/9)。480p 起跳可穩定過關，頻寬仍低，
    # 對光學色彩直方圖分析也夠用。
    by_id = {f.get("format_id"): f for f in data.get("formats", []) if f.get("url")}
    m3u8_url = None
    for fmt_id in ["94", "95", "96", "93"]:
        if fmt_id in by_id:
            m3u8_url = by_id[fmt_id]["url"]
            break
    if not m3u8_url:
        m3u8_url = data.get("manifest_url")
    if not m3u8_url:
        raise RuntimeError("找不到可用的 m3u8 manifest")

    req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        lines = [l for l in resp.read().decode('utf-8').strip().split('\n') if l.startswith('http')]
    if not lines:
        raise RuntimeError("m3u8 播放清單為空")

    latest_url = lines[-1]
    m_sq = re.search(r'/sq/(\d+)/', latest_url)
    m_dur = re.search(r'/dur/([\d.]+)/', latest_url)
    if not m_sq:
        raise RuntimeError("無法從 manifest 解析 sq 序號")

    latest_sq = int(m_sq.group(1))
    dur = float(m_dur.group(1)) if m_dur else 5.0

    # 播放清單第一條 http 行 = 宣稱的最舊 segment。實測有些站 (三仙台
    # X_fchztvqI0) 清單宣稱 240 分鐘、實際只有 ~75 分鐘拿得到，更舊一律
    # 404。這裡不做二分探測 (探測本身受 CDN 抖動影響，反而可能誤縮一個
    # 好的視窗、害到本來能抓的站)。earliest_sq 只用來擋 target_sq 跌破
    # 清單下緣 / 變負的硬錯 (金龍山 tEcHWBlxAGM 那種 ~0 DVR)；清單有效
    # 但 CDN 對舊格 404 的情形，交給 capture_frame_at 把 404 歸類成
    # 「超出實際可回溯範圍」再往上拋。
    m_first = re.search(r'/sq/(\d+)/', lines[0])
    earliest_sq = int(m_first.group(1)) if m_first else 0
    return latest_sq, dur, latest_url, earliest_sq


def capture_frame_at(latest_url, latest_sq, dur, seconds_ago, output_jpg, earliest_sq=0):
    target_sq = latest_sq - int(seconds_ago / dur)
    # 不再 clamp 到 0：若目標時刻早於 DVR 視窗最舊影格，clamp 會改抓「現在」
    # 這一刻的影格 (直播若剛重啟、sq 從低號重編尤其危險)，它體積 > 10KB 會
    # 通過大小檢查，被當成峰值窗口的 ground truth 記入校準 —— 這正是
    # score-ground-truth.js 標頭警告過、比擷取失敗更危險的假分數。誠實報錯。
    if target_sq < earliest_sq:
        raise RuntimeError(
            f"目標時刻超出直播 DVR 回溯範圍 (需回溯 {seconds_ago / 60:.0f} 分鐘，"
            f"target sq={target_sq} < 可用最舊 sq={earliest_sq}；"
            f"DVR 視窗僅約 {(latest_sq - earliest_sq) * dur / 60:.0f} 分鐘)"
        )
    target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
    temp_ts = output_jpg.replace('.jpg', '.ts')
    os.makedirs(os.path.dirname(output_jpg), exist_ok=True)
    try:
        urllib.request.urlretrieve(target_url, temp_ts)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # segment 在清單裡但 CDN 已回收 —— 清單宣稱的視窗比實際可回溯的長。
            raise RuntimeError(
                f"目標時刻超出直播實際可回溯範圍 (回溯 {seconds_ago / 60:.0f} 分鐘, "
                f"sq={target_sq} 已被 CDN 回收 / 404)"
            ) from e
        raise
    subprocess.run(
        ["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg],
        capture_output=True, timeout=30
    )
    if os.path.exists(temp_ts):
        os.remove(temp_ts)
    # 下限 4KB：一張合法的暗色夜景 JPEG (480p) 約 8-15KB，壞掉 / 空的
    # ffmpeg 輸出是 0 或幾百 bytes。舊值 10KB 會誤殺偏暗的正常影格。
    size = os.path.getsize(output_jpg) if os.path.exists(output_jpg) else 0
    if size < 4000:
        raise RuntimeError(f"擷取的影格檔案過小或不存在 ({size} bytes)")


def offset_label(offset_min):
    return f"t{'+' if offset_min >= 0 else ''}{offset_min:02d}"


def run_station(station, anchor_utc, twilight_window, now_utc, out_dir):
    print(f"  📡 {station['name']} ({station['id']})")

    # 用本站真實座標抓雨量 —— 與 anchor_utc/twilight_window 共用 REFERENCE_LAT/LNG
    # 刻意不同 (見該常數旁的說明)：下雨是在地天氣現象，不能全台共用一份。
    rain_series = fetch_hourly_weather_series(station["lat"], station["lng"])

    frames = []
    try:
        latest_sq, dur, latest_url, earliest_sq = fetch_stream_manifest(station["url"])
    except Exception as e:
        print(f"    ❌ 無法取得直播 manifest: {e}")
        for offset_min in OFFSETS_MIN:
            frames.append({
                "offsetMin": offset_min,
                "ok": False,
                "error": f"manifest 取得失敗: {e}"
            })
        return frames

    dvr_minutes = (latest_sq - earliest_sq) * dur / 60
    oldest_lookback_min = (now_utc - (anchor_utc + datetime.timedelta(minutes=OFFSETS_MIN[0]))).total_seconds() / 60
    if dvr_minutes + 5 < oldest_lookback_min:
        print(f"    ⚠️  DVR 視窗僅約 {dvr_minutes:.0f} 分鐘，最舊擷取點需回溯 {oldest_lookback_min:.0f} 分鐘 —— 部分影格將超出範圍")

    for offset_min in OFFSETS_MIN:
        target_dt = anchor_utc + datetime.timedelta(minutes=offset_min)
        seconds_ago = (now_utc - target_dt).total_seconds()
        label = offset_label(offset_min)
        out_jpg = os.path.join(out_dir, f"{station['id']}-{label}.jpg")

        if seconds_ago < 0:
            print(f"    ⏭️  {label}: 時間點尚未發生 (在未來 {-seconds_ago/60:.1f} 分鐘)，略過")
            frames.append({"offsetMin": offset_min, "ok": False, "error": "目標時間尚未發生"})
            continue

        try:
            capture_frame_at(latest_url, latest_sq, dur, seconds_ago, out_jpg, earliest_sq)
            optics = analyze_image_optics(
                out_jpg,
                capture_time=target_dt,
                twilight_window=twilight_window,
                rain_series=rain_series,
                station_coords={"lat": station["lat"], "lng": station["lng"]}
            )
            night_gated = optics.get("nightGate", {}).get("applied")
            rain_gated = optics.get("rainGate", {}).get("applied")
            tag = ""
            if night_gated:
                tag += " 🌙 暗夜閘門已套用"
            if rain_gated:
                tag += " 🌧️ 雨天閘門已套用"
            print(f"    ✅ {label}: score={optics['score']} ({optics.get('level')}){tag}")
            frames.append({
                "offsetMin": offset_min,
                "ok": True,
                "capturedAtUtc": target_dt.isoformat(),
                "imagePath": os.path.relpath(out_jpg, REPO_ROOT).replace("\\", "/"),
                **optics
            })
        except Exception as e:
            print(f"    ❌ {label}: {e}")
            frames.append({"offsetMin": offset_min, "ok": False, "error": str(e)})

    return frames


def build_html_report(report, html_path):
    def img_data_uri(rel_path):
        abs_path = os.path.join(REPO_ROOT, rel_path)
        try:
            with open(abs_path, "rb") as f:
                return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")
        except Exception:
            return ""

    session_label = "日出" if report["session"] == "sunrise" else "日落"
    accent = "#f0b93d" if report["session"] == "sunrise" else "#e0592c"

    def score_color(score):
        if score is None:
            return "#5a6275"
        if score >= 82: return "#FF3366"
        if score >= 68: return "#FF6B00"
        if score >= 48: return "#E5A50A"
        if score >= 30: return "#7B88A8"
        return "#5A6275"

    rows_html = []
    for st in report["stations"]:
        cells = []
        chart_pts = []
        for i, fr in enumerate(st["frames"]):
            sign = "+" if fr["offsetMin"] >= 0 else ""
            label = f"T{sign}{fr['offsetMin']}"
            if fr.get("ok"):
                uri = img_data_uri(fr["imagePath"])
                score = fr.get("score")
                night_gate = fr.get("nightGate") or {}
                rain_gate = fr.get("rainGate") or {}
                night_gated = night_gate.get("applied")
                rain_gated = rain_gate.get("applied")
                gated = night_gated or rain_gated
                chart_pts.append(score if score is not None else 0)
                gate_notes = []
                if night_gated:
                    gate_notes.append(f'<div class="cell-gate" title="原始分數 {night_gate.get("rawScoreBeforeGate")}">🌙 暗夜閘門 (原 {night_gate.get("rawScoreBeforeGate")})</div>')
                if rain_gated:
                    gate_notes.append(f'<div class="cell-gate" title="降雨量 {rain_gate.get("precipitationMm")}mm">🌧️ 雨天閘門 (原 {rain_gate.get("rawScoreBeforeGate")})</div>')
                gate_note = "".join(gate_notes)
                cells.append(f'''
                <div class="cell{' cell-gated' if gated else ''}">
                  <div class="thumb"><img src="{uri}" loading="lazy" alt="{st['name']} {label}"></div>
                  <div class="cell-label">{label}</div>
                  <div class="cell-score" style="color:{score_color(score)}">{score if score is not None else '—'}</div>
                  <div class="cell-level">{fr.get('level','—')}</div>
                  {gate_note}
                </div>''')
            else:
                chart_pts.append(None)
                cells.append(f'''
                <div class="cell cell-fail">
                  <div class="thumb thumb-fail">⚠️</div>
                  <div class="cell-label">{label}</div>
                  <div class="cell-error">{fr.get('error','擷取失敗')}</div>
                </div>''')

        valid_scores = [f.get("score") for f in st["frames"] if f.get("ok") and f.get("score") is not None]
        peak = max(valid_scores) if valid_scores else None
        avg = round(sum(valid_scores) / len(valid_scores), 1) if valid_scores else None

        # 迷你折線圖 (純 SVG, 無函式庫)
        w, h, pad = 460, 70, 8
        n = len(chart_pts)
        step = (w - pad * 2) / (n - 1) if n > 1 else 0
        pts_str = []
        for i, v in enumerate(chart_pts):
            if v is None:
                continue
            x = pad + i * step
            y = h - pad - (v / 100) * (h - pad * 2)
            pts_str.append(f"{x:.1f},{y:.1f}")
        polyline = " ".join(pts_str)
        dots = "".join(
            f'<circle cx="{p.split(",")[0]}" cy="{p.split(",")[1]}" r="3" fill="{accent}"/>'
            for p in pts_str
        )

        rows_html.append(f'''
        <section class="station">
          <div class="station-head">
            <h2>{st['name']}</h2>
            <div class="station-stats">
              <span>峰值 <b style="color:{score_color(peak)}">{peak if peak is not None else '—'}</b></span>
              <span>平均 <b>{avg if avg is not None else '—'}</b></span>
            </div>
          </div>
          <svg class="trend" viewBox="0 0 {w} {h}" preserveAspectRatio="none">
            <line x1="{pad}" y1="{h-pad}" x2="{w-pad}" y2="{h-pad}" stroke="var(--rule)" stroke-width="1"/>
            <polyline points="{polyline}" fill="none" stroke="{accent}" stroke-width="2"/>
            {dots}
          </svg>
          <div class="grid">{''.join(cells)}</div>
        </section>''')

    generated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    html = f'''<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>{report['date']} {session_label}縮時光學評分 (全台13站)</title>
<style>
:root {{
  --ink:#161c30; --paper:#f8f9fb; --paper-raised:#ffffff; --rule:#d7dce6; --ink-soft:#5a6275;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --ink:#eef1f6; --paper:#0c0f1a; --paper-raised:#181c2b; --rule:#2a3049; --ink-soft:#aab3cc; }}
}}
* {{ box-sizing:border-box }}
body {{ margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',system-ui,sans-serif; }}
header {{ padding:32px 28px; background:linear-gradient(135deg,{accent}22,transparent); border-bottom:1px solid var(--rule); }}
header h1 {{ margin:0 0 6px; font-size:26px; }}
header p {{ margin:0; color:var(--ink-soft); font-size:13px; }}
main {{ max-width:1040px; margin:0 auto; padding:20px 28px 80px; }}
.station {{ padding:28px 0; border-bottom:1px solid var(--rule); }}
.station:last-child {{ border-bottom:none; }}
.station-head {{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; flex-wrap:wrap; gap:8px; }}
.station-head h2 {{ margin:0; font-size:20px; }}
.station-stats {{ font-size:13px; color:var(--ink-soft); display:flex; gap:16px; }}
.station-stats b {{ color:var(--ink); }}
.trend {{ width:100%; height:70px; display:block; margin-bottom:14px; }}
.grid {{ display:grid; grid-template-columns:repeat(9,1fr); gap:8px; }}
.cell {{ background:var(--paper-raised); border:1px solid var(--rule); border-radius:8px; padding:6px; text-align:center; }}
.thumb {{ width:100%; aspect-ratio:4/3; border-radius:5px; overflow:hidden; background:#000; }}
.thumb img {{ width:100%; height:100%; object-fit:cover; display:block; }}
.thumb-fail {{ display:flex; align-items:center; justify-content:center; font-size:22px; background:var(--paper); }}
.cell-label {{ font-family:monospace; font-size:11px; color:var(--ink-soft); margin-top:5px; }}
.cell-score {{ font-weight:700; font-size:15px; }}
.cell-level {{ font-size:10.5px; color:var(--ink-soft); }}
.cell-error {{ font-size:9.5px; color:var(--ink-soft); line-height:1.3; margin-top:4px; }}
.cell-gated {{ opacity:.72; }}
.cell-gate {{ font-size:9px; color:var(--ink-soft); margin-top:3px; }}
@media (max-width:900px) {{ .grid {{ grid-template-columns:repeat(3,1fr); }} }}
</style>
</head>
<body>
<header>
  <h1>{report['date']} {session_label}縮時光學評分 · 全台 {len(report['stations'])} 站</h1>
  <p>錨點 T = {report['anchorLocalLabel']} (台北時間，全台統一) · T-40 ~ T+40，每 10 分鐘一張 · 產生於 {generated_at}</p>
  <p>🌙 暗夜閘門：暮光窗外的暖色像素強制視為人工光源，分數上限 12 分 · 🌧️ 雨天閘門：下雨時分數上限 30 分</p>
</header>
<main>
  {''.join(rows_html)}
</main>
</body>
</html>'''

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)


def run(session, date_str=None):
    if date_str is None:
        date_str = datetime.datetime.now().strftime("%Y-%m-%d")

    stations = SUNRISE_STATIONS if session == "sunrise" else SUNSET_STATIONS
    session_label = "日出" if session == "sunrise" else "日落"
    taipei_tz = datetime.timezone(datetime.timedelta(hours=8))
    now_utc = datetime.datetime.now(datetime.timezone.utc)

    # 全台 13 站統一用同一組錨點時刻與暗夜閘門窗口 (見 REFERENCE_LAT/LNG
    # 註解)，不再逐站個別計算。
    anchor_utc = get_anchor_time_utc(session, date_str)
    anchor_local = anchor_utc.astimezone(taipei_tz)
    twilight_window = get_twilight_window(date_str, session, REFERENCE_LAT, REFERENCE_LNG)
    window_start_local = twilight_window[0].astimezone(taipei_tz)
    window_end_local = twilight_window[1].astimezone(taipei_tz)

    print(f"=== 🎞️  {date_str} {session_label} 縮時擷取 (全台 {len(stations)} 站 × 9 張) ===")
    print(f"    錨點 T = {anchor_local.strftime('%H:%M:%S')} (台北時間，全台統一) · "
          f"暗夜閘門窗口 = {window_start_local.strftime('%H:%M:%S')} ~ {window_end_local.strftime('%H:%M:%S')}")

    out_dir = os.path.join(REPO_ROOT, "data", "timelapse", f"{date_str}-{session}")
    os.makedirs(out_dir, exist_ok=True)

    report = {
        "date": date_str,
        "session": session,
        "anchorUtc": anchor_utc.isoformat(),
        "anchorLocalLabel": anchor_local.strftime("%H:%M:%S"),
        "generatedAt": datetime.datetime.now().isoformat(),
        "stations": []
    }

    for station in stations:
        frames = run_station(station, anchor_utc, twilight_window, now_utc, out_dir)
        report["stations"].append({
            "id": station["id"],
            "name": station["name"],
            "lat": station["lat"],
            "lng": station["lng"],
            "frames": frames,
            "canonical": compute_canonical_ground_truth(session, frames)
        })

    reports_dir = os.path.join(REPO_ROOT, "data", "timelapse")
    json_path = os.path.join(reports_dir, f"{date_str}-{session}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    html_path = os.path.join(reports_dir, f"{date_str}-{session}-report.html")
    build_html_report(report, html_path)

    total = sum(len(s["frames"]) for s in report["stations"])
    ok = sum(1 for s in report["stations"] for fr in s["frames"] if fr.get("ok"))
    print(f"=== ✅ 完成 {ok}/{total} 張。報告: {html_path} ===")
    return report


if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else "sunset"
    d_str = sys.argv[2] if len(sys.argv) > 2 else None
    run(sess, d_str)
