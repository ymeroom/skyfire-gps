# 首頁改版：決策優先版面

日期：2026-09-18
狀態：設計定案，待實作
設計稿：https://claude.ai/artifact/RiE28TJbj7NjxTQNBopfRP（第 1 頁「定案 · 決策優先」三張：桌機 / 手機 390px / 低分夜）

## 目標

現在的首頁把所有資訊平鋪成一整頁：儀表板、雲層剖面、太陽時間軸、7 天預報、地圖、
拍攝指南、科學說明、驗證日報。使用者要自己讀完才能回答那個唯一重要的問題——
**現在值得出門嗎**。

這次改版把首屏收斂成一個答案：大分數、一句判斷、一個主按鈕、倒數。其餘全部退到
下方，透過一排入口抵達。深層資訊一個都不刪，只是不再跟決策爭首屏。

## 範圍

**做：** 首屏新增決策區與入口列；新增「今晚其他機位」逐站分數；低分夜狀態；
`sw.js` 版號 bump。

**不做（既有的產品決定，這次不碰）：**

- `renderSolarTimeline` 把火燒雲巔峰排在日落前面的順序問題（日落場的巔峰本來就在
  日落之後，卡片會出現 18:18 排在 18:03 左邊）。
- `css/style.css:860` 的區塊註解仍寫「20 大攝影聖地」，與實際 13 站不符。
- 真正的推播通知（Web Push）。需要 `sw.js` 推播處理、VAPID 金鑰與一台伺服器，
  是獨立子系統，要自己的設計文檔。低分夜的「提醒我」這一版改用行事曆（見 §5）。

## 1. 頁面結構

採同頁錨點：`index.html` 現有 `<section>` 的順序與 id 全部保留，`app.js` 既有的
渲染目標一個都不動。只新增兩塊，插在 `<section class="hero-dashboard-grid">`
（`index.html:139`）之前：

```
<section id="decisionHero">   ← 新增：大分數環 + 判斷句 + 主按鈕 + 倒數
<div id="deepDiveNav">        ← 新增：四個入口（錨點連結）
<section class="hero-dashboard-grid">  ← 原有，成為「細節」那一層
```

入口列的四個錨點都指向已經存在的區塊，不新增頁面：

| 入口文案 | 錨點 |
|---|---|
| 垂直雲層剖面 | 雲層剖面區塊（`index.html:231` 所在 section，需補 id） |
| 未來一週趨勢 | `.forecast-7day-section`（需補 id） |
| 全台機位地圖 | `#interactiveMapSection` |
| 每日實況日報 | `#verifySection` |

錨點捲動用 CSS `scroll-behavior: smooth` 與 `scroll-margin-top`，不寫 JS。

## 2. 決策區的資料來源

不發任何新請求。決策區與現有儀表讀同一份資料：`render()`（`js/app.js:209`）裡
`getActiveSessionData()` 的回傳值。

在 `render()` 中 `renderHeroGauge(currentData)` 之前插入
`renderDecisionHero(currentData)`，取用欄位與 `renderHeroGauge` 相同
（`skyfire.score`、`skyfire.rating.badge`、`rating.summary`、巔峰時刻、倒數）。

分數環的漸層用產品既有的 `#gaugeGradient`（`index.html:51-54`，
`#ff3366 → #ff6b00 → #ffb800`），不要用設計稿早期版本的 `#ff007f → #ffd700`。

## 3. 「今晚其他機位」

### 資料來源

`scripts/lock-forecast-multi.js` 每天已為每個機位算好分數並 commit 進版控：

- `data/locked-sunrise-multi-forecast.json`——`sunrise` + `both`，7 站
- `data/locked-sunset-multi-forecast.json`——`sunset` + `both`，6 站

前端只抓這一個靜態檔（新增 `loadLockedStations()`），不對 Open-Meteo 發逐站請求，
也不需要自己做快取。檔案結構：

```
{ date, session, lockedAt, stationCount, failures[],
  stations: [ { id, name, lat, lng, category, isSimulated,
                skyfire: { score, rating: {...}, metrics: {...}, diagnostics: [...] },
                weather: {...} } ] }
```

### 規則

