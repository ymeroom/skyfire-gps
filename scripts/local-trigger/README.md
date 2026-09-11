# 本機觸發 (取代 GitHub Actions schedule)

2026-09-11 起，4 個原本靠 GitHub Actions `schedule:` 觸發的 workflow
(`lock_forecast.yml`、`auto_timelapse_multi_station.yml`、
`auto_validate_capture.yml`、`weekly_auto_calibration.yml`) 全部改由
這台電腦的 Windows 工作排程器直接觸發。

**為什麼**：GitHub 排程事件本身常延遲 1-4 小時 (相關性延遲，換自架
runner 也解決不了)，YouTube 直播 DVR 只回溯 ~4 小時，等排程真的觸發時
擷取窗早就流失。本機用電腦自己的時鐘觸發不受 GitHub 佇列影響；副作用是
住宅 IP 還能過 YouTube bot-check，Tier A 精確擷取不必再靠設定
`CAPTURE_RUNNER`。

GitHub Actions 那邊只留 `workflow_dispatch`，可以照舊在 Actions 頁面手動
觸發（測試、補跑），只是不會再自動排程執行。

## 一次性設定

```powershell
# 在這個開發目錄或任何地方都可以跑 (腳本會另外 clone 一份機器人專用的副本)
powershell -ExecutionPolicy Bypass -File "scripts\local-trigger\setup-tasks.ps1"
```

會做兩件事：

1. **Clone 一份獨立副本**到 `%USERPROFILE%\skyfire-gps-bot`（預設路徑，可用
   `-BotRepo` 參數改）。**不會**用你目前這個開發目錄——因為
   `run-job.sh` 每次執行都會 `git reset --hard origin/main` 讓起跑狀態
   乾淨（跟 GitHub Actions 每次全新 checkout 語意一致），在開發目錄跑
   會把你手上未 commit 的工作噴掉。
2. **註冊 7 個工作排程任務**（`taskschd.msc` 裡搜尋 `SkyFireGPS-`），
   都設定：
   - **Wake to run**：電腦睡眠中會被喚醒執行（喚不醒「完全關機」，那
     需要主機板 BIOS 排程開機，超出此腳本範圍）。
   - **Start when available**：真的錯過的排程（當時關機）下次開機/
     登入後會盡快補跑一次。
   - **只在你登入時執行**：確保能讀到 Windows 既有的 git 憑證快取，
     push 不會因為背景 session 拿不到憑證而失敗。

## 任務對照表

| 任務名稱 | 觸發時間 (台北) | 對應原 GitHub workflow |
|---|---|---|
| SkyFireGPS-Lock-Sunset | 15:30 | lock_forecast.yml (sunset) |
| SkyFireGPS-Lock-Sunrise | 23:45 | lock_forecast.yml (sunrise) |
| SkyFireGPS-Timelapse-Sunrise | 03:05 | auto_timelapse_multi_station.yml (sunrise) |
| SkyFireGPS-Timelapse-Sunset | 15:40 | auto_timelapse_multi_station.yml (sunset) |
| SkyFireGPS-Validate-Sunrise | 05:30, 09:00 | auto_validate_capture.yml (sunrise ×2) |
| SkyFireGPS-Validate-Sunset | 18:45, 21:00 | auto_validate_capture.yml (sunset ×2) |
| SkyFireGPS-WeeklyCalibration | 週一 00:00 | weekly_auto_calibration.yml |

縮時任務只留一個提早的觸發時間（不像原本 GitHub 排程要疊 2-3 個 cron
防延遲）——本機沒有 GitHub 那種佇列延遲，`capture_timelapse_multi_station.py`
內建的「睡到 T+45 分再擷取」邏輯繼續保留當防呆邊界，配合 Task Scheduler
的 wake + 補跑機制已經夠用。

## 檢查有沒有跑

Log 在機器人 clone 底下的 `logs/local-trigger/<job>-<時間戳記>.log`
(不進版控)。想看任務本身的最近執行結果/下次執行時間：

```powershell
Get-ScheduledTaskInfo -TaskName "SkyFireGPS-Timelapse-Sunset"
```

手動立刻跑一次來測試：

```powershell
Start-ScheduledTask -TaskName "SkyFireGPS-Lock-Sunset"
```

## 已知限制

- **完全關機**（不是睡眠）時排程不會觸發，開機/登入後靠 Start when
  available 補跑一次，但補跑時機點可能已經超出 DVR 回溯窗口。
- **電池限制**（2026-09-12 踩過一次）：`New-ScheduledTaskSettingsSet`
  預設會擋掉「用電池供電時啟動」，若這台機器被 Windows 偵測到
  `Win32_Battery`（例如接了會回報成電池的 UPS），UPS 自我測試瞬間切電池
  供電就可能讓任務整個不啟動、且不會補跑，也不會留下明顯的錯誤紀錄
  （`Get-ScheduledTaskInfo` 的 `LastTaskResult` 會是 `267011`
  `SCHED_S_TASK_HAS_NOT_RUN`，代表從來沒跑過，不是跑了失敗）。
  `setup-tasks.ps1` 已加 `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`
  修掉，但如果重灌/搬到別台機器上重新設定，記得這個坑。
- **憑證**：push 走 HTTPS + Windows 既有的 Git Credential Manager 快取，
  跟你平常手動 push 用同一組，不需要另外設定 PAT。
- 更新 `run-job.sh` 或任何腳本邏輯，只要 push 到 `origin/main`，機器人
  clone 下次執行時的 `git reset --hard origin/main` 就會自動抓到最新版，
  不需要重跑 `setup-tasks.ps1`（除非要改任務本身的時間/設定）。
  **但改的是 `run-job.sh` 本身時要注意：推上去之後「下一次」觸發其實還是
  跑舊版**——bash 執行時一開始就把整支腳本讀進記憶體了，腳本中途那行
  `git reset --hard origin/main` 只更新硬碟上的檔案，不會讓正在跑的這個
  process 改吃新內容；硬碟上的檔案變新版之後，要「再下一次」觸發才會真的
  讀到修正過的邏輯。手動測試 `run-job.sh` 的修改時，要連續觸發兩次才能看到
  修正生效（2026-09-12 debug TZ 那個 bug 就是這樣，第 2 次還是錯的，第 3
  次才對）。

## 移除

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\local-trigger\uninstall-tasks.ps1"
```

只解除排程任務，不會刪除 `%USERPROFILE%\skyfire-gps-bot` clone。
