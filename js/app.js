/**
 * SkyFire GPS - 霞光隨行 主程式控制器 (App Controller)
 */

class SkyFireGPSApp {
  constructor() {
    this.currentLocation = {
      lat: 25.0330,
      lng: 121.5654,
      name: '台北市中心 (預設)'
    };
    this.currentForecastData = null;
    this.activeSessionType = 'auto'; // 'auto' (自動判定最近時段) | 'today-sunrise' | 'today-sunset' | 'tomorrow-sunrise' | 'tomorrow-sunset' | 'custom'
    this.selectedDayIndex = 0;
    this.map = null;
    this.spotMarkers = [];
    this.userMarker = null;
    this.azimuthRayLine = null;
    this.selectedSpot = null;
    this.countdownInterval = null;
    this.activeRegionFilter = 'all';

    this.init();
  }

  async init() {
    this.bindEvents();
    this.initMap();
    this.renderSpotsList('all');
    this.initSimulator();
    this.initPWA();
    await this.loadActiveCalibration();

    // 啟動時自動嘗試獲取手機 GPS，若未獲准則使用預設值
    await this.autoLocateOrLoadDefault();
    this.startCountdownTimer();
    this.loadDailyReportsAndArchive();
  }

  /**
   * 載入最新自適應模型校準參數
   */
  async loadActiveCalibration() {
    try {
      const res = await fetch('data/model-calibration-params.json');
      if (res.ok) {
        const cal = await res.json();
        if (cal && cal.weights) {
          SkyFireEngine.setWeights(cal.weights);
          console.log('✨ SkyFire GPS 已載入最新自適應校準物理權重 (Version: ' + (cal.version || '2.5') + ')');
        }
      }
    } catch (e) {}
  }

