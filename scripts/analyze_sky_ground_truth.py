#!/usr/bin/env python3
"""
analyze_sky_ground_truth.py - Phase 2: 天空光學色彩直方圖分析與真實出景強度量化器
利用 CIELAB / HSV 色彩空間對實況截圖進行天空分割、色相積分與漫射覆蓋率量化

移植自 taipei-skyfire 的暗夜閘門 + 雨天閘門版本。與 taipei-skyfire 的差異：
本專案涵蓋全台任意經緯度機位 (非固定台北)，因此暮光窗口計算需要顯式帶入
lat/lng，不能沿用 taipei-skyfire 那種「只服務台北」的預設值。
"""

import sys
import os
import json
import subprocess
import datetime
import urllib.request

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
TAIPEI_TZ = datetime.timezone(datetime.timedelta(hours=8))

# 正式驗證管線 (auto_validate_capture.yml) 目前固定用這兩台實體攝影機
# (象山看101 / 大稻埕)，座標取自 js/spots-taiwan.js 對應機位。
# 未指定座標時 (例如手動 CLI 呼叫) 回退到這裡。
DEFAULT_STATION_COORDS_BY_SESSION = {
    "sunrise": {"lat": 25.0270, "lng": 121.5702},  # 象山看台北101
    "sunset": {"lat": 25.0569, "lng": 121.5074},   # 大稻埕
}

try:
    from PIL import Image
    import numpy as np
except ImportError:
    Image = None
    np = None


def get_twilight_window(date_str, session, lat, lng):
    """透過 js/solar-calc.js (單一事實來源) 取得指定經緯度的暮光窗口邊界。

    火燒雲物理上只可能出現在「日出前民用曙光起 ~ 日出後黃金時刻結束」或
    「日落前黃金時刻起 ~ 日落後民用暮光結束」這段窗口內；窗口外看到的暖色調
    高飽和度像素只可能是路燈、船燈、燈籠等人工光源，不是真的燒天。

    本專案機位遍布全台，暮光時刻因地而異，lat/lng 為必要參數，不像
    taipei-skyfire 可以只服務台北一個座標。
    回傳 (window_start_utc, window_end_utc)，皆為 tz-aware datetime。
    """
    node_script = (
        "const SolarCalc = require('./js/solar-calc.js');"
        "const t = SolarCalc.getTimes(new Date(process.argv[1] + 'T12:00:00+08:00'), "
        "parseFloat(process.argv[2]), parseFloat(process.argv[3]));"
        "console.log(JSON.stringify({"
        "civilDawn: t.civilDawn, sunriseGoldenEnd: t.sunriseGoldenEnd,"
        "sunsetGoldenStart: t.sunsetGoldenStart, civilDusk: t.civilDusk"
        "}));"
    )
    r = subprocess.run(
        ["node", "-e", node_script, date_str, str(lat), str(lng)],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=30
    )
    if r.returncode != 0:
        raise RuntimeError(f"SolarCalc 呼叫失敗: {r.stderr.strip()}")
    times = json.loads(r.stdout)

    def parse(iso):
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))

    if session == "sunrise":
        return parse(times["civilDawn"]), parse(times["sunriseGoldenEnd"])
    return parse(times["sunsetGoldenStart"]), parse(times["civilDusk"])


def apply_night_gate(result, capture_time=None, twilight_window=None):
    """暗夜閘門：暮光窗口外一律強制低分，避免人工光源被誤判為火燒雲。"""
    result["nightGate"] = {"applied": False, "reason": "no capture_time provided"}
    if capture_time is None:
        return result

    try:
        if twilight_window is None:
            result["nightGate"] = {"applied": False, "reason": "no twilight_window provided (need lat/lng)"}
            return result

        window_start, window_end = twilight_window
        if window_start <= capture_time <= window_end:
            result["nightGate"] = {
                "applied": False,
                "reason": "within twilight window",
                "windowStart": window_start.isoformat(),
                "windowEnd": window_end.isoformat()
            }
            return result

        raw_score = result.get("score", 0)
        gated_score = min(raw_score, 12)
        result["nightGate"] = {
            "applied": True,
            "reason": "capture time falls outside the twilight window — "
                      "warm/saturated pixels here are almost certainly artificial "
                      "light (street lamps, boat lights, lanterns), not afterglow",
            "rawScoreBeforeGate": raw_score,
            "rawLevelBeforeGate": result.get("level"),
            "windowStart": window_start.isoformat(),
            "windowEnd": window_end.isoformat()
        }
        result["score"] = gated_score
        result["level"] = "OVERCAST"
        result["badge"] = "暮光窗外 (人工光源判定)"
    except Exception as e:
        result["nightGate"] = {"applied": False, "reason": f"gate check failed, fail-open: {e}"}
        print(f"⚠️ 暗夜閘門檢查失敗，本次不套用: {e}", file=sys.stderr)

    return result


