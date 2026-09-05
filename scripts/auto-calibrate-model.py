#!/usr/bin/env python3
"""
auto-calibrate-model.py - Phase 4: 物理演算法參數自適應進化與閉環微調器 (SkyFire GPS)
"""

import json
import os
import sys
import copy
import datetime

# 樣本數低於此門檻時，175 組候選權重的網格搜尋幾乎必然會在極少樣本上
# 找到「看似更好」的組合 —— 那是雜訊，不是真的校準。5 場以上才有基本的
# 統計意義。
MIN_SAMPLES_FOR_CALIBRATION = 5

# 改善幅度門檻：同時要求絕對分數與相對比例都達標，避免校準在雜訊範圍內
# (例如 42.87 → 42.82，只降 0.05 分帳面上「有改善」，但那完全在測量誤差
# 內，不該就此覆寫權重、寫入 history)。
MIN_IMPROVEMENT_ABS = 0.8
MIN_IMPROVEMENT_REL = 0.03  # 3%

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

def calculate_score(params, weights):
    high = params.get('highCloud', 0)
    mid = params.get('midCloud', 0)
    low = params.get('lowCloud', 0)
    total = params.get('totalCloud', min(100, high + mid * 0.5))
    vis = params.get('visibilityKm', 20.0)
    humidity = params.get('humidity', 65)
    precip = params.get('precipProb', 0)

    if high >= 25 and high <= 75:
        high_score = weights['highCloudMax'] - abs(high - weights['highCloudOpt']) * 0.3
    elif high > 75:
        high_score = max(8.0, weights['highCloudMax'] - (high - 75) * 0.6)
    else:
        high_score = high * (weights['highCloudMax'] / 35.0)

    if mid >= 20 and mid <= 65:
        mid_score = weights['midCloudMax'] - abs(mid - weights['midCloudOpt']) * 0.35
    elif mid > 65:
        mid_score = max(5.0, weights['midCloudMax'] - (mid - 65) * 0.5)
    else:
        mid_score = mid * (weights['midCloudMax'] / 33.0)

    synergy = weights['synergyBonus'] if (high >= 30 and mid >= 20 and low < 40) else 0.0
    cloud_base = min(45.0, high_score + mid_score + synergy)

    slope = weights['lowCloudSlope']
    if low <= 20:
        low_penalty = 0.0
    elif low <= 40:
        low_penalty = (low - 20) * 0.45 * slope
    elif low <= 65:
        low_penalty = 10.0 + (low - 40) * 0.95 * slope
    else:
        low_penalty = 35.0 + (low - 65) * 0.6 * slope

    horizon = params.get('horizonClearance', max(0, 100 - (low * 1.1 + max(0, total - 60) * 0.5)))
    horizon_score = (horizon / 100.0) * weights['horizonMax']

    if vis >= 25:
        vis_score = weights['visMax']
    elif vis >= 15:
        vis_score = (weights['visMax'] * 0.73) + (vis - 15) * 0.4
    elif vis >= 8:
        vis_score = (weights['visMax'] * 0.4) + (vis - 8) * 0.7
    else:
        vis_score = max(0.0, vis * 0.7)

    if precip > 50:
        moisture = -min(25.0, (precip - 50) * 0.6)
    elif precip > 25:
        moisture = -5.0
    else:
        moisture = weights['moistureMax'] if (50 <= humidity <= 82) else (weights['moistureMax'] * 0.5)

    raw = cloud_base - low_penalty + horizon_score + vis_score + moisture

    if high < 6 and mid < 6:
        raw = min(raw, 35.0)
    if low > 85:
        raw = min(raw, 15.0)

    return max(5, min(100, int(round(raw))))

