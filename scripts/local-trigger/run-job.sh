#!/usr/bin/env bash
# scripts/local-trigger/run-job.sh
#
# 本機 Windows 工作排程器 (Task Scheduler) 呼叫的統一入口，取代原本
# GitHub Actions 的 `schedule:` 觸發 (4 個 workflow 全部改本機觸發，
# 2026-09-11)。動機：GitHub 排程事件常延遲 1-4 小時 (相關性延遲，非
# runner 壅塞)，導致 YouTube DVR 窗口早已流失；本機用電腦自己的時鐘
# 觸發不受影響，且住宅 IP 可過 YouTube bot-check (不必再靠
# CAPTURE_RUNNER 自架 runner)。
#
# 重要：本腳本設計成在「專用機器人 clone」而非使用者的開發工作目錄下
# 執行 —— 因為它會 `git reset --hard origin/main`，在開發目錄跑會噴掉
# 未 commit 的工作進度。見 scripts/local-trigger/README.md 的
# $BOT_REPO 設定，一律由 setup-tasks.ps1 建立獨立 clone。
#
# 用法: run-job.sh <job-name>
#   lock-sunset / lock-sunrise
#   timelapse-sunrise / timelapse-sunset
#   validate-sunrise / validate-sunset
#   weekly-calibration
set -euo pipefail

JOB="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/logs/local-trigger"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
LOG_FILE="$LOG_DIR/${JOB}-${STAMP}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

export TZ="Asia/Taipei"
# Python 寫到管線 (非終端機) 時預設整批緩衝，不是即時 flush —— 縮時腳本
# 睡到擷取窗前印的訊息會卡在緩衝區裡數小時才噴出來，log 看起來像卡住。
# 逼它每行都 flush，log 才能即時反映進度 (實測 2026-09-11 15:40 那次觸發
# 誤判成「卡住」，其實只是這個緩衝問題，process 一直健康地在睡)。
export PYTHONUNBUFFERED=1
echo "=== [$STAMP 台北] local-trigger job: $JOB (repo: $REPO_ROOT) ==="

if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
echo "使用 $PY: $($PY --version 2>&1)"

# 專用 bot clone 每次都從 origin/main 硬同步，複製 GitHub Actions 每次
# 全新 checkout 的語意；乾淨起跑，不會累積本機殘留狀態。
git fetch origin main -q
git reset --hard origin/main -q

git_commit_push() {
  # $1 = commit message；其餘參數 = 要 add 的路徑
  local msg="$1"; shift
  git add "$@" || true
  if git diff --cached --quiet; then
    echo "沒有變更，略過 commit。"
    return 0
  fi
  git -c user.name="SkyFire Local Bot" -c user.email="local-bot@skyfire.local" commit -m "$msg"
  for i in 1 2 3; do
    if git push origin HEAD:main; then return 0; fi
    echo "push 第 $i 次失敗，重抓 + rebase 後重試…"
    git fetch origin main -q
    git rebase origin/main -q || { git rebase --abort || true; return 1; }
    sleep 3
  done
  echo "::error:: push 多次失敗"
  return 1
}

case "$JOB" in
  lock-sunset|lock-sunrise)
    SESSION="${JOB#lock-}"
    export MANUAL_SESSION="$SESSION"
    node scripts/lock-forecast.js
    node scripts/lock-forecast-multi.js || echo "⚠️ 多機位鎖定失敗，不連坐單站鎖定"
    git_commit_push "chore(forecast): lock prediction score in advance [skip ci]" data/
    ;;

  timelapse-sunrise|timelapse-sunset)
    SESSION="${JOB#timelapse-}"
    DATE_STR="$(date +%F)"
    "$PY" scripts/capture_timelapse_multi_station.py "$SESSION" "$DATE_STR"
    # merge + briefing + commit 是「已 commit 狀態 + 本次擷取輸出」的決定性
    # 重建，推送衝突時硬同步重跑即可 (與 auto_timelapse_multi_station.yml
    # 原本的 retry 迴圈邏輯相同)。
    for i in 1 2 3 4 5; do
      git fetch origin main -q
      git reset --hard origin/main -q
      node scripts/merge-multi-station-calibration.js "$SESSION" "$DATE_STR"
      "$PY" scripts/generate_daily_briefing.py "$SESSION" "$DATE_STR" || true
      git add data/multi-station-records.json data/snapshots data/daily-reports.json || true
      if git diff --staged --quiet; then
        echo "沒有新的校準樣本 / 報告無變化，略過 commit。"
        exit 0
      fi
      git -c user.name="SkyFire Local Bot" -c user.email="local-bot@skyfire.local" \
        commit -m "chore(calibration): record 13-station timelapse ground truth [skip ci]"
      git push origin HEAD:main && exit 0
      echo "push 第 $i 次失敗，重抓後重建再試…"
      sleep 5
    done
    echo "::error:: 多次重試後仍無法 push 13 站校準樣本"
    exit 1
    ;;

  validate-sunrise|validate-sunset)
    SESSION="${JOB#validate-}"
    export MANUAL_SESSION="$SESSION"
    node tests/run-all-tests.js
    # Phase 1/2 個別失敗不連坐後續步驟 (見 auto_validate_capture.yml 註解，
    # 2026-08-18 33 連紅的教訓)。
    node scripts/capture-validation.js "$SESSION" || echo "⚠️ Phase 1 擷取失敗，不連坐後續步驟"
    node scripts/score-ground-truth.js "$SESSION" || echo "⚠️ Phase 2 評分失敗，不連坐後續步驟"
    "$PY" scripts/generate_daily_briefing.py "$SESSION" || true
    git_commit_push "chore(validation): record live sky snapshot and prediction [skip ci]" data/
    ;;

  weekly-calibration)
    "$PY" scripts/auto-calibrate-model.py
    git_commit_push "chore(model): auto-calibrated physics weights from empirical observations [skip ci]" data/model-calibration-params.json
    ;;

  *)
    echo "未知的 JOB: '$JOB'"
    echo "可用: lock-sunset lock-sunrise timelapse-sunrise timelapse-sunset validate-sunrise validate-sunset weekly-calibration"
    exit 2
    ;;
esac

echo "=== [$JOB] 完成 ==="
