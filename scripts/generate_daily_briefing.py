"""
每日實況驗證日報產生器 (Daily Ground-Truth Briefing)

資料驅動：讀取當次驗證循環的真實紀錄再彙整，絕不寫死結論。

來源檔：
  - data/verification-records.json      單站 (台北主站) 光學驗證紀錄
  - data/multi-station-records.json     13 站縮時多站點驗證紀錄
  - data/locked-<session>-multi-forecast.json / locked-<session>-forecast.json
                                        鎖定預報 (模型端分數)

輸出：data/daily-reports.json 最前面插入 / 覆蓋一筆 report-<date>-<session>

用法：
  python scripts/generate_daily_briefing.py [sunrise|sunset] [YYYY-MM-DD]

  第 2 參數為回填指定日期用；平時省略，腳本會鎖定「該時段最新一筆
  驗證紀錄」的日期 —— 這樣即使 GitHub 排程延遲數小時、跨過午夜，
  日報日期依然對齊天文事件當日，不會被執行當下的牆上時鐘帶跑。
"""

import os
import sys
import json
import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 已知測站的顯示 metadata（多站縮時紀錄本身不帶 icon/tag）
STATION_META = {
    "gaomei": ("🌊", "台中海線・風車海平面"),
    "dagushan": ("⛰️", "桃園大古山・盆地俯瞰"),
    "alishan-eryanping": ("🌄", "嘉義阿里山・二延平雲海"),
    "alishan-xiaoluji": ("🌄", "嘉義阿里山・小笠原山"),
    "alishan-shengli": ("🌄", "嘉義阿里山・勝利眺望"),
    "baihe-biyun": ("⛩️", "台南白河・碧雲寺"),
    "yongan": ("🐟", "高雄永安・漁港海口"),
    "erliao": ("🪨", "台南左鎮・二寮日出"),
    "gaowangliao": ("🛤️", "台南龍崎・高望寮"),
    "huayuan": ("🌉", "花蓮・花園夜景"),
    "qixingtan": ("🌊", "花蓮・七星潭海灣"),
    "xiangshan": ("🏙️", "台北信義・象山看 101"),
    "dadaocheng": ("⛵", "台北大稻埕・淡水河畔"),
}