def is_reliable_record(record):
    """該紀錄是否為可信賴的校準訓練樣本。

    校準迴圈學的是「天氣參數 → 分數」的物理關係，必須排除三種汙染源：
    1. 沒有真實直播影格證據 (capture.kind/validated 缺失或不合法) 的舊格式
       紀錄 —— 這些是移植 Tier A/B 管線前留下的，部分甚至來自舊版
       score-ground-truth.js 用隨機噪聲假造 ground truth 的臭蟲 (已修復，
       但歷史紀錄本身已經写入，無法回頭清乾淨)。
    2. 暗夜閘門已套用的紀錄：分數是「暮光窗外強制封頂 12 分」的人工判定，
       不是天氣參數驅動的真實光學觀測，拿去訓練「雲量 → 分數」的物理模型
       只會教壞它。
    3. 雨天閘門已套用的紀錄：同理，分數是下雨強制封頂 30 分，不是純雲量
       決定的結果。
    """
    capture = record.get('capture') or {}
    if capture.get('kind') not in ('youtube-live-frame', 'youtube-live-poster'):
        return False
    if capture.get('validated') is not True:
        return False
    snapshot_url = record.get('snapshotUrl') or ''
    if not snapshot_url.startswith('data/snapshots/'):
        return False

    verification = record.get('verification') or {}
    if verification.get('nightGate', {}).get('applied'):
        return False
    if verification.get('rainGate', {}).get('applied'):
        return False

    return True


def evaluate_mae(dataset, weights):
    errors = []
    for item in dataset:
        p = item['prediction']
        gt = item['verification']['groundTruthScore']
        if gt is None:
            continue
        sim_pred = calculate_score(p, weights)
        errors.append(abs(sim_pred - gt))

    if not errors:
        return 0.0
    return sum(errors) / len(errors)

