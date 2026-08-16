# 🧭 SkyFire GPS 霞光隨行 (Global & Taiwan SkyFire Predictor)

> **隨身手機 GPS ✕ 全台/全球任意點選 ✕ 火燒雲大氣光學預報平台**

專為追光攝影師、日出日落愛好者與戶外玩家設計的科學化霞光預測網頁應用程式。整合 HTML5 Geolocation 定位、OpenStreetMap 逆地理編碼、Open-Meteo 全球多層雲量氣象數據與物理雷利/米氏散射模型，無論你身在合歡山頂、高美濕地、墾丁海邊還是東京巴黎，打開網頁即可一鍵預測當地的日出/日落火燒雲爆發指數！

---

## 🌟 核心特色 (Core Features)

1. **📍 手機 GPS 一鍵隨身定位**
   - 瀏覽器授權後自動獲取精確經緯度，並透過逆地理編碼反查城鎮地名（如「台中市清水區」、「嘉義縣阿里山鄉」）。
2. **🗺️ 互動地圖任意點選預測 (Interactive Map Pointing)**
   - 點擊地圖任意位置，即刻計算該處的日落/日出時間與火燒雲發生率。
   - 動態在地圖上繪製從該點出發的「太陽方位角光錐射線 (Sun Azimuth Ray)」。
3. **🔥 大氣光學物理演算引擎 (SkyFire Physics Engine V2.5)**
   - **高空卷雲天幕 (+45分)**：6,000m+ 冰晶雲層，長時間接收長波紅橙光。
   - **中空立體積雲 (+20分)**：2,000-6,000m 形成魚鱗、波狀熔岩火燒雲。
   - **低雲遮擋懲罰 (-50分)**：<2,000m 厚低雲阻擋地平線入射光。
   - **遠方地平線透光窗 (Horizon Window)**：200-400 公里外地平線晴朗度指標。
   - **大氣能見度與氣膠 (AQI)**：米氏散射純度微調。
4. **🏔️ 全台 20 大火燒雲攝影聖地**
   - 涵蓋北部（象山、大稻埕、淡水、不厭亭、豆腐岩）、中部/高山（高美濕地、日月潭、合歡山、阿里山、好望角）、南部（井仔腳鹽田、二寮、關山、龍磐、七股沙洲）、東部（七星潭、三仙台、南方澳）與離島（蘭嶼東清灣、澎湖奎壁山）。
5. **📱 PWA 支援 (Progressive Web App)**
   - 支援手機「加入主畫面」，打造近乎原生 App 的全螢幕體驗與離線快取。
6. **🧪 氣象物理沙盒模擬器 (Sandbox Simulator)**
   - 提供 5 大滑桿自由調整高/中/低雲量、能見度與透光窗，即時模擬不同氣候下的火燒雲指數。

---

## 📂 專案架構 (Project Structure)

```
skyfire-gps/
├── index.html              # 主介面與 PWA 進入點
├── manifest.json           # PWA 應用程式清單
├── sw.js                   # Service Worker (離線快取)
├── css/
│   └── style.css           # Glassmorphism 晨昏大氣主題樣式
├── js/
│   ├── app.js              # 主控制器 (GPS 定位、地圖連動、倒數計時)
│   ├── solar-calc.js       # 全球任意經緯度天文太陽時刻與方位角算法
│   ├── skyfire-engine.js   # 大氣光學火燒雲物理評分核心
│   ├── geocoding.js        # 經緯度逆地理編碼服務
│   ├── spots-taiwan.js     # 全台 20 大攝影聖地數據庫
│   └── weather-service.js  # Open-Meteo API 全球氣象串接與快取
└── README.md
```

---

## 🚀 部署至 GitHub Pages 指南

1. 在 GitHub 上建立新 Repository（例如 `skyfire-gps`）。
2. 在本地專案目錄執行：
   ```bash
   cd "d:/working space/skyfire-gps"
   git init
   git add .
   git commit -m "feat: initial release of SkyFire GPS v2.5"
   git branch -M main
   git remote add origin https://github.com/ymeroom/skyfire-gps.git
   git push -u origin main
   ```
3. 在 GitHub 倉庫的 `Settings` -> `Pages` 中，將 `Branch` 設為 `main`，即可獲得專屬網址：
   `https://ymeroom.github.io/skyfire-gps/`

---

## 📄 License & Attribution

- 天氣數據來源：[Open-Meteo Global Weather API](https://open-meteo.com/) (CC-BY 4.0)
- 地圖圖磚：[CartoDB Dark Matter](https://carto.com/) & [OpenStreetMap](https://www.openstreetmap.org/)
- 逆地理編碼：[BigDataCloud](https://www.bigdatacloud.net/) & [OSM Nominatim](https://nominatim.org/)