1. **時段必須對得上。** 只有當鎖定檔的 `date` + `session` 與當前選中時段一致時才
   顯示分數。`activeSessionType` 可以是 `tomorrow-sunset`、`day2-sunrise` 等
   （`js/app.js:290-340`），那些時段沒有鎖定檔——此時整塊只按距離列出機位、
   不顯示分數，並說明「該時段尚未鎖定逐站預報」。**絕不拿前一天的分數頂替。**
   `run-job.sh:86` 對鎖定失敗是容錯的（`|| echo "⚠️ 多機位鎖定失敗"`），所以
   資料過期是預期狀態，不是邊界情況。

2. **排除當前所選機位。** 首屏分數是現算的，逐站分數是昨晚鎖的。同一個機位若同時
   出現在兩處，畫面上就會有兩個互相矛盾的數字。標題「今晚其他機位」本身即排除了
   當前機位。

3. **每行標鎖定時間**（由 `lockedAt` 轉台北時間，例：`15:45 鎖定`），把「這是預先
   鎖定的預報、不是現在算的」講明白，而不是藏起來。

4. **金龍山永遠沒有分數。** `lock-forecast-multi.js:43` 的 `EXCLUDED_FROM_LOCK`
   刻意排除南投金龍山（YouTube 直播 DVR 只剩約 25 秒，鎖了也配不到實測）。13 站
   中只有 12 站有鎖定分數。該行顯示「無預報（直播 DVR 過短，未納入驗證）」，
   不顯示 0 分也不靜默略過。

5. **距離現算，不顯示車程。** Haversine 距離，用鎖定檔內既有的 `lat`/`lng` 對使用者
   位置計算。設計稿的「12 分鐘」沒有資料來源，不合成這個數字。主按鈕是 Google 地圖
   路線連結 `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`，
   分鐘數交給 Google 算。

6. **文案不寫死站數。** 設計稿的「看全部 13 個」改為不含數字的文案（逐時段是
   7 站 / 6 站，且 12 站有分數）。

## 4. 低分夜

同一套 DOM，以 `data-verdict="low"` 切換樣式，不做第二套版面：

- 分數環轉灰，且 `stroke-linecap: butt`。`round` 在低分那種短弧上會多出約 12 單位
  的圓頭，12 分看起來像 15 分。
- 主按鈕換成「加入行事曆」（見 §5），次要按鈕「看直播就好」連到該機位的 `liveUrl`
  （`spots-taiwan.js` 已有此欄位）。
- 「今晚其他機位」整塊換成「接下來三場」，資料直接讀記憶體裡的
  `this.currentForecastData.daysForecast`（7 天預報已載入的同一份），不加抓取。

判定門檻沿用現有 `skyfire.rating.level`，不引入新的分數區間。

## 5. 加入行事曆

低分夜主按鈕產生下一場的行事曆項目，零後端、離線可用：

- 前端組 `.ics` 字串，以 `Blob` + `URL.createObjectURL` 下載。
- 事件時間用該場的火燒雲巔峰時刻，標題含場次與預測分數，地點帶機位名稱與座標。
- 不需要 VAPID、伺服器或使用者授權；提醒由使用者自己的行事曆負責。

## 6. Service Worker

`sw.js:2` 的 `CACHE_NAME` 從 `skyfire-gps-taiwan-v5` bump 到 `v6`。本次新增了
`data/locked-*-multi-forecast.json` 的抓取路徑，且該檔每天更新——必須確認它走的是
網路優先或至少會重新驗證，不能被 cache-first 永久凍住（`sw.js:49` 註解已記錄舊版
cache-first 的問題）。2026-09-06 的首頁改版就因為快取沒清而需要手動處理一次。

## 測試

- 單元：Haversine 距離對 `spots-taiwan.js` 既有座標的已知值（桃園永安 89km、
  阿里山二延平 99km，自台中清水量測）；`.ics` 字串格式；`lockedAt` 轉台北時間。
- 狀態：鎖定檔時段吻合 / 時段不吻合 / 檔案抓取失敗 / 金龍山無分數 /
  當前機位被正確排除，五種情況各自的渲染結果。
- 版面：390px 寬不出現水平捲動，可點區域 ≥ 44px；桌機 1440px；低分夜與高分夜
  並排檢查數字不互相矛盾。
- 既有行為不回歸：切換 `sessionSwitcher` 後決策區與下方所有區塊同步更新；
  地圖（Leaflet）在同頁錨點下的初始化時機不變。