def run_calibration(records_path, params_path):
    print("====================================================")
    print("🤖 啟動 SkyFire GPS Phase 4: 物理模型參數自適應進化閉環")
    print("====================================================\n")

    if os.path.exists(params_path):
        with open(params_path, 'r', encoding='utf-8') as f:
            params_data = json.load(f)
    else:
        params_data = {
            "version": "2.5.0",
            "weights": {
                "highCloudMax": 25.0, "highCloudOpt": 50.0,
                "midCloudMax": 20.0, "midCloudOpt": 42.0,
                "synergyBonus": 5.0, "lowCloudSlope": 0.85,
                "horizonMax": 30.0, "visMax": 15.0, "moistureMax": 8.0
            },
            "history": []
        }

    def finish(status, reason, total_records=0, reliable_records=0):
        """每次執行都留下審查紀錄，即使沒有更新權重 —— 否則從參數檔完全看不出
        校準器上次是「真的跑過但樣本不足跳過」還是「壓根沒在跑」。
        舊版只在真的更新權重時才寫檔，lastCalibratedAt 因此長期停滯在
        很久以前的日期，即使背後其實持續在執行 (跳過) 校準。"""
        params_data['lastReviewedAt'] = datetime.datetime.now().astimezone().isoformat()
        params_data['lastReviewOutcome'] = {
            "status": status,
            "reason": reason,
            "totalRecords": total_records,
            "reliableRecords": reliable_records
        }
        with open(params_path, 'w', encoding='utf-8') as f:
            json.dump(params_data, f, ensure_ascii=False, indent=2)
        print(f"📝 審查結果已記錄 ({status}): {reason}")
        print("====================================================\n")

    if not os.path.exists(records_path):
        print(f"⚠️ 找不到歷史觀測紀錄: {records_path}")
        finish("skipped_no_records", "verification-records.json 不存在")
        return

    with open(records_path, 'r', encoding='utf-8') as f:
        records = json.load(f)

    all_verified = [r for r in records if r.get('verification', {}).get('groundTruthScore') is not None]
    verified_records = [r for r in all_verified if is_reliable_record(r)]
    n_total = len(all_verified)
    n_samples = len(verified_records)

    print(f"📊 已驗證出景場次共 {n_total} 場，扣除缺乏真實影格證據／暗夜或雨天閘門"
          f"強制封頂的不可靠樣本後，可用於校準的樣本數: {n_samples} 場")

    if n_samples < MIN_SAMPLES_FOR_CALIBRATION:
        print(f"ℹ️ 可靠樣本數不足 {MIN_SAMPLES_FOR_CALIBRATION} 場，維持當前基礎權重，不進行校準。")
        finish(
            "skipped_insufficient_samples",
            f"可靠樣本 {n_samples} 場 < 門檻 {MIN_SAMPLES_FOR_CALIBRATION} 場",
            n_total, n_samples
        )
        return

    current_weights = params_data['weights']
    baseline_mae = evaluate_mae(verified_records, current_weights)
    print(f"🎯 校準前模型基準 MAE: {baseline_mae:.2f} 分")

    best_weights = copy.deepcopy(current_weights)
    best_mae = baseline_mae
    improved = False

    for slope_delta in [-0.15, -0.10, -0.05, 0.0, 0.05, 0.10, 0.15]:
        for high_max_delta in [-2.0, -1.0, 0.0, 1.0, 2.0]:
            for mid_max_delta in [-2.0, -1.0, 0.0, 1.0, 2.0]:
                cand = copy.deepcopy(current_weights)
                cand['lowCloudSlope'] = max(0.5, min(1.2, cand['lowCloudSlope'] + slope_delta))
                cand['highCloudMax'] = max(20.0, min(30.0, cand['highCloudMax'] + high_max_delta))
                cand['midCloudMax'] = max(15.0, min(25.0, cand['midCloudMax'] + mid_max_delta))

                cand_mae = evaluate_mae(verified_records, cand)
                if cand_mae < best_mae - 0.05:
                    best_mae = cand_mae
                    best_weights = cand
                    improved = True

    drop_abs = baseline_mae - best_mae
    drop_rel = (drop_abs / baseline_mae) if baseline_mae > 0 else 0.0
    print(f"✨ 網格搜尋最佳候選 MAE: {best_mae:.2f} 分 (降低 {drop_abs:.2f} 分, {drop_rel*100:.1f}%)")

    # 樣本數小時，網格搜尋幾乎必然能找到某組合「看似更好」—— 那是雜訊，
    # 不是真的校準。要求絕對與相對改善幅度都達標，才真正覆寫權重。
    meets_threshold = improved and drop_abs >= MIN_IMPROVEMENT_ABS and drop_rel >= MIN_IMPROVEMENT_REL

    if meets_threshold:
        improvement_pct = drop_rel * 100
        print(f"🚀 成功進化！預測精度提升: {improvement_pct:.1f}%")
        params_data['calibrationCount'] = params_data.get('calibrationCount', 0) + 1
        params_data['sampleSize'] = n_samples
        # 舊版這個欄位從未被更新過 (寫死在初始化時的值)，即使 history 已經
        # 累積多筆真實校準紀錄；lastReviewedAt 才是每次執行都會更新的欄位，
        # lastCalibratedAt 專指「上一次權重真的被改動」的時間點。
        params_data['lastCalibratedAt'] = datetime.datetime.now().astimezone().isoformat()
        params_data['metrics'] = {
            "initialMAE": round(baseline_mae, 2),
            "calibratedMAE": round(best_mae, 2),
            "improvementPct": round(improvement_pct, 1)
        }
        params_data['weights'] = best_weights
        params_data['history'].insert(0, {
            "date": verified_records[0]['date'],
            "maeBefore": round(baseline_mae, 2),
            "maeAfter": round(best_mae, 2),
            "sampleSize": n_samples,
            "adjustment": f"基於 {n_samples} 場可靠觀測紀錄微調高低雲光學權重，MAE 降低 {drop_abs:.2f} 分"
        })
        if len(params_data['history']) > 20:
            params_data['history'] = params_data['history'][:20]

        finish(
            "calibrated",
            f"MAE {baseline_mae:.2f} → {best_mae:.2f} 分 (-{improvement_pct:.1f}%)",
            n_total, n_samples
        )
    else:
        reason = (
            f"最佳候選僅降低 {drop_abs:.2f} 分 ({drop_rel*100:.1f}%)，"
            f"未達門檻 (絕對 ≥{MIN_IMPROVEMENT_ABS} 分 且 相對 ≥{MIN_IMPROVEMENT_REL*100:.0f}%)，判定為雜訊"
        ) if improved else "當前物理參數已處於區域最優解"
        print(f"✅ {reason}，不更新權重。")
        finish("no_significant_improvement", reason, n_total, n_samples)

if __name__ == "__main__":
    records_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../data/verification-records.json')
    params_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../data/model-calibration-params.json')
    run_calibration(records_file, params_file)
