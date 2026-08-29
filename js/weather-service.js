/**
 * WeatherService - 串接 Open-Meteo 台灣即時氣象 API 與多層雲量解析
 */

const SolarCalcModule = typeof window !== 'undefined' ? window.SolarCalc : (typeof global !== 'undefined' && global.SolarCalc ? global.SolarCalc : require('./solar-calc.js'));
const SkyFireEngineModule = typeof window !== 'undefined' ? window.SkyFireEngine : (typeof global !== 'undefined' && global.SkyFireEngine ? global.SkyFireEngine : require('./skyfire-engine.js'));

class WeatherService {
  static DEFAULT_COORDS = { lat: 25.057045, lng: 121.507718, name: '台北核心（大稻埕）' };
  static CACHE_KEY_PREFIX = 'skyfire_weather_cache_v2_';
  static CACHE_DURATION_MS = 15 * 60 * 1000; // 15 分鐘快取

  /**
   * 計算沿太陽方位角向量延伸的上游進光點座標 (Upstream Ray-Path Sampling Point)
   * @param {number} lat 本地緯度
   * @param {number} lng 本地經度
   * @param {number} azimuthDeg 太陽方位角 (度，0-360)
   * @param {number} distanceKm 延伸距離 (公里，預設 60km)
   */
  static calculateUpstreamCoords(lat, lng, azimuthDeg, distanceKm = 60) {
    const rad = (azimuthDeg * Math.PI) / 180;
    const deltaLat = (distanceKm * Math.cos(rad)) / 111.32;
    const deltaLng = (distanceKm * Math.sin(rad)) / (111.32 * Math.cos((lat * Math.PI) / 180));
    return {
      lat: parseFloat((lat + deltaLat).toFixed(4)),
      lng: parseFloat((lng + deltaLng).toFixed(4)),
      azimuth: parseFloat(azimuthDeg.toFixed(1)),
      distanceKm
    };
  }

  /**
   * 取得指定經緯度未來 7 天逐小時氣象預報與雙版本雲層高度數據
   * @param {Object} options
   * @param {number} [options.lat] 緯度
   * @param {number} [options.lng] 經度
   * @param {string} [options.locationName] 地點名稱
   * @param {boolean} [options.forceRefresh=false] 是否強制重新整理
   */
  static async fetchForecast(options = {}) {
    const {
      lat = this.DEFAULT_COORDS.lat,
      lng = this.DEFAULT_COORDS.lng,
      locationName = this.DEFAULT_COORDS.name,
      forceRefresh = false
    } = options;

    const roundedLat = parseFloat(lat.toFixed(4));
    const roundedLng = parseFloat(lng.toFixed(4));
    const cacheKey = `${this.CACHE_KEY_PREFIX}${roundedLat}_${roundedLng}`;

    if (!forceRefresh) {
      const cached = this.getCachedForecast(cacheKey);
      if (cached) return cached;
    }

    try {
      // 1. 計算今日太陽方位角，推估日落（海峽/西面）與日出（太平洋/東面）60km 上游進光點座標
      const now = new Date();
      const todaySolar = SolarCalcModule.getTimes(now, roundedLat, roundedLng);
      const sunsetPos = SolarCalcModule.getPosition(todaySolar.sunset || now, roundedLat, roundedLng);
      const sunrisePos = SolarCalcModule.getPosition(todaySolar.sunrise || now, roundedLat, roundedLng);

      const sunsetUpstream = this.calculateUpstreamCoords(roundedLat, roundedLng, sunsetPos.azimuth, 60);
      const sunriseUpstream = this.calculateUpstreamCoords(roundedLat, roundedLng, sunrisePos.azimuth, 60);

      // 2. Open-Meteo 多座標一次批次請求 (觀測點 + 日落進光點 + 日出進光點)
      const lats = `${roundedLat},${sunsetUpstream.lat},${sunriseUpstream.lat}`;
      const lngs = `${roundedLng},${sunsetUpstream.lng},${sunriseUpstream.lng}`;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&hourly=cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,visibility,relativehumidity_2m,precipitation_probability,direct_normal_irradiance,temperature_2m,weathercode&daily=sunrise,sunset&timezone=auto&forecast_days=7`;

      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Open-Meteo API 請求失敗: HTTP ${response.status}`);
      }

      const data = await response.json();
      let rawLocal, rawUpstreamSunset, rawUpstreamSunrise;

