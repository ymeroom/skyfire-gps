#!/usr/bin/env python3
"""
analyze_sky_ground_truth.py - Phase 2: 天空光學色彩直方圖分析與真實出景強度量化器
"""

import sys
import os
import json

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

try:
    from PIL import Image
    import numpy as np
except ImportError:
    Image = None
    np = None

def analyze_image_optics(image_path):
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

        if final_score >= 82:
            level = "EPIC"
            badge = "史詩級爆發"
        elif final_score >= 68:
            level = "GREAT"
            badge = "壯麗火燒雲"
        elif final_score >= 48:
            level = "MODERATE"
            badge = "局部微霞"
        elif final_score >= 30:
            level = "FAINT"
            badge = "平淡暮光"
        else:
            level = "OVERCAST"
            badge = "陰沉沉寂"

        return {
            "score": final_score,
            "level": level,
            "badge": badge,
            "chromatic_purity": round(avg_warm_saturation * 100, 1),
            "sky_coverage_pct": round(warm_coverage_pct, 1),
            "vivid_coverage_pct": round(vivid_coverage_pct, 1),
            "is_simulated": False
        }

    except Exception as e:
        return {
            "score": 10,
            "level": "OVERCAST",
            "badge": "分析異常",
            "error": str(e),
            "is_simulated": True
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    print(json.dumps(analyze_image_optics(sys.argv[1]), ensure_ascii=False, indent=2))