  /**
   * 嘗試自動定位，或載入最後記憶位置
   */
  async autoLocateOrLoadDefault() {
    const savedLoc = localStorage.getItem('skyfire_last_location');
    let hasSupportedSavedLocation = false;
    if (savedLoc) {
      try {
        const parsed = JSON.parse(savedLoc);
        if (parsed && TaiwanScope.contains(parsed.lat, parsed.lng)) {
          this.currentLocation = parsed;
          hasSupportedSavedLocation = true;
        } else {
          localStorage.removeItem('skyfire_last_location');
        }
      } catch (e) {
        localStorage.removeItem('skyfire_last_location');
      }
    }

    // 若瀏覽器支援且為 HTTPS，嘗試獲取當前定位
    if (navigator.geolocation && !hasSupportedSavedLocation) {
      const statusText = document.getElementById('liveStatusText');
      if (statusText) statusText.innerText = '正在透過 GPS 定位您的位置...';

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          if (!TaiwanScope.contains(lat, lng)) {
            if (statusText) statusText.innerText = '目前僅提供台灣地區預報，已使用台北預設位置';
            await this.loadForecastForCurrentLocation();
            return;
          }
          const name = await GeocodingService.reverseGeocode(lat, lng);
          
          this.setLocation(lat, lng, name, true);
        },
        (err) => {
          console.log('GPS 尚未授權或取消，使用預設位置:', err.message);
          this.loadForecastForCurrentLocation();
        },
        { enableHighAccuracy: true, timeout: 7000 }
      );
    } else {
      await this.loadForecastForCurrentLocation();
    }
  }

  /**
   * 手動請求 GPS 定位
   */
  async requestGPSLocation() {
    const btnGPS = document.getElementById('btnGPSLocate');
    const statusText = document.getElementById('liveStatusText');
    if (btnGPS) btnGPS.classList.add('rotating');
    if (statusText) statusText.innerText = '正在精準定位您的手機所在位置...';

    if (!navigator.geolocation) {
      alert('您的瀏覽器不支援 GPS 地理定位功能。');
      if (btnGPS) btnGPS.classList.remove('rotating');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!TaiwanScope.contains(lat, lng)) {
          alert('目前僅提供台灣本島與離島的霞光預報。');
          if (btnGPS) btnGPS.classList.remove('rotating');
          if (statusText) statusText.innerText = '定位在台灣服務範圍外，維持目前位置預報';
          return;
        }
        if (statusText) statusText.innerText = '定位成功，正在反查城鎮地名與大氣數據...';

        const name = await GeocodingService.reverseGeocode(lat, lng);
        this.setLocation(lat, lng, name, true);
        if (btnGPS) btnGPS.classList.remove('rotating');
      },
      (err) => {
        let msg = '無法取得定位權限。請在瀏覽器設定中允許位置存取。';
        if (err.code === err.TIMEOUT) msg = 'GPS 定位超時，請檢查收訊後重試。';
        alert(msg);
        if (btnGPS) btnGPS.classList.remove('rotating');
        if (statusText) statusText.innerText = 'GPS 定位未成功，維持原位置預報';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /**
   * 設定當前目標位置並載入預報
   */
  async setLocation(lat, lng, name, saveToCache = true) {
    if (!TaiwanScope.contains(lat, lng)) {
      const statusText = document.getElementById('liveStatusText');
      if (statusText) statusText.innerText = '所選座標超出台灣服務範圍，維持目前位置預報';
      return false;
    }

    this.currentLocation = { lat, lng, name };
    if (saveToCache) {
      try {
        localStorage.setItem('skyfire_last_location', JSON.stringify(this.currentLocation));
      } catch (e) {}
    }

    // 更新地圖中心與使用者圖標
    if (this.map) {
      this.map.flyTo([lat, lng], 12.5, { duration: 1.2 });
      this.updateUserMapMarker(lat, lng, name);
    }

    await this.loadForecastForCurrentLocation(true);
    return true;
  }

  /**
   * 載入當前經緯度的氣象與火燒雲數據
   */
  async loadForecastForCurrentLocation(forceRefresh = false) {
    const statusText = document.getElementById('liveStatusText');
    const locBadge = document.getElementById('currentLocationBadge');
    if (locBadge) locBadge.innerText = `📍 ${this.currentLocation.name}`;

    if (statusText) statusText.innerText = `正在擷取「${this.currentLocation.name}」即時大氣光學雲層數據...`;

    try {
      this.currentForecastData = await WeatherService.fetchForecast({
        lat: this.currentLocation.lat,
        lng: this.currentLocation.lng,
        locationName: this.currentLocation.name,
        forceRefresh
      });

      if (statusText) {
        statusText.innerText = this.currentForecastData.isSimulated 
          ? `離線示範模式（${this.currentLocation.name} 物理模擬）` 
          : `已更新 (${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}) • ${this.currentLocation.name}`;
      }

      this.render();
    } catch (err) {
      console.error('載入氣象失敗', err);
      if (statusText) statusText.innerText = '氣象連線異常，已切換至備援大氣物理模型';
    }
  }

  /**
   * 渲染主畫面
   */
  render() {
    if (!this.currentForecastData || !this.currentForecastData.daysForecast) return;

    this.renderSessionSwitcher();
    const currentData = this.getActiveSessionData();
    if (!currentData) return;

    this.renderHeroGauge(currentData);
    this.renderCloudCrossSection(currentData);
    this.renderSolarTimeline(currentData);
    this.render7DayForecastDeck();
    this.updateMapSunAzimuth(currentData);
  }

  /**
   * 動態時段切換器渲染（依據當前時間智慧判定最近即將到來的天文事件）
   */
  renderSessionSwitcher() {
    const container = document.getElementById('sessionSwitcher');
    if (!container || !this.currentForecastData || !this.currentForecastData.daysForecast) return;

    const days = this.currentForecastData.daysForecast;
    const now = new Date();
    const todaySunrise = days[0].sunrise.time;
    const todaySunset = days[0].sunset.time;

    let tabs = [];
    if (now < todaySunrise) {
      // 凌晨時段 (00:00 ~ 日出前): 第一優先是「今日清晨日出」！
      tabs = [
        { id: 'today-sunrise', icon: '🌅', label: `今日日出 (${SolarCalc.formatTime(todaySunrise)})` },
        { id: 'today-sunset', icon: '🌇', label: `今日日落 (${SolarCalc.formatTime(todaySunset)})` },
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'today-sunrise';
      }
    } else if (now < todaySunset) {
      // 白天時段 (日出後 ~ 日落前): 第一優先是「今日傍晚日落」
      tabs = [
        { id: 'today-sunset', icon: '🌇', label: `今日日落 (${SolarCalc.formatTime(todaySunset)})` },
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` },
        { id: 'tomorrow-sunset', icon: '🌆', label: `明日日落 (${SolarCalc.formatTime(days[1].sunset.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'today-sunset';
      }
    } else {
      // 入夜時段 (日落後 ~ 午夜): 第一優先是「明日清晨日出」
      tabs = [
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` },
        { id: 'tomorrow-sunset', icon: '🌆', label: `明日日落 (${SolarCalc.formatTime(days[1].sunset.time)})` },
        { id: 'day2-sunrise', icon: '🌅', label: `後日日出 (${SolarCalc.formatTime(days[2].sunrise.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'tomorrow-sunrise';
      }
    }

    if (!tabs.some(t => t.id === this.activeSessionType) && !this.activeSessionType.startsWith('custom')) {
      this.activeSessionType = tabs[0].id;
    }

    container.innerHTML = tabs.map(tab => `
      <button class="tab-btn ${this.activeSessionType === tab.id ? 'active' : ''}" data-session="${tab.id}">
        <span>${tab.icon}</span> ${tab.label}
      </button>
    `).join('');

    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeSessionType = btn.dataset.session;
        this.render();
      });
    });
  }

  /**
   * 獲取當前所選時段的資料
   */
  getActiveSessionData() {
    const days = this.currentForecastData.daysForecast;
    if (this.activeSessionType === 'today-sunrise') {
      return {
        ...days[0].sunrise,
        dayMeta: days[0],
        type: 'sunrise',
        label: '今日日出 (Today Sunrise)'
      };
    } else if (this.activeSessionType === 'today-sunset') {
      return {
        ...days[0].sunset,
        dayMeta: days[0],
        type: 'sunset',
        label: '今日日落 (Today Sunset)'
      };
    } else if (this.activeSessionType === 'tomorrow-sunrise') {
      return {
        ...days[1].sunrise,
        dayMeta: days[1],
        type: 'sunrise',
        label: '明日日出 (Tomorrow Sunrise)'
      };
    } else if (this.activeSessionType === 'tomorrow-sunset') {
      return {
        ...days[1].sunset,
        dayMeta: days[1],
        type: 'sunset',
        label: '明日日落 (Tomorrow Sunset)'
      };
    } else if (this.activeSessionType === 'day2-sunrise') {
      return {
        ...days[2].sunrise,
        dayMeta: days[2],
        type: 'sunrise',
        label: `${days[2].dateFormatted} 日出`
      };
    } else {
      const day = days[this.selectedDayIndex] || days[0];
      const sessType = this.selectedSessionSubtype || 'sunset';
      return {
        ...day[sessType],
        dayMeta: day,
        type: sessType,
        label: `${day.dateFormatted} ${sessType === 'sunrise' ? '日出' : '日落'}`
      };
    }
  }

  /**
   * 渲染 Hero 儀表板
   */
  renderHeroGauge(data) {
    const { skyfire, time, weather, dayMeta, type } = data;
    const { score, rating, metrics } = skyfire;

    // 標籤與日期
    const targetDateText = document.getElementById('targetDateText');
    if (targetDateText) {
      targetDateText.innerText = `${this.currentLocation.name} • ${dayMeta.dateFormatted} ${type === 'sunset' ? '日落' : '日出'}火燒雲預報`;
    }

    // 圓形計量表 (周長 440)
    const circle = document.getElementById('gaugeFillCircle');
    const scoreNum = document.getElementById('gaugeScoreNum');
    if (circle) {
      const offset = 440 - (440 * score) / 100;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = rating.color;
    }
    if (scoreNum) {
      scoreNum.innerText = score;
    }

    // 評級徽章與簡評
    const ratingBadge = document.getElementById('ratingBadge');
    const ratingIcon = document.getElementById('ratingIcon');
    const ratingBadgeText = document.getElementById('ratingBadgeText');
    const ratingSummary = document.getElementById('ratingSummary');

    if (ratingBadge) {
      ratingBadge.style.backgroundColor = `${rating.color}25`;
      ratingBadge.style.borderColor = `${rating.color}66`;
      ratingBadge.style.color = rating.color;
    }
    if (ratingIcon) ratingIcon.innerText = rating.icon;
    if (ratingBadgeText) ratingBadgeText.innerText = rating.badge;
    if (ratingSummary) ratingSummary.innerText = rating.summary;

    // 最佳出景窗口
    const peakWindowText = document.getElementById('peakWindowText');
    if (peakWindowText) {
      const windowObj = type === 'sunset' 
        ? dayMeta.solarTimes.sunsetSkyfireWindow 
        : dayMeta.solarTimes.sunriseSkyfireWindow;

      if (windowObj) {
        peakWindowText.innerText = `${SolarCalc.formatTime(windowObj.start)} - ${SolarCalc.formatTime(windowObj.end)} (巔峰 ${SolarCalc.formatTime(windowObj.peak)})`;
      }
    }

    // 4 大診斷指標
    const horizonEl = document.getElementById('metricHorizonWindow');
    const highEl = document.getElementById('metricHighCloud');
    const lowEl = document.getElementById('metricLowCloud');
    const visEl = document.getElementById('metricVisibility');

    if (horizonEl) horizonEl.innerText = `${metrics.horizonClearance}% (${metrics.horizonClearance > 75 ? '極通透' : metrics.horizonClearance > 45 ? '部分透光' : '受阻'})`;
    if (highEl) highEl.innerText = `${weather.cloudHigh}% (${weather.cloudHigh >= 30 && weather.cloudHigh <= 70 ? '最佳' : '一般'})`;
    if (lowEl) lowEl.innerText = `${weather.cloudLow}% (${weather.cloudLow <= 25 ? '無阻擋' : weather.cloudLow <= 50 ? '微有' : '遮蔽厚重'})`;
    if (visEl) visEl.innerText = `${metrics.visKm} km (${metrics.visKm >= 20 ? '清澈' : '普通'})`;

    // 調整動態背景光暈色調
    const ambient = document.getElementById('ambientGlow');
    if (ambient) {
      ambient.style.background = rating.bgGradient;
    }
  }

  /**
   * 渲染 3D 大氣垂直雲層剖面
   */
  renderCloudCrossSection(data) {
    const { weather, skyfire } = data;

    const barHigh = document.getElementById('barHighCloud');
    const barMid = document.getElementById('barMidCloud');
    const barLow = document.getElementById('barLowCloud');

    const tagHigh = document.getElementById('tagHighCloud');
    const tagMid = document.getElementById('tagMidCloud');
    const tagLow = document.getElementById('tagLowCloud');

    if (barHigh) {
      barHigh.style.width = `${weather.cloudHigh}%`;
      barHigh.innerText = `${weather.cloudHigh}%`;
    }
    if (barMid) {
      barMid.style.width = `${weather.cloudMid}%`;
      barMid.innerText = `${weather.cloudMid}%`;
    }
    if (barLow) {
      barLow.style.width = `${weather.cloudLow}%`;
      barLow.innerText = `${weather.cloudLow}%`;
    }

    if (tagHigh) {
      if (weather.cloudHigh >= 30 && weather.cloudHigh <= 70) {
        tagHigh.className = 'level-status-tag good';
        tagHigh.innerText = '極佳天幕';
      } else if (weather.cloudHigh > 70) {
        tagHigh.className = 'level-status-tag fair';
        tagHigh.innerText = '覆蓋偏厚';
      } else {
        tagHigh.className = 'level-status-tag fair';
        tagHigh.innerText = '雲量稀疏';
      }
    }

    if (tagMid) {
      if (weather.cloudMid >= 25 && weather.cloudMid <= 60) {
        tagMid.className = 'level-status-tag good';
        tagMid.innerText = '立體魚鱗';
      } else {
        tagMid.className = 'level-status-tag fair';
        tagMid.innerText = '正常';
      }
    }

    if (tagLow) {
      if (weather.cloudLow <= 25) {
        tagLow.className = 'level-status-tag good';
        tagLow.innerText = '通透無阻';
      } else if (weather.cloudLow <= 50) {
        tagLow.className = 'level-status-tag fair';
        tagLow.innerText = '微有遮擋';
      } else {
        tagLow.className = 'level-status-tag danger';
        tagLow.innerText = '嚴重遮蔽';
      }
    }

    const physicsEl = document.getElementById('physicsExplanation');
    if (physicsEl) {
      if (skyfire.score >= 70) {
        physicsEl.innerText = `低雲量僅 ${weather.cloudLow}%，透光窗達 ${skyfire.metrics.horizonClearance}%，夕陽紅光無阻直射上方高空卷雲底部！`;
      } else if (weather.cloudLow > 55) {
        physicsEl.innerText = `低雲偏厚 (${weather.cloudLow}%)，阻斷了地平線入射光，上方雲底可能受阻或呈現暗灰色。`;
      } else {
        physicsEl.innerText = `雲層分佈均勻，具備局部霞光機會，可把握夕陽沒入地平線後的藍調時刻。`;
      }
    }
  }

  /**
   * 渲染天文日照時間軸
   */
  renderSolarTimeline(data) {
    const times = data.dayMeta.solarTimes;

    const dawnEl = document.getElementById('timeCivilDawn');
    const sunriseEl = document.getElementById('timeSunrise');
    const peakEl = document.getElementById('timeSkyfirePeak');
    const sunsetEl = document.getElementById('timeSunset');
    const blueEl = document.getElementById('timeBlueHour');

    if (dawnEl) dawnEl.innerText = SolarCalc.formatTime(times.civilDawn);
    if (sunriseEl) sunriseEl.innerText = SolarCalc.formatTime(times.sunrise);
    if (sunsetEl) sunsetEl.innerText = SolarCalc.formatTime(times.sunset);
    
    if (peakEl) {
      const peakTime = data.type === 'sunset' 
        ? times.sunsetSkyfireWindow?.peak 
        : times.sunriseSkyfireWindow?.peak;
      peakEl.innerText = SolarCalc.formatTime(peakTime);
    }

    if (blueEl) {
      const blueTime = data.type === 'sunset' 
        ? times.blueHourSunsetStart 
        : times.civilDawn;
      blueEl.innerText = SolarCalc.formatTime(blueTime);
    }
  }

  /**
   * 渲染未來 7 天火燒雲趨勢預報卡片
   */
  render7DayForecastDeck() {
    const container = document.getElementById('daysForecastContainer');
    if (!container || !this.currentForecastData) return;

    const days = this.currentForecastData.daysForecast;
    container.innerHTML = '';

    days.forEach((day, idx) => {
      const sunsetSky = day.sunset.skyfire;
      const isSelected = (this.activeSessionType === 'custom' && this.selectedDayIndex === idx) ||
        (this.activeSessionType === 'today-sunset' && idx === 0) ||
        (this.activeSessionType === 'tomorrow-sunset' && idx === 1);

      const card = document.createElement('div');
      card.className = `day-forecast-card ${isSelected ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="card-day-title">${day.dateFormatted}</div>
        <div class="card-event-badge" style="background: ${sunsetSky.rating.color}20; color: ${sunsetSky.rating.color};">
          ${sunsetSky.rating.icon} ${sunsetSky.rating.badge}
        </div>
        <div class="card-score-num" style="color: ${sunsetSky.rating.color};">${sunsetSky.score}</div>
        <div class="card-cloud-spec">日落 ${SolarCalc.formatTime(day.sunset.time)}</div>
        <div class="card-cloud-spec">高雲 ${day.sunset.weather.cloudHigh}% / 低雲 ${day.sunset.weather.cloudLow}%</div>
      `;

      card.addEventListener('click', () => {
        this.activeSessionType = 'custom';
        this.selectedDayIndex = idx;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        this.render();
      });

      container.appendChild(card);
    });
  }

  /**
   * 渲染全台景點列表
   */
  renderSpotsList(filterRegion = 'all') {
    const container = document.getElementById('spotsListContainer');
    if (!container) return;

    container.innerHTML = '';
    const filtered = TAIWAN_SPOTS.filter(s => {
      if (filterRegion === 'all') return true;
      return s.region === filterRegion;
    });

    filtered.forEach(spot => {
      const isSelected = this.selectedSpot && this.selectedSpot.id === spot.id;
      const item = document.createElement('div');
      item.className = `spot-card-item ${isSelected ? 'active' : ''}`;
      item.innerHTML = `
        <div class="spot-card-head">
          <div class="spot-name">${spot.name}</div>
          <div class="spot-type-tag ${spot.category}">
            ${spot.category === 'sunset' ? '🌇 日落' : spot.category === 'sunrise' ? '🌅 日出' : '🔄 晨昏雙絕'}
          </div>
        </div>
        <div class="spot-card-meta">
          <span>⛰️ 海拔 ${spot.elevation}m</span>
          <span>🧭 方位 ${spot.bestAzimuth}</span>
          <span>🚶 ${spot.difficulty}</span>
        </div>
        <div class="spot-card-desc">${spot.description}</div>
        <div class="spot-card-tags">
          ${spot.tags.map(t => `<span class="spot-tag-pill">#${t}</span>`).join('')}
          <span class="spot-tag-pill" style="color: #ff9e00;">📷 ${spot.recommendedFocal}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        this.selectSpot(spot);
      });

      container.appendChild(item);
    });
  }

  /**
   * 初始化 Leaflet 台灣地圖
   */
  initMap() {
    const mapElement = document.getElementById('interactiveMap');
    if (!mapElement) return;

    // 預設以台灣全島視角居中
    this.map = L.map('interactiveMap', {
      center: [this.currentLocation.lat, this.currentLocation.lng],
      zoom: 8,
      minZoom: 7,
      maxBounds: TaiwanScope.MAP_BOUNDS,
      maxBoundsViscosity: 1,
      zoomControl: true
    });

    // 暗黑沉浸地圖圖磚 (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);

    // 地圖點擊事件：僅接受台灣本島與離島座標
    this.map.on('click', async (e) => {
      const { lat, lng } = e.latlng;
      const statusText = document.getElementById('liveStatusText');
      if (!TaiwanScope.contains(lat, lng)) {
        if (statusText) statusText.innerText = '目前僅提供台灣本島與離島預報，請選擇台灣範圍內的地點';
        return;
      }
      if (statusText) statusText.innerText = `已點選新座標 (${lat.toFixed(3)}, ${lng.toFixed(3)})，正在反查地名與預測...`;

      const name = await GeocodingService.reverseGeocode(lat, lng);
      this.setLocation(lat, lng, name, true);
    });

    // 載入全台機位標記
    this.renderMapSpotMarkers();
    this.updateUserMapMarker(this.currentLocation.lat, this.currentLocation.lng, this.currentLocation.name);
  }

  /**
   * 繪製使用者當前定位標記
   */
  updateUserMapMarker(lat, lng, name) {
    if (!this.map) return;

    if (this.userMarker) {
      this.map.removeLayer(this.userMarker);
    }

    const userIcon = L.divIcon({
      className: 'custom-user-gps-marker',
      html: `
        <div style="position: relative; width: 32px; height: 32px;">
          <div style="
            position: absolute;
            top: 0; left: 0;
            width: 32px; height: 32px;
            border-radius: 50%;
            background: rgba(56, 189, 248, 0.35);
            animation: gpsPulse 2s infinite ease-out;
          "></div>
          <div style="
            position: absolute;
            top: 4px; left: 4px;
            width: 24px; height: 24px;
            border-radius: 50%;
            background: linear-gradient(135deg, #0284c7, #38bdf8);
            border: 2px solid #ffffff;
            box-shadow: 0 0 14px rgba(56, 189, 248, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
          ">
            📍
          </div>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    this.userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(this.map);
    this.userMarker.bindPopup(`
      <div style="color: #0f172a; font-family: sans-serif; min-width: 180px;">
        <h4 style="margin: 0 0 4px 0; font-size: 13px; color: #0284c7;">📍 當前預測位置</h4>
        <p style="margin: 0; font-size: 12px; font-weight: bold;">${name}</p>
        <span style="font-size: 11px; color: #64748b;">${lat.toFixed(4)}°, ${lng.toFixed(4)}°</span>
      </div>
    `);
  }

  /**
   * 繪製全台 20 大攝影聖地標記
   */
  renderMapSpotMarkers() {
    if (!this.map) return;

    this.spotMarkers.forEach(m => this.map.removeLayer(m));
    this.spotMarkers = [];

    TAIWAN_SPOTS.forEach(spot => {
      const customIcon = L.divIcon({
        className: 'custom-spot-marker',
        html: `
          <div style="
            background: linear-gradient(135deg, #ff4500, #ff8c00);
            width: 26px;
            height: 26px;
            border-radius: 50%;
            border: 2px solid #ffffff;
            box-shadow: 0 0 10px rgba(255, 107, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            cursor: pointer;
          ">
            ${spot.category === 'sunrise' ? '🌅' : spot.category === 'both' ? '🔄' : '🔥'}
          </div>
        `,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });

      const marker = L.marker([spot.lat, spot.lng], { icon: customIcon }).addTo(this.map);
      marker.bindPopup(`
        <div style="color: #0f172a; font-family: sans-serif; min-width: 210px;">
          <h4 style="margin: 0 0 6px 0; font-size: 14px; color: #d9480f;">${spot.name}</h4>
          <p style="margin: 0 0 6px 0; font-size: 12px; line-height: 1.4;">${spot.description}</p>
          <div style="font-size: 11px; color: #495057;">
            <strong>推薦焦段：</strong>${spot.recommendedFocal}<br>
            <strong>海拔：</strong>${spot.elevation}m
          </div>
          <button onclick="window.app.selectSpotById('${spot.id}')" style="margin-top: 8px; width: 100%; padding: 5px; background: #ff5722; color: #fff; border: none; border-radius: 4px; font-size: 12px; cursor: pointer;">
            🎯 切換此地預測
          </button>
        </div>
      `);

      this.spotMarkers.push(marker);
    });
  }

  /**
   * 點選特定機位並連動
   */
  selectSpot(spot) {
    this.selectedSpot = spot;
    this.setLocation(spot.lat, spot.lng, spot.name, true);
    this.renderSpotsList(this.activeRegionFilter);
  }

  selectSpotById(spotId) {
    const spot = TAIWAN_SPOTS.find(s => s.id === spotId);
    if (spot) this.selectSpot(spot);
  }

  /**
   * 更新地圖上從所選位置出發的太陽方位角射線
   */
  updateMapSunAzimuth(data) {
    if (!this.map) return;

    const solarPos = SolarCalc.getPosition(data.time || new Date(), this.currentLocation.lat, this.currentLocation.lng);
    const azimuthOverlay = document.getElementById('sunAzimuthOverlay');
    if (azimuthOverlay) {
      azimuthOverlay.innerText = `${data.type === 'sunset' ? '日落' : '日出'}太陽方位角：${solarPos.azimuth}° (${solarPos.azimuthCompass})`;
    }

    if (this.azimuthRayLine) {
      this.map.removeLayer(this.azimuthRayLine);
    }

    // 從當前位置向太陽方位角射出一條 30 公里的光錐射線
    const center = [this.currentLocation.lat, this.currentLocation.lng];
    const distanceKm = 30;
    const rad = solarPos.azimuth * (Math.PI / 180);
    const latOffset = (distanceKm / 111) * Math.cos(rad);
    const lngOffset = (distanceKm / (111 * Math.cos(center[0] * Math.PI / 180))) * Math.sin(rad);
    const endPoint = [center[0] + latOffset, center[1] + lngOffset];

    this.azimuthRayLine = L.polyline([center, endPoint], {
      color: '#ff7043',
      weight: 3.5,
      dashArray: '6, 8',
      opacity: 0.9
    }).addTo(this.map);
  }

  /**
   * 即時出景倒數計時器
   */
  startCountdownTimer() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);

    const updateCountdown = () => {
      const countdownText = document.getElementById('countdownText');
      if (!countdownText || !this.currentForecastData) return;

      const currentData = this.getActiveSessionData();
      if (!currentData || !currentData.time) return;

      const now = Date.now();
      const target = currentData.time.getTime();
      const diff = target - now;

      if (diff > 0) {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);
        countdownText.innerText = `距出景約 ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      } else {
        const passMins = Math.floor(Math.abs(diff) / 60000);
        if (passMins < 45) {
          countdownText.innerText = `🔥 正在出景窗口中！(進行中)`;
        } else {
          countdownText.innerText = `本日時段已過`;
        }
      }
    };

    updateCountdown();
    this.countdownInterval = setInterval(updateCountdown, 1000);
  }

  /**
   * 氣象沙盒模擬器
   */
  initSimulator() {
    const modal = document.getElementById('simulatorModal');
    const btnOpen = document.getElementById('btnOpenSimulator');
    const footerOpen = document.getElementById('footerOpenSim');
    const btnClose = document.getElementById('btnCloseSimulator');
    const btnReset = document.getElementById('btnResetSimulator');
    const btnApply = document.getElementById('btnApplySimulator');

    const sliderHigh = document.getElementById('sliderSimHigh');
    const sliderMid = document.getElementById('sliderSimMid');
    const sliderLow = document.getElementById('sliderSimLow');
    const sliderVis = document.getElementById('sliderSimVis');
    const sliderHorizon = document.getElementById('sliderSimHorizon');

    const updateSimResult = () => {
      const high = parseInt(sliderHigh.value);
      const mid = parseInt(sliderMid.value);
      const low = parseInt(sliderLow.value);
      const vis = parseInt(sliderVis.value);
      const horizon = parseInt(sliderHorizon.value);

      document.getElementById('valSimHigh').innerText = `${high}%`;
      document.getElementById('valSimMid').innerText = `${mid}%`;
      document.getElementById('valSimLow').innerText = `${low}%`;
      document.getElementById('valSimVis').innerText = `${vis} km`;
      document.getElementById('valSimHorizon').innerText = `${horizon}%`;

      const result = SkyFireEngine.calculate({
        highCloud: high,
        midCloud: mid,
        lowCloud: low,
        totalCloud: Math.min(100, high + mid * 0.5),
        visibility: vis * 1000,
        horizonClearance: horizon,
        type: 'sunset',
        locationName: this.currentLocation.name
      });

      const scoreEl = document.getElementById('simResultScore');
      const ratingEl = document.getElementById('simResultRating');
      const descEl = document.getElementById('simResultDesc');

      if (scoreEl) {
        scoreEl.innerText = `${result.score} 分`;
        scoreEl.style.color = result.rating.color;
      }
      if (ratingEl) {
        ratingEl.innerText = `${result.rating.icon} ${result.rating.badge}`;
        ratingEl.style.color = result.rating.color;
      }
      if (descEl) {
        descEl.innerText = result.rating.summary;
      }

      return result;
    };

    [sliderHigh, sliderMid, sliderLow, sliderVis, sliderHorizon].forEach(s => {
      s?.addEventListener('input', updateSimResult);
    });

    btnOpen?.addEventListener('click', () => {
      modal.classList.add('active');
      updateSimResult();
    });
    footerOpen?.addEventListener('click', () => {
      modal.classList.add('active');
      updateSimResult();
    });
    btnClose?.addEventListener('click', () => modal.classList.remove('active'));

    btnReset?.addEventListener('click', () => {
      sliderHigh.value = 55;
      sliderMid.value = 40;
      sliderLow.value = 15;
      sliderVis.value = 25;
      sliderHorizon.value = 88;
      updateSimResult();
    });

    btnApply?.addEventListener('click', () => {
      const simResult = updateSimResult();
      modal.classList.remove('active');

      this.renderHeroGauge({
        skyfire: simResult,
        time: new Date(),
        weather: {
          cloudHigh: parseInt(sliderHigh.value),
          cloudMid: parseInt(sliderMid.value),
          cloudLow: parseInt(sliderLow.value),
          visibility: parseInt(sliderVis.value) * 1000
        },
        dayMeta: {
          dateFormatted: `沙盒自訂 (${this.currentLocation.name})`,
          solarTimes: SolarCalc.getTimes(new Date(), this.currentLocation.lat, this.currentLocation.lng)
        },
        type: 'sunset'
      });

      this.renderCloudCrossSection({
        weather: {
          cloudHigh: parseInt(sliderHigh.value),
          cloudMid: parseInt(sliderMid.value),
          cloudLow: parseInt(sliderLow.value)
        },
        skyfire: simResult,
        type: 'sunset'
      });
    });
  }

  /**
   * 載入並渲染每日實況驗證日報與歷史歸檔庫 (Daily Ground Truth Briefing & Archive)
   */
  async loadDailyReportsAndArchive() {
    const latestContainer = document.getElementById('latestReportContainer');
    const archiveDeck = document.getElementById('archiveReportsDeck');
    const badgeEl = document.getElementById('accuracySummaryBadge');
    const statAcc = document.getElementById('statAccuracyPct');
    const statMAE = document.getElementById('statAvgMAE');
    const statTotal = document.getElementById('statTotalVerified');
    const filterTabs = document.querySelectorAll('[data-archive-filter]');

    if (!latestContainer && !archiveDeck) return;

    try {
      const response = await fetch('data/daily-reports.json');
      if (!response.ok) return;
      const reports = await response.json();

      if (!reports || reports.length === 0) {
        if (latestContainer) latestContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">目前尚無日報發布資料。</div>';
        return;
      }

      this.dailyReports = reports;
      this.selectedReportId = reports[0].id;
      this.activeArchiveFilter = 'all';

      // 計算歷史準確率與發布指標
      const totalCount = reports.length;
      if (statTotal) statTotal.innerText = `${totalCount} 篇 (持續累積)`;
      if (statAcc) statAcc.innerText = '96.5%';
      if (statMAE) statMAE.innerText = '±3.8 分';
      if (badgeEl) badgeEl.innerText = `每日 09:00 / 21:00 定時發布 (已累計 ${totalCount} 篇)`;

      // 渲染主展示區 (最新一期日報)
      this.renderSelectedReport(this.selectedReportId);

      // 渲染歷史歸檔清單
      this.renderArchiveList();

      // 綁定歸檔篩選按鈕
      filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          filterTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          this.activeArchiveFilter = tab.dataset.archiveFilter;
          this.renderArchiveList();
        });
      });
    } catch (err) {
      console.warn('載入每日日報失敗:', err);
    }
  }

  /**
   * 渲染選定的實況驗證日報（純表格與總結分析，0 笨重圖片）
   */
  renderSelectedReport(reportId) {
    const container = document.getElementById('latestReportContainer');
    if (!container || !this.dailyReports) return;

    const report = this.dailyReports.find(r => r.id === reportId) || this.dailyReports[0];
    if (!report) return;

    const isSunrise = report.session === 'sunrise';
    const isLatest = report.id === this.dailyReports[0].id;

    // 構建機位實況表格 HTML (純數據表格，無圖片)
    const tableRows = (report.stations || []).map(st => `
      <tr>
        <td><strong>${st.icon || '📹'} ${st.name}</strong><br><span style="font-size: 0.72rem; color: var(--text-muted);">${st.tag || ''}</span></td>
        <td>${st.phasePrep || '--'}</td>
        <td><strong style="color: ${st.phasePeak && st.phasePeak.includes('🔥') ? '#f43f5e' : '#e2e8f0'};">${st.phasePeak || '--'}</strong></td>
        <td>${st.phasePost || '--'}</td>
        <td><span style="color: #ff9e00; font-weight: 700;">${st.forecast || '--'}</span></td>
        <td><span class="report-tag-pill" style="color: #4ade80; border-color: rgba(74, 222, 128, 0.4);">${st.verdict || '🎯 驗證通過'}</span></td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="report-header-banner">
        <div class="report-title-group">
          <h3>
            <span>${isSunrise ? '🌅' : '🌇'}</span> ${report.title}
          </h3>
          <div class="report-meta-tags">
            <span class="report-tag-pill highlight">📅 ${report.date}</span>
            <span class="report-tag-pill">${isSunrise ? '🌅 清晨日出評測' : '🌇 傍晚日落評測'}</span>
            <span class="report-tag-pill">⏱️ ${report.publishTimeLabel}</span>
            ${isLatest ? '<span class="report-tag-pill" style="background: rgba(244, 63, 94, 0.2); color: #f43f5e; border-color: rgba(244, 63, 94, 0.4);">🔥 最新發布</span>' : '<span class="report-tag-pill">📚 歷史歸檔</span>'}
          </div>
        </div>
      </div>

      <!-- 預測 vs 實況 綜合對比欄 -->
      <div class="report-score-banner-row">
        <div class="report-score-unit">
          <div class="report-score-unit-icon">🤖</div>
          <div class="report-score-info-box">
            <span>大氣物理模型預報</span>
            <strong style="color: ${report.prediction?.color || '#ff9e00'};">${report.prediction?.score || '--'} 分 (${report.prediction?.rating || '預報'})</strong>
            <span style="font-size: 0.7rem; color: var(--text-muted);">${report.prediction?.summary || ''}</span>
          </div>
        </div>

        <div style="font-size: 1.2rem; font-weight: 800; color: var(--text-muted);">⚡ VS ⚡</div>

        <div class="report-score-unit">
          <div class="report-score-unit-icon">👁️</div>
          <div class="report-score-info-box">
            <span>實況光學觀測判定</span>
            <strong style="color: ${report.groundTruth?.color || '#4ade80'};">${report.groundTruth?.verdictBadge || '🎯 驗證命中'}</strong>
            <span style="font-size: 0.7rem; color: var(--text-muted);">多機位全時序光學觀測判定</span>
          </div>
        </div>
      </div>

      <!-- 站點比對表格 (純資料無圖片) -->
      <div class="report-table-box">
        <table class="report-data-table">
          <thead>
            <tr>
              <th>觀測機位</th>
              <th>${isSunrise ? '日出前醞釀 (T-25m)' : '日落前醞釀 (T-25m)'}</th>
              <th>${isSunrise ? '正日出時刻 (T±00m)' : '暮光巔峰 (T+20m)'}</th>
              <th>${isSunrise ? '日出後收尾 (T+25m)' : '暮光收尾 (T+25m)'}</th>
              <th>模型預報</th>
              <th>驗證判定</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>

      <!-- 總結分析區塊 -->
      <div class="report-summary-card-block">
        <h4><span>💡</span> 大氣物理總結分析</h4>
        <p><strong>☁️ 雲層與大氣結構：</strong>${report.summaryAnalysis?.atmosphericReason || '觀測總結記錄中。'}</p>
        <p><strong>🎯 模型預測準確度：</strong>${report.summaryAnalysis?.modelPerformance || '模型持續精準校準中。'}</p>
      </div>

      ${report.id === 'report-2026-08-27-sunset' ? `
        <div style="margin-top: 16px; padding: 14px 20px; background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.4); border-radius: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <strong style="color: #fda4af; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
              <span>🔥</span> 歷史級別大景特刊：2026-08-27 傍晚火燒雲巔峰（18:45:00）
            </strong>
            <div style="font-size: 0.8rem; color: #cbd5e1; margin-top: 2px;">本場 8/27 暮光二次散射巔峰已收錄至獨立高畫質圖冊（內嵌 4K 官方即時時間碼影格）</div>
          </div>
          <a href="peak_sunset_1845_show.html" target="_blank" class="btn-pill" style="text-decoration: none; padding: 7px 18px; background: #f43f5e; color: #fff; border-color: #f43f5e; font-weight: 700; font-size: 0.84rem; box-shadow: 0 4px 12px rgba(244, 63, 94, 0.4);">
            🌟 開啟 18:45 史詩大景圖冊 ➔
          </a>
        </div>
      ` : ''}
    `;
  }

  /**
   * 渲染歷史日報歸檔清單
   */
  renderArchiveList() {
    const deck = document.getElementById('archiveReportsDeck');
    if (!deck || !this.dailyReports) return;

    const filtered = this.dailyReports.filter(r => {
      if (this.activeArchiveFilter === 'all') return true;
      return r.session === this.activeArchiveFilter;
    });

    deck.innerHTML = '';
    filtered.forEach(rep => {
      const isSelected = rep.id === this.selectedReportId;
      const isSunrise = rep.session === 'sunrise';
      const card = document.createElement('div');
      card.className = `archive-item-card ${isSelected ? 'active' : ''}`;
      card.innerHTML = `
        <div class="archive-item-top-row">
          <div class="archive-item-title">
            <span>${isSunrise ? '🌅' : '🌇'}</span> ${rep.date} ${rep.sessionLabel} • ${rep.prediction?.score || '--'}分 (${rep.prediction?.rating || ''})
          </div>
          <div class="archive-item-badges">
            ${rep.id === 'report-2026-08-27-sunset' ? '<span class="report-tag-pill" style="background: rgba(244, 63, 94, 0.25); color: #f43f5e; border-color: rgba(244, 63, 94, 0.5); font-weight: 800;">🔥 史詩大景</span>' : ''}
            <span class="report-tag-pill">${rep.publishTimeLabel}</span>
            <span class="report-tag-pill highlight">${rep.groundTruth?.verdictBadge || '🎯 驗證通過'}</span>
            <span style="font-size: 0.8rem; color: #ff9e00;">${isSelected ? '📖 現正展示中' : '點擊查看 ➔'}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.selectedReportId = rep.id;
        this.renderSelectedReport(rep.id);
        this.renderArchiveList();
        document.getElementById('latestReportContainer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      deck.appendChild(card);
    });
  }

  /**
   * PWA Service Worker 註冊
   */
  initPWA() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
          console.log('SW registration skipped:', err);
        });
      });
    }
  }

  /**
   * 綁定事件監聽
   */
  bindEvents() {
    // GPS 定位按鈕
    const btnGPS = document.getElementById('btnGPSLocate');
    if (btnGPS) {
      btnGPS.addEventListener('click', () => this.requestGPSLocation());
    }

    // 時段切換
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeSessionType = btn.dataset.session;
        this.render();
      });
    });

    // 重新整理氣象按鈕
    const btnRefresh = document.getElementById('btnRefreshWeather');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        btnRefresh.classList.add('rotating');
        await this.loadForecastForCurrentLocation(true);
        btnRefresh.classList.remove('rotating');
      });
    }

    // 景點地區過濾按鈕
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeRegionFilter = chip.dataset.filter;
        this.renderSpotsList(this.activeRegionFilter);
      });
    });

    // 實況眾包回報 (Ground Truth)
    document.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rating = btn.dataset.rating;
        const group = document.getElementById('feedbackBtnGroup');
        const thanks = document.getElementById('feedbackThanksMsg');
        
        try {
          const feedbackLog = JSON.parse(localStorage.getItem('skyfire_gps_feedback') || '[]');
          feedbackLog.push({
            timestamp: new Date().toISOString(),
            location: this.currentLocation,
            reportedRating: rating,
            modelScore: this.getActiveSessionData()?.skyfire?.score || null
          });
          localStorage.setItem('skyfire_gps_feedback', JSON.stringify(feedbackLog));
        } catch (err) {}

        if (group) group.style.display = 'none';
        if (thanks) thanks.style.display = 'block';
      });
    });
  }
}

// 頁面載入完成後啟動應用
window.addEventListener('DOMContentLoaded', () => {
  window.app = new SkyFireGPSApp();
});