      if (Array.isArray(data) && data.length >= 3) {
        rawLocal = data[0];
        rawUpstreamSunset = data[1];
        rawUpstreamSunrise = data[2];
      } else if (Array.isArray(data) && data.length > 0) {
        rawLocal = data[0];
        rawUpstreamSunset = data[0];
        rawUpstreamSunrise = data[0];
      } else {
        rawLocal = data;
        rawUpstreamSunset = data;
        rawUpstreamSunrise = data;
      }

      const parsed = this.processRawData(rawLocal, roundedLat, roundedLng, locationName, rawUpstreamSunset, rawUpstreamSunrise);
      this.cacheForecast(cacheKey, parsed);
      return parsed;
    } catch (err) {
      console.warn('無法連線至 Open-Meteo API，切換為智慧離線物理模擬模型:', err.message);
      return this.generateSimulatedForecast(roundedLat, roundedLng, locationName);
    }
  }

  /**
   * 解析 Open-Meteo 原始數據並計算雙版本（單點 vs 向量光路雙點）火燒雲指數
   */
  static processRawData(rawLocal, lat, lng, locationName, rawUpstreamSunset = null, rawUpstreamSunrise = null) {
    const parseHourly = (raw) => {
      if (!raw || !raw.hourly || !raw.hourly.time) return [];
      const h = raw.hourly;
      return h.time.map((timeStr, i) => ({
        time: new Date(timeStr),
        timeStr,
        cloudHigh: h.cloudcover_high ? h.cloudcover_high[i] : 0,
        cloudMid: h.cloudcover_mid ? h.cloudcover_mid[i] : 0,
        cloudLow: h.cloudcover_low ? h.cloudcover_low[i] : 0,
        cloudTotal: h.cloudcover ? h.cloudcover[i] : 0,
        visibility: h.visibility ? h.visibility[i] : 20000,
        humidity: h.relativehumidity_2m ? h.relativehumidity_2m[i] : 70,
        precipProb: h.precipitation_probability ? h.precipitation_probability[i] : 0,
        temp: h.temperature_2m ? h.temperature_2m[i] : 28,
        weatherCode: h.weathercode ? h.weathercode[i] : 0
      }));
    };

    const hourlyLocal = parseHourly(rawLocal);
    const hourlySunsetUpstream = rawUpstreamSunset ? parseHourly(rawUpstreamSunset) : hourlyLocal;
    const hourlySunriseUpstream = rawUpstreamSunrise ? parseHourly(rawUpstreamSunrise) : hourlyLocal;

    const now = new Date();
    const daysForecast = [];

    // 取未來 7 天
    for (let d = 0; d < 7; d++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const solarTimes = SolarCalcModule.getTimes(targetDate, lat, lng);

      // 計算太陽方位角
      const posSunset = SolarCalcModule.getPosition(solarTimes.sunset, lat, lng);
      const posSunrise = SolarCalcModule.getPosition(solarTimes.sunrise, lat, lng);

      // 提取觀測點與上游進光點的最近小時數據
      const localSunriseWeather = this.getClosestHourData(hourlyLocal, solarTimes.sunrise);
      const localSunsetWeather = this.getClosestHourData(hourlyLocal, solarTimes.sunset);
      const upstreamSunriseWeather = this.getClosestHourData(hourlySunriseUpstream, solarTimes.sunrise);
      const upstreamSunsetWeather = this.getClosestHourData(hourlySunsetUpstream, solarTimes.sunset);

      // ----------------------------------------------------
      // 版本 1: 經典單點模型 (Single-Point Mode)
      // ----------------------------------------------------
      const singlePointSunrise = SkyFireEngineModule.calculate({
        highCloud: localSunriseWeather.cloudHigh,
        midCloud: localSunriseWeather.cloudMid,
        lowCloud: localSunriseWeather.cloudLow,
        totalCloud: localSunriseWeather.cloudTotal,
        visibility: localSunriseWeather.visibility,
        humidity: localSunriseWeather.humidity,
        precipProb: localSunriseWeather.precipProb,
        type: 'sunrise',
        locationName
      });

      const singlePointSunset = SkyFireEngineModule.calculate({
        highCloud: localSunsetWeather.cloudHigh,
        midCloud: localSunsetWeather.cloudMid,
        lowCloud: localSunsetWeather.cloudLow,
        totalCloud: localSunsetWeather.cloudTotal,
        visibility: localSunsetWeather.visibility,
        humidity: localSunsetWeather.humidity,
        precipProb: localSunsetWeather.precipProb,
        type: 'sunset',
        locationName
      });

      // ----------------------------------------------------
      // 版本 2: 向量光路雙點模型 (Dual-Point Ray-Path Mode / 推薦)
      // ----------------------------------------------------
      const sunsetHorizonClearance = Math.max(0, Math.min(100,
        100 - (upstreamSunsetWeather.cloudLow * 1.25 + Math.max(0, upstreamSunsetWeather.cloudTotal - 50) * 0.4)
      ));

      const rayPathSunset = SkyFireEngineModule.calculate({
        highCloud: localSunsetWeather.cloudHigh,
        midCloud: localSunsetWeather.cloudMid,
        lowCloud: localSunsetWeather.cloudLow,
        totalCloud: localSunsetWeather.cloudTotal,
        visibility: localSunsetWeather.visibility,
        humidity: localSunsetWeather.humidity,
        precipProb: localSunsetWeather.precipProb,
        horizonClearance: sunsetHorizonClearance,
        type: 'sunset',
        locationName
      });

      const sunriseHorizonClearance = Math.max(0, Math.min(100,
        100 - (upstreamSunriseWeather.cloudLow * 1.25 + Math.max(0, upstreamSunriseWeather.cloudTotal - 50) * 0.4)
      ));

      const rayPathSunrise = SkyFireEngineModule.calculate({
        highCloud: localSunriseWeather.cloudHigh,
        midCloud: localSunriseWeather.cloudMid,
        lowCloud: localSunriseWeather.cloudLow,
        totalCloud: localSunriseWeather.cloudTotal,
        visibility: localSunriseWeather.visibility,
        humidity: localSunriseWeather.humidity,
        precipProb: localSunriseWeather.precipProb,
        horizonClearance: sunriseHorizonClearance,
        type: 'sunrise',
        locationName
      });

      daysForecast.push({
        date: targetDate,
        dateFormatted: this.formatDateLabel(targetDate, d),
        dayIndex: d,
        solarTimes,
        sunrise: {
          time: solarTimes.sunrise,
          skyfire: rayPathSunrise, // 預設使用先進向量光路模型
          singlePoint: singlePointSunrise,
          rayPath: rayPathSunrise,
          weather: localSunriseWeather,
          upstream: {
            coords: this.calculateUpstreamCoords(lat, lng, posSunrise.azimuth, 60),
            weather: upstreamSunriseWeather,
            horizonClearance: Math.round(sunriseHorizonClearance),
            locationLabel: `東方海面 (方位角 ${posSunrise.azimuth}° · 60km)`
          }
        },
        sunset: {
          time: solarTimes.sunset,
          skyfire: rayPathSunset, // 預設使用先進向量光路模型
          singlePoint: singlePointSunset,
          rayPath: rayPathSunset,
          weather: localSunsetWeather,
          upstream: {
            coords: this.calculateUpstreamCoords(lat, lng, posSunset.azimuth, 60),
            weather: upstreamSunsetWeather,
            horizonClearance: Math.round(sunsetHorizonClearance),
            locationLabel: `西方海面 (方位角 ${posSunset.azimuth}° · 60km)`
          }
        }
      });
    }

    return {
      isSimulated: false,
      location: { lat, lng, name: locationName },
      lastUpdated: new Date(),
      hourly: hourlyLocal,
      daysForecast
    };
  }

  static getClosestHourData(hourlyList, targetDate) {
    if (!targetDate || isNaN(targetDate.getTime()) || hourlyList.length === 0) {
      return hourlyList[0] || { cloudHigh: 30, cloudMid: 30, cloudLow: 20, visibility: 20000, humidity: 65, precipProb: 0 };
    }
    const targetMs = targetDate.getTime();
    let best = hourlyList[0];
    let minDiff = Infinity;

    for (const item of hourlyList) {
      const diff = Math.abs(item.time.getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        best = item;
      }
    }
    return best;
  }

  static formatDateLabel(date, dayOffset) {
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekdayStr = weekdays[date.getDay()];

    if (dayOffset === 0) return `今天 (${month}/${day} ${weekdayStr})`;
    if (dayOffset === 1) return `明天 (${month}/${day} ${weekdayStr})`;
    if (dayOffset === 2) return `後天 (${month}/${day} ${weekdayStr})`;
    return `${month}/${day} (${weekdayStr})`;
  }

  static getCachedForecast(cacheKey) {
    try {
      const item = localStorage.getItem(cacheKey);
      if (!item) return null;
      const data = JSON.parse(item);
      if (Date.now() - new Date(data.cachedAt).getTime() < this.CACHE_DURATION_MS) {
        data.lastUpdated = new Date(data.lastUpdated);
        data.daysForecast.forEach(d => {
          d.date = new Date(d.date);
          d.solarTimes = SolarCalcModule.getTimes(d.date, data.location?.lat, data.location?.lng);
          if (d.sunrise && d.sunrise.time) d.sunrise.time = new Date(d.sunrise.time);
          if (d.sunset && d.sunset.time) d.sunset.time = new Date(d.sunset.time);
        });
        return data;
      }
    } catch (e) {
      console.warn('快取讀取錯誤', e);
    }
    return null;
  }

  static cacheForecast(cacheKey, data) {
    try {
      const payload = {
        ...data,
        cachedAt: new Date().toISOString()
      };
      localStorage.setItem(cacheKey, JSON.stringify(payload));
    } catch (e) {
      // ignore
    }
  }

  /**
   * 離線或模擬模式氣象生成器
   */
  static generateSimulatedForecast(lat, lng, locationName) {
    const now = new Date();
    const daysForecast = [];

    const sampleScenarios = [
      { high: 62, mid: 40, low: 12, vis: 26000, humidity: 60, precip: 0 },  // 壯麗火燒雲
      { high: 75, mid: 32, low: 15, vis: 24000, humidity: 65, precip: 0 },  // 史詩級高空漫射
      { high: 25, mid: 18, low: 22, vis: 18000, humidity: 55, precip: 0 },  // 局部微霞
      { high: 50, mid: 48, low: 18, vis: 28000, humidity: 58, precip: 0 },  // 魚鱗雲火燒
      { high: 15, mid: 25, low: 70, vis: 9000, humidity: 85, precip: 60 },  // 陰雨厚低雲
      { high: 68, mid: 30, low: 10, vis: 32000, humidity: 54, precip: 0 },  // 通透火燒
      { high: 40, mid: 35, low: 25, vis: 20000, humidity: 68, precip: 10 }  // 柔和黃金霞光
    ];

    for (let d = 0; d < 7; d++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const solarTimes = SolarCalcModule.getTimes(targetDate, lat, lng);
      const scnSunset = sampleScenarios[d % sampleScenarios.length];
      const scnSunrise = sampleScenarios[(d + 2) % sampleScenarios.length];

      const sunsetSkyfire = SkyFireEngineModule.calculate({
        highCloud: scnSunset.high,
        midCloud: scnSunset.mid,
        lowCloud: scnSunset.low,
        totalCloud: Math.min(100, scnSunset.high + scnSunset.mid * 0.5),
        visibility: scnSunset.vis,
        humidity: scnSunset.humidity,
        precipProb: scnSunset.precip,
        type: 'sunset',
        locationName
      });

      const sunriseSkyfire = SkyFireEngineModule.calculate({
        highCloud: scnSunrise.high,
        midCloud: scnSunrise.mid,
        lowCloud: scnSunrise.low,
        totalCloud: Math.min(100, scnSunrise.high + scnSunrise.mid * 0.5),
        visibility: scnSunrise.vis,
        humidity: scnSunrise.humidity,
        precipProb: scnSunrise.precip,
        type: 'sunrise',
        locationName
      });

      daysForecast.push({
        date: targetDate,
        dateFormatted: this.formatDateLabel(targetDate, d),
        dayIndex: d,
        solarTimes,
        sunrise: {
          time: solarTimes.sunrise,
          skyfire: sunriseSkyfire,
          weather: {
            cloudHigh: scnSunrise.high,
            cloudMid: scnSunrise.mid,
            cloudLow: scnSunrise.low,
            visibility: scnSunrise.vis,
            humidity: scnSunrise.humidity,
            precipProb: scnSunrise.precip,
            temp: 24
          }
        },
        sunset: {
          time: solarTimes.sunset,
          skyfire: sunsetSkyfire,
          weather: {
            cloudHigh: scnSunset.high,
            cloudMid: scnSunset.mid,
            cloudLow: scnSunset.low,
            visibility: scnSunset.vis,
            humidity: scnSunset.humidity,
            precipProb: scnSunset.precip,
            temp: 29
          }
        }
      });
    }

    return {
      isSimulated: true,
      location: { lat, lng, name: locationName },
      lastUpdated: new Date(),
      daysForecast
    };
  }
}

if (typeof window !== 'undefined') {
  window.WeatherService = WeatherService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WeatherService;
}
