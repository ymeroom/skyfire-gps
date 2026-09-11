<#
.SYNOPSIS
  移除 setup-tasks.ps1 註冊的全部 7 個本機排程任務 (不會刪除機器人 clone)。
#>
$Tasks = @(
  "SkyFireGPS-Lock-Sunset", "SkyFireGPS-Lock-Sunrise",
  "SkyFireGPS-Timelapse-Sunrise", "SkyFireGPS-Timelapse-Sunset",
  "SkyFireGPS-Validate-Sunrise", "SkyFireGPS-Validate-Sunset",
  "SkyFireGPS-WeeklyCalibration"
)
foreach ($t in $Tasks) {
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除: $t"
}