# WMO weathercode：雨/毛毛雨/陣雨/雷雨 (51-67, 80-82, 95-99)
_RAIN_WEATHER_CODES = frozenset([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99])


def fetch_hourly_weather_series(lat, lng):
    """一次抓某站點過去 2 天~未來 1 天的逐小時降雨資料 (Open-Meteo)。

    同一場次多張影格可共用同一次查詢結果 (呼叫端傳入 rain_series 即可)，
    避免對同一站點重複打 API。查詢失敗回傳 None (呼叫端 fail-open，不套用雨天閘門)。
    """
    try:
        url = (
            f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}"
            "&hourly=precipitation,weathercode&past_days=2&forecast_days=1&timezone=UTC"
        )
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        hourly = data.get("hourly") or {}
        times = hourly.get("time") or []
        if not times:
            return None
        return {
            "times": times,
            "precip": hourly.get("precipitation") or [],
            "codes": hourly.get("weathercode") or []
        }
    except Exception as e:
        print(f"⚠️ 降雨資料查詢失敗，雨天閘門本次不套用: {e}", file=sys.stderr)
        return None


def lookup_rain_at(series, capture_time):
    """從 fetch_hourly_weather_series 的結果中，找出離 capture_time 最近的整點降雨狀態。"""
    if series is None or capture_time is None:
        return None
    times = series.get("times") or []
    if not times:
        return None

    target_ts = capture_time.timestamp()
    best_i, best_diff = 0, float("inf")
    for i, t in enumerate(times):
        try:
            t_dt = datetime.datetime.fromisoformat(t).replace(tzinfo=datetime.timezone.utc)
        except Exception:
            continue
        diff = abs(t_dt.timestamp() - target_ts)
        if diff < best_diff:
            best_diff, best_i = diff, i

    precip_list = series.get("precip") or []
    code_list = series.get("codes") or []
    precip = precip_list[best_i] if best_i < len(precip_list) else 0
    code = code_list[best_i] if best_i < len(code_list) else 0
    is_raining = bool((precip or 0) >= 0.1) or code in _RAIN_WEATHER_CODES
    return {"isRaining": is_raining, "precipitationMm": precip, "weatherCode": code}


def apply_rain_gate(result, rain_info):
    """雨天閘門：下雨時暖色像素多半是濕路面/車燈反光，而非真正火燒雲，分數封頂 30 分。

    與暗夜閘門疊加時取更嚴格者 (min)：暗夜閘門已封頂 12 分的話，雨天閘門
    (30 分封頂) 不會再放寬回去。
    """
    if rain_info is None:
        result["rainGate"] = {"applied": False, "reason": "no rain data available"}
        return result

    if not rain_info.get("isRaining"):
        result["rainGate"] = {"applied": False, "reason": "not raining", **rain_info}
        return result

    raw_score = result.get("score", 0)
    gated_score = min(raw_score, 30)
    if gated_score >= raw_score:
        result["rainGate"] = {"applied": False, "reason": "already at or below rain cap", **rain_info}
        return result

    result["rainGate"] = {
        "applied": True,
        "reason": "raining at capture time — wet pavement / vehicle-light reflections and "
                  "low ambient contrast are more likely to read as false warm-color signal "
                  "than genuine afterglow",
        "rawScoreBeforeGate": raw_score,
        "rawLevelBeforeGate": result.get("level"),
        **rain_info
    }
    result["score"] = gated_score
    level, badge = classify_score(gated_score)
    result["level"] = level
    result["badge"] = f"{badge} (雨天反光判定)"
    return result


def classify_score(score):
    """依既有 5 級門檻分類分數，供主流程與各閘門共用，避免各處各自硬編門檻值。"""
    if score >= 82:
        return "EPIC", "史詩級爆發"
    elif score >= 68:
        return "GREAT", "壯麗火燒雲"
    elif score >= 48:
        return "MODERATE", "局部微霞"
    elif score >= 30:
        return "FAINT", "平淡暮光"
    else:
        return "OVERCAST", "陰沉沉寂"


