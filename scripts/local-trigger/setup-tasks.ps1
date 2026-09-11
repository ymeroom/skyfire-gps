<#
.SYNOPSIS
  一次性設定：建立獨立的「機器人 clone」+ 註冊 Windows 工作排程器任務，
  取代 4 個 GitHub Actions workflow 的 schedule 觸發。

.DESCRIPTION
  為什麼要獨立 clone (預設 $env:USERPROFILE\skyfire-gps-bot)，而不是直接
  在你目前的開發目錄 (D:\working space\skyfire-gps) 上跑？
  因為 run-job.sh 每次執行都會 `git reset --hard origin/main` 讓起跑狀態
  乾淨 (跟 GitHub Actions 每次全新 checkout 語意一致)。在開發目錄跑會把
  你尚未 commit 的工作進度噴掉。獨立 clone 只給機器人用，安全。

  本機已有 ffmpeg / yt-dlp / python (yt-dlp, pillow, numpy) 且無
  package.json 相依套件，所以 clone 完不需要額外 npm/pip install。

  工作排程設定：
    - WakeToRun：電腦睡眠中會被喚醒執行 (無法喚醒「完全關機」，那需要
      主機板 BIOS 排程開機，超出本腳本範圍)。
    - StartWhenAvailable：錯過的排程 (電腦當時真的關機) 下次開機/登入
      後會盡快補跑一次。
    - 「只在使用者登入時執行」：確保能存取你既有的 git 憑證快取
      (Windows Credential Manager / Git Credential Manager)，push 不會
      因為背景 session 拿不到憑證而失敗。

.NOTES
  重跑本腳本是安全的 (冪等)：已存在的排程任務會先解除再重新註冊。
#>

param(
  [string]$BotRepo = "$env:USERPROFILE\skyfire-gps-bot",
  [string]$RepoUrl = "https://github.com/ymeroom/skyfire-gps.git",
  [string]$BashExe = "C:\Program Files\Git\bin\bash.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BashExe)) {
  throw "找不到 Git Bash: $BashExe -- 請確認 Git for Windows 已安裝，或用 -BashExe 指定路徑"
}

if (-not (Test-Path $BotRepo)) {
  Write-Host "== 建立機器人專用 clone: $BotRepo =="
  git clone $RepoUrl $BotRepo
} else {
  Write-Host "== 機器人 clone 已存在: $BotRepo (跳過 clone，run-job.sh 每次會自己 git reset --hard) =="
}

$RunJob = Join-Path $BotRepo "scripts\local-trigger\run-job.sh"
# bash.exe 吃 POSIX 路徑；Windows 路徑轉成 /c/... 形式
function ToBashPath([string]$winPath) {
  $p = $winPath -replace '\\', '/'
  if ($p -match '^([A-Za-z]):(.*)$') {
    return "/" + $matches[1].ToLower() + $matches[2]
  }
  return $p
}
$RunJobBash = ToBashPath $RunJob

$Settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 5)

$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

function Register-Job {
  param(
    [string]$TaskName,
    [string]$JobArg,
    [Parameter(Mandatory)][object[]]$Triggers
  )
  $Action = New-ScheduledTaskAction -Execute $BashExe -Argument "-lc `"'$RunJobBash' $JobArg`""
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers `
    -Settings $Settings -Principal $Principal `
    -Description "SkyFire GPS 本機自動排程 ($JobArg)，取代原 GitHub Actions schedule 觸發" | Out-Null
  Write-Host "  已註冊: $TaskName -> $JobArg"
}

Write-Host "== 註冊工作排程任務 (\SkyFireGPS\ 資料夾) =="

# 預測鎖定：日落 15:30 / 日出 23:45 (與 .github/workflows/lock_forecast.yml 原排程一致)
Register-Job "SkyFireGPS-Lock-Sunset"  "lock-sunset"  (New-ScheduledTaskTrigger -Daily -At "15:30")
Register-Job "SkyFireGPS-Lock-Sunrise" "lock-sunrise" (New-ScheduledTaskTrigger -Daily -At "23:45")

# 13 站縮時擷取：提早於事件前 ~2.5h 觸發，腳本內建睡到 T+45 分再擷取
# (見 capture_timelapse_multi_station.py 的 sleep-until-window 邏輯)
Register-Job "SkyFireGPS-Timelapse-Sunrise" "timelapse-sunrise" (New-ScheduledTaskTrigger -Daily -At "03:05")
Register-Job "SkyFireGPS-Timelapse-Sunset"  "timelapse-sunset"  (New-ScheduledTaskTrigger -Daily -At "15:40")

# 單站驗證：出景當刻 + 定稿報告兩次 (與 auto_validate_capture.yml 原本 4 個 cron 對應)
Register-Job "SkyFireGPS-Validate-Sunrise" "validate-sunrise" @(
  New-ScheduledTaskTrigger -Daily -At "05:30"
  New-ScheduledTaskTrigger -Daily -At "09:00"
)
Register-Job "SkyFireGPS-Validate-Sunset" "validate-sunset" @(
  New-ScheduledTaskTrigger -Daily -At "18:45"
  New-ScheduledTaskTrigger -Daily -At "21:00"
)

# 每週模型校準：週一 00:00 (與原 UTC 週日 16:00 = 台北週一 00:00 一致)
Register-Job "SkyFireGPS-WeeklyCalibration" "weekly-calibration" `
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "00:00")

Write-Host ""
Write-Host "== 完成。用工作排程器 (taskschd.msc) 搜尋 'SkyFireGPS-' 可看到全部 7 個任務 =="
Write-Host "== log 在 $BotRepo\logs\local-trigger\ (每次執行一個檔案，未進版控) =="
Write-Host "== 手動測試一個任務: Start-ScheduledTask -TaskName SkyFireGPS-Lock-Sunset =="
