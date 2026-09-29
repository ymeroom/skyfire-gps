"""
test_timelapse_static_feed.py
直播換成「CAM UNDER MAINTENANCE」維修公告圖時，縮時 9 幀每張都幾乎一樣，
光學評分器照樣給分 (2026-09-28 大古山 59 分、2026-09-20 生力農場 97 分)。
compute_canonical_ground_truth 必須把這種靜止畫面判成擷取失敗，而不是實測。
另外成功影格只有 1-3 張時窗口取樣太稀，一律作廢 (使用者 2026-09-29 決定)。

用法: python tests/test_timelapse_static_feed.py
fixtures 是實際影格縮到 160x90：maint-* 為 9/28 大古山公告圖 (T-10 / T+20)，
sky-* 為同一場高美濕地 T-10 / T+10 / T+20 / T+30。
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
from capture_timelapse_multi_station import compute_canonical_ground_truth  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "static-feed")


def frame(offset, name, score):
    return {
        "offsetMin": offset,
        "ok": True,
        "score": score,
        "imagePath": os.path.join(FIX, name),
        "nightGate": {"applied": False},
    }


class StaticFeedTest(unittest.TestCase):
    def test_maintenance_slide_across_window_is_unavailable(self):
        frames = [
            frame(-10, "maint-a.jpg", 59),
            frame(0, "maint-b.jpg", 59),
            frame(10, "maint-a.jpg", 59),
            frame(20, "maint-b.jpg", 59),
        ]
        c = compute_canonical_ground_truth("sunset", frames)
        self.assertFalse(c["available"])
        self.assertIn("靜止", c["reason"])

    def test_changing_sky_stays_available(self):
        frames = [
            frame(-10, "sky-t-10.jpg", 60),
            frame(10, "sky-t+10.jpg", 97),
            frame(20, "sky-t+20.jpg", 88),
            frame(30, "sky-t+30.jpg", 70),
        ]
        c = compute_canonical_ground_truth("sunset", frames)
        self.assertTrue(c["available"])
        self.assertEqual(c["score"], 97)

    def test_three_or_fewer_frames_are_voided(self):
        for n in (1, 2, 3):
            frames = [frame(-10 + 10 * i, f, 60 + i) for i, f in
                      enumerate(["sky-t-10.jpg", "sky-t+10.jpg", "sky-t+30.jpg"][:n])]
            c = compute_canonical_ground_truth("sunset", frames)
            self.assertFalse(c["available"], f"{n} frames")
            self.assertIn(f"僅 {n}/9", c["reason"])
            self.assertEqual(c["framesOk"], n)

    def test_four_frames_still_produce_a_score(self):
        frames = [frame(-10 + 10 * i, f, 60 + i) for i, f in
                  enumerate(["sky-t-10.jpg", "sky-t+10.jpg", "sky-t+20.jpg", "sky-t+30.jpg"])]
        frames += [{"offsetMin": o, "ok": False, "error": "404"} for o in (30, 40, -40, -30, -20)]
        c = compute_canonical_ground_truth("sunset", frames)
        self.assertTrue(c["available"])


if __name__ == "__main__":
    unittest.main()