def analyze_image_optics(image_path, capture_time=None, twilight_window=None, rain_series=None, station_coords=None):
    """分析天空區域的火燒雲光學特徵"""
    if not os.path.exists(image_path) or Image is None:
        return {
            "score": 0,
            "level": "OVERCAST",
            "chromatic_purity": 0,
            "sky_coverage_pct": 0,
            "is_simulated": True
        }

    try:
        img = Image.open(image_path).convert('RGB')
        w, h = img.size
        target_w = 640
        target_h = int(h * (target_w / w))
        img = img.resize((target_w, target_h), Image.BILINEAR)

        # 擷取天空 ROI (畫面頂部 65%)
        sky_height = int(target_h * 0.65)
        sky_crop = img.crop((0, 0, target_w, sky_height))

        pixels = np.array(sky_crop, dtype=np.float32) / 255.0
        total_sky_pixels = sky_crop.width * sky_crop.height

        r = pixels[:, :, 0]
        g = pixels[:, :, 1]
        b = pixels[:, :, 2]

        max_c = np.maximum(np.maximum(r, g), b)
        min_c = np.minimum(np.minimum(r, g), b)
        diff = max_c - min_c + 1e-7

        v = max_c
        s = np.where(max_c == 0, 0, diff / max_c)

        h_arr = np.zeros_like(r)
        r_mask = (max_c == r)
        g_mask = (max_c == g) & (~r_mask)
        b_mask = (~r_mask) & (~g_mask)

        h_arr[r_mask] = (60 * ((g[r_mask] - b[r_mask]) / diff[r_mask]) + 360) % 360
        h_arr[g_mask] = (60 * ((b[g_mask] - r[g_mask]) / diff[g_mask]) + 120) % 360
        h_arr[b_mask] = (60 * ((r[b_mask] - g[b_mask]) / diff[b_mask]) + 240) % 360

        warm_mask = ((h_arr <= 65) | (h_arr >= 345)) & (s >= 0.22) & (v >= 0.20)
        vivid_mask = ((h_arr <= 45) | (h_arr >= 350)) & (s >= 0.42) & (v >= 0.30)

        warm_pixels_count = np.sum(warm_mask)
        vivid_pixels_count = np.sum(vivid_mask)

        warm_coverage_pct = (warm_pixels_count / total_sky_pixels) * 100
        vivid_coverage_pct = (vivid_pixels_count / total_sky_pixels) * 100

        avg_warm_saturation = float(np.mean(s[warm_mask])) if warm_pixels_count > 0 else 0
        avg_warm_brightness = float(np.mean(v[warm_mask])) if warm_pixels_count > 0 else 0

        coverage_score = min(45, (warm_coverage_pct / 50.0) * 45)
        saturation_score = min(35, (avg_warm_saturation / 0.75) * 35)
        vivid_bonus = min(20, (vivid_coverage_pct / 20.0) * 20)

        raw_score = coverage_score + saturation_score + vivid_bonus
        final_score = int(np.clip(np.round(raw_score), 5, 100))
        level, badge = classify_score(final_score)

        result = {
            "score": final_score,
            "level": level,
            "badge": badge,
            "chromatic_purity": round(avg_warm_saturation * 100, 1),
            "sky_coverage_pct": round(warm_coverage_pct, 1),
            "vivid_coverage_pct": round(vivid_coverage_pct, 1),
            "avg_brightness_pct": round(avg_warm_brightness * 100, 1),
            "is_simulated": False
        }
        result = apply_night_gate(result, capture_time, twilight_window)

        if capture_time is not None:
            coords = station_coords
            if coords is None:
                local = capture_time.astimezone(TAIPEI_TZ)
                session = "sunrise" if local.hour < 12 else "sunset"
                coords = DEFAULT_STATION_COORDS_BY_SESSION.get(session)
            series = rain_series
            if series is None and coords is not None:
                series = fetch_hourly_weather_series(coords["lat"], coords["lng"])
            rain_info = lookup_rain_at(series, capture_time)
            result = apply_rain_gate(result, rain_info)
        else:
            result["rainGate"] = {"applied": False, "reason": "no capture_time provided"}

        return result

    except Exception as e:
        print(f"光學分析失敗: {e}", file=sys.stderr)
        return {
            "score": 10,
            "level": "OVERCAST",
            "badge": "分析異常",
            "error": str(e),
            "is_simulated": True
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze_sky_ground_truth.py <snapshot_path> [captured_at_iso_utc] [lat] [lng]")
        sys.exit(1)

    img_path = sys.argv[1]
    cap_time = None
    if len(sys.argv) > 2:
        try:
            cap_time = datetime.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
        except Exception as e:
            print(f"⚠️ 無法解析 captured_at 參數 '{sys.argv[2]}'，暗夜/雨天閘門將不套用: {e}", file=sys.stderr)

    coords = None
    if len(sys.argv) > 4:
        try:
            coords = {"lat": float(sys.argv[3]), "lng": float(sys.argv[4])}
        except Exception as e:
            print(f"⚠️ 無法解析座標參數 '{sys.argv[3]},{sys.argv[4]}': {e}", file=sys.stderr)

    twilight_window = None
    if cap_time is not None:
        try:
            local = cap_time.astimezone(TAIPEI_TZ)
            session = "sunrise" if local.hour < 12 else "sunset"
            date_str = local.strftime("%Y-%m-%d")
            use_coords = coords or DEFAULT_STATION_COORDS_BY_SESSION.get(session)
            twilight_window = get_twilight_window(date_str, session, use_coords["lat"], use_coords["lng"])
        except Exception as e:
            print(f"⚠️ 暮光窗口計算失敗，暗夜閘門將不套用: {e}", file=sys.stderr)

    result = analyze_image_optics(img_path, capture_time=cap_time, twilight_window=twilight_window, station_coords=coords)
    print(json.dumps(result, ensure_ascii=False, indent=2))
