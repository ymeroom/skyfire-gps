/**
 * WeatherService - 串接 Open-Meteo 台灣即時氣象 API 與多層雲量解析
 */

const SolarCalcModule = typeof window !== 'undefined' ? window.SolarCalc : (typeof global !== 'undefined' && global.SolarCalc ? global.SolarCalc : require('./solar-calc.js'));
const SkyFireEngineModule = typeof window !== 'undefined' ? window.SkyFireEngine : (typeof global !== 'undefined' && global.SkyFireEngine ? global.SkyFireEngine : require('./skyfire-engine.js'));

class WeatherService {
  static DEFAULT_COORDS = { lat: 25.0330, lng: 121.5654, name: '台北市中心' };
  static CACHE_KEY_PREFIX = 'skyfire_weather_cache_';
  static CACHE_DURATION_MS = 15 * 60 * 1000; // 15 分鐘快取

  /**
   * 取得指定經緯度未來 7 天逐小時氣象預報與雲層高度數據
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
      // 串接 Open-Meteo 高精度大氣預報模型
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&hourly=cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,visibility,relativehumidity_2m,precipitation_probability,direct_normal_irradiance,temperature_2m,weathercode&daily=sunrise,sunset&timezone=auto&forecast_days=7`;

      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Open-Meteo API 請求失敗: HTTP ${response.status}`);
      }

      const data = await response.json();
      const parsed = this.processRawData(data, roundedLat, roundedLng, locationName);
      this.cacheForecast(cacheKey, parsed);
      return parsed;
    } catch (err) {
      console.warn('無法連線至 Open-Meteo API，切換為智慧離線物理模擬模型:', err.message);
      return this.generateSimulatedForecast(roundedLat, roundedLng, locationName);
    }
  }

  /**
   * 解析 Open-Meteo 原始數據並計算各時段火燒雲指數
   */
  static processRawData(raw, lat, lng, locationName) {
    const hourly = raw.hourly;
    const times = hourly.time;
    const count = times.length;
    const hourlyList = [];

    for (let i = 0; i < count; i++) {
      const timeStr = times[i];
      const dateObj = new Date(timeStr);

      hourlyList.push({
        time: dateObj,
        timeStr,
        cloudHigh: hourly.cloudcover_high ? hourly.cloudcover_high[i] : 0,
        cloudMid: hourly.cloudcover_mid ? hourly.cloudcover_mid[i] : 0,
        cloudLow: hourly.cloudcover_low ? hourly.cloudcover_low[i] : 0,
        cloudTotal: hourly.cloudcover ? hourly.cloudcover[i] : 0,
        visibility: hourly.visibility ? hourly.visibility[i] : 20000,
        humidity: hourly.relativehumidity_2m ? hourly.relativehumidity_2m[i] : 70,
        precipProb: hourly.precipitation_probability ? hourly.precipitation_probability[i] : 0,
        temp: hourly.temperature_2m ? hourly.temperature_2m[i] : 28,
        weatherCode: hourly.weathercode ? hourly.weathercode[i] : 0
      });
    }

    const now = new Date();
    const daysForecast = [];

    // 取未來 7 天
    for (let d = 0; d < 7; d++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const solarTimes = SolarCalcModule.getTimes(targetDate, lat, lng);

      // 提取日出時段與日落時段的最近氣象小時數據
      const sunriseHourData = this.getClosestHourData(hourlyList, solarTimes.sunrise);
      const sunsetHourData = this.getClosestHourData(hourlyList, solarTimes.sunset);

      // 運行 SkyFireEngine 計算
      const sunriseSkyfire = SkyFireEngineModule.calculate({
        highCloud: sunriseHourData.cloudHigh,
        midCloud: sunriseHourData.cloudMid,
        lowCloud: sunriseHourData.cloudLow,
        totalCloud: sunriseHourData.cloudTotal,
        visibility: sunriseHourData.visibility,
        humidity: sunriseHourData.humidity,
        precipProb: sunriseHourData.precipProb,
        type: 'sunrise',
        locationName
      });

      const sunsetSkyfire = SkyFireEngineModule.calculate({
        highCloud: sunsetHourData.cloudHigh,
        midCloud: sunsetHourData.cloudMid,
        lowCloud: sunsetHourData.cloudLow,
        totalCloud: sunsetHourData.cloudTotal,
        visibility: sunsetHourData.visibility,
        humidity: sunsetHourData.humidity,
        precipProb: sunsetHourData.precipProb,
        type: 'sunset',
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
          weather: sunriseHourData
        },
        sunset: {
          time: solarTimes.sunset,
          skyfire: sunsetSkyfire,
          weather: sunsetHourData
        }
      });
    }

    return {
      isSimulated: false,
      location: { lat, lng, name: locationName },
      lastUpdated: new Date(),
      hourly: hourlyList,
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