def load(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ 讀取 {name} 失敗: {exc}")
        return None


def classify(mae):
    """依平均絕對誤差 (分) 判定，門檻與 score-ground-truth.js 對齊。"""
    if mae is None:
        return ("UNVERIFIED", "❔ 驗證從缺（影格擷取失敗）", "#94A3B8")
    if mae <= 8:
        return ("EXACT_MATCH", "🎯 極致精準 (誤差 ≤ 8分)", "#4ADE80")
    if mae <= 18:
        return ("SLIGHT_DEVIATION", "⚡ 輕微偏差 (誤差 ≤ 18分)", "#FBBF24")
    return ("MISMATCH", "⚠️ 出現偏差需校準", "#F43F5E")


def station_key(record):
    """rec-2026-09-07-sunset-alishan-eryanping -> alishan-eryanping"""
    rid = record.get("id", "")
    parts = rid.split("-")
    # rec / YYYY / MM / DD / session / <station...>
    return "-".join(parts[5:]) if len(parts) > 5 else "taipei-main"


def collect_records(date_str, session):
    out = []
    for rec in load("multi-station-records.json") or []:
        if rec.get("date") == date_str and rec.get("session") == session:
            out.append(rec)
    for rec in load("verification-records.json") or []:
        if rec.get("id") == f"rec-{date_str}-{session}":
            out.append(rec)
    return out


def resolve_report_date(session, override=None):
    """
    鎖定「本時段最近一次真正完成驗證的日期」。

    只認至少有一站 groundTruthScore 非 null 的日期 —— 排除排程延遲跨夜
    時提前寫入、狀態為 capture_unavailable / captured_ready_for_scoring
    的空殼紀錄（那些會把日期往未來帶跑）。全時段擷取失敗時退回鎖定
    預報的日期（lock_forecast 於天文事件當日設定），仍對齊事件日。
    """
    if override:
        return override
    verified_dates = [
        rec["date"]
        for rec in (load("verification-records.json") or [])
        + (load("multi-station-records.json") or [])
        if rec.get("session") == session
        and rec.get("date")
        and (rec.get("verification") or {}).get("groundTruthScore") is not None
    ]
    if verified_dates:
        return max(verified_dates)
    locked = load(f"locked-{session}-multi-forecast.json") or load(
        f"locked-{session}-forecast.json"
    )
    if locked and locked.get("date"):
        return locked["date"]
    # 最後退路：牆上時鐘。日落報告若在午夜後才跑，回推一天。
    now = datetime.datetime.now()
    day = now.date()
    if session == "sunset" and now.hour < 12:
        day -= datetime.timedelta(days=1)
    return day.isoformat()


def forecast_summary(session):
    """回傳 (代表分數, 代表評級, 顏色)。"""
    multi = load(f"locked-{session}-multi-forecast.json")
    if multi and multi.get("stations"):
        scores, ratings, colors = [], [], []
        for st in multi["stations"]:
            sky = st.get("skyfire") or {}
            if sky.get("score") is not None:
                scores.append(sky["score"])
                rating = sky.get("rating") or {}
                ratings.append(rating.get("badge", ""))
                colors.append(rating.get("color", "#ff9e00"))
        if scores:
            rep = round(sum(scores) / len(scores))
            # 取最接近代表分數那站的評級/顏色
            idx = min(range(len(scores)), key=lambda i: abs(scores[i] - rep))
            return rep, ratings[idx], colors[idx]
    single = load(f"locked-{session}-forecast.json") or {}
    sky = single.get("skyfire") or {}
    rating = sky.get("rating") or {}
    return sky.get("score"), rating.get("badge", ""), rating.get("color", "#ff9e00")


def build_report(session, override_date=None):
    date_str = resolve_report_date(session, override_date)
    is_sunrise = session == "sunrise"
    records = collect_records(date_str, session)

    # 只有「可信」紀錄能餵進統計/判定：merge / calibration 標了
    # verification.reliable === false 的一律排除 (預測來自離線模擬、舊格式、
    # 或影格證據不足)。這也讓歷史回填安全 —— 例如 2026-09-06 日落全部
    # 6 站的預測是 Open-Meteo 當時掛掉時的模擬值 (score 93)，拿去比對毫無意義。
    def _reliable(rec):
        ver = rec.get("verification") or {}
        return (
            ver.get("reliable") is not False
            and ver.get("groundTruthScore") is not None
            and not (rec.get("prediction") or {}).get("isSimulated")
        )

    reliable_recs = [r for r in records if _reliable(r)]

    # 代表預報 = 可信紀錄各自鎖定的預測分數平均；評級/顏色取最接近平均那站
    # 自己帶的值 (不從 locked-<session> 檔讀 —— 那永遠是「今天」的預報，回填
    # 舊日期會抓錯天)。完全沒有可信紀錄時才退回 locked 檔。
    rel_preds = [(r.get("prediction") or {}).get("score") for r in reliable_recs
                 if (r.get("prediction") or {}).get("score") is not None]
    if rel_preds:
        pred_score = round(sum(rel_preds) / len(rel_preds))
        near = min(reliable_recs,
                   key=lambda r: abs((r.get("prediction") or {}).get("score", 0) - pred_score))
        np_ = near.get("prediction") or {}
        pred_rating = np_.get("rating", "")
        pred_color = np_.get("color", "#ff9e00")
        pred_summary = f"{len(rel_preds)} 站鎖定預報平均"
    else:
        pred_score, pred_rating, pred_color = forecast_summary(session)
        pred_summary = f"locked-{session} 鎖定分數（無可信站點紀錄）"

    stations, errors, ground_truths = [], [], []
    verified_count = 0
    for rec in records:
        pred = rec.get("prediction") or {}
        ver = rec.get("verification") or {}
        gt = ver.get("groundTruthScore")
        mae = ver.get("errorAbsolute")
        badge = ver.get("groundTruthBadge", "")
        rel = _reliable(rec)
        _, vbadge, _ = classify(mae if rel else None)
        verdict_badge = ver.get("verdictBadge") or vbadge
        if gt is not None and not rel:
            verdict_badge = "◽ 不列入統計（模擬預測 / 證據不足）"

        if rel:
            if mae is not None:
                errors.append(mae)
            ground_truths.append(gt)
            verified_count += 1

        icon, tag = STATION_META.get(station_key(rec), ("📹", rec.get("source", "")))
        name = (rec.get("source") or rec.get("id", "")).split("（")[0].strip()
        fire = "🔥 " if (rel and gt is not None and gt >= 75) else ""
        status = ver.get("status", "")
        if gt is not None:
            peak = f"{fire}實測光學 {gt} 分（{badge}）"
        elif status in ("captured_ready_for_scoring", "pending_scoring"):
            peak = "影格已擷取，等待 Phase 2 光學評分"
        else:
            peak = "影格擷取失敗（排程延遲超出擷取窗），本站無地面實況"
        stations.append(
            {
                "name": name,
                "icon": icon,
                "tag": tag,
                "phasePrep": f"模型預報 {pred.get('score', '--')} 分（{pred.get('rating', '')}）"
                f"｜高雲 {pred.get('highCloud', '--')}% 低雲 {pred.get('lowCloud', '--')}%",
                "phasePeak": peak,
                "phasePost": (f"誤差 {mae} 分" if (rel and mae is not None) else "—"),
                "forecast": f"{pred.get('score', '--')} 分",
                "verdict": verdict_badge,
                "reliable": rel,
            }
        )

    mean_mae = round(sum(errors) / len(errors)) if errors else None
    level, verdict_badge, verdict_color = classify(mean_mae)
    # 可信實測站點 < 2 → 不對模型表現下定論 (樣本太少 / 全是模擬預測)
    sufficient = verified_count >= 2

    if not sufficient:
        level = "UNVERIFIED"
        verdict_badge = "❔ 有效樣本不足，不評模型"
        verdict_color = "#94A3B8"
        captured_any = any(s["phasePeak"].startswith(("實測", "🔥")) or "等待" in s["phasePeak"]
                           for s in stations)
        atmospheric = (
            f"本時段僅 {verified_count} 站取得可信光學實況"
            + ("（其餘為模擬預測或影格擷取失敗）。" if captured_any
               else "（測站影格擷取失敗，排程延遲超出擷取窗）。")
        )
        model_perf = "有效樣本不足，本報告不對模型表現下定論。"
    else:
        peak_gt = max(ground_truths)
        mean_gt = round(sum(ground_truths) / len(ground_truths))
        atmospheric = (
            f"{verified_count}/{len(stations)} 站取得可信光學實況；"
            f"實測平均 {mean_gt} 分、峰值 {peak_gt} 分，模型代表預報 {pred_score} 分。"
        )
        model_perf = {
            "EXACT_MATCH": f"模型與實測高度一致（平均誤差 {mean_mae} 分）。",
            "SLIGHT_DEVIATION": f"模型方向正確，分數帶輕微偏差（平均誤差 {mean_mae} 分）。",
            "MISMATCH": (
                f"模型顯著失準（平均誤差 {mean_mae} 分，峰值實測 {peak_gt} 分），"
                "已標記進入校準樣本。"
            ),
            "UNVERIFIED": "有效樣本不足，本報告不對模型表現下定論。",
        }[level]

    now = datetime.datetime.now()
    return {
        "id": f"report-{date_str}-{session}",
        "date": date_str,
        "session": session,
        "sessionLabel": "清晨日出" if is_sunrise else "傍晚日落",
        "publishedAt": now.isoformat(),
        "publishTimeLabel": "09:00 定時發布" if is_sunrise else "21:00 定時發布",
        "title": f"{date_str} {'清晨日出' if is_sunrise else '傍晚日落'}實況觀測 vs. 模型預報總結",
        "verificationStatus": (
            "verified" if sufficient
            else "insufficient" if verified_count or any(s["reliable"] for s in stations)
            else "unavailable"
        ),
        "prediction": {
            "score": pred_score,
            "rating": pred_rating,
            "color": pred_color,
            "summary": pred_summary,
        },
        "groundTruth": {
            "score": round(sum(ground_truths) / len(ground_truths)) if ground_truths else None,
            "peakScore": max(ground_truths) if ground_truths else None,
            "meanErrorAbsolute": mean_mae,
            "verdict": level,
            "verdictBadge": verdict_badge,
            "color": verdict_color,
            "stationsVerified": verified_count,
            "stationsTotal": len(stations),
        },
        "stations": stations,
        "summaryAnalysis": {
            "atmosphericReason": atmospheric,
            "modelPerformance": model_perf,
        },
    }


def generate_briefing(session_override=None, date_override=None):
    session = session_override or (
        "sunrise" if datetime.datetime.now().hour < 15 else "sunset"
    )
    if session not in ("sunrise", "sunset"):
        raise SystemExit(f"未知時段: {session}")

    report = build_report(session, date_override)
    session_label = report["sessionLabel"]
    print(
        f"=== 📰 產生每日實況日報: {report['date']} {session_label} "
        f"({report['publishTimeLabel']}) ==="
    )

    reports_path = os.path.join(DATA, "daily-reports.json")
    reports = load("daily-reports.json") or []

    idx = next(
        (i for i, r in enumerate(reports) if r.get("id") == report["id"]), None
    )
    if idx is not None:
        reports[idx] = report
    else:
        reports.append(report)

    # 新到舊：先比日期，同日 sunset（傍晚較晚發生）排在 sunrise 之前
    reports.sort(
        key=lambda r: (r.get("date", ""), 1 if r.get("session") == "sunset" else 0),
        reverse=True,
    )

    with open(reports_path, "w", encoding="utf-8") as f:
        json.dump(reports, f, ensure_ascii=False, indent=2)

    gt = report["groundTruth"]
    print(
        f"✅ {report['id']} · {gt['verdictBadge']} · "
        f"{gt['stationsVerified']}/{gt['stationsTotal']} 站驗證 · "
        f"總歸檔 {len(reports)} 篇"
    )


if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else None
    date_arg = sys.argv[2] if len(sys.argv) > 2 else None
    generate_briefing(sess, date_arg)
