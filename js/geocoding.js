/**
 * GeocodingService - 經緯度與地名雙向轉換服務 (Reverse Geocoding)
 * 使用免費且精確的 OpenStreetMap Nominatim 與 BigDataCloud 逆地理編碼 API
 */

class GeocodingService {
  static CACHE_KEY = 'skyfire_geo_cache';
  static memoryCache = new Map();

  /**
   * 根據經緯度取得易讀的行政區或景點地名
   * @param {number} lat 緯度
   * @param {number} lng 經度
   * @returns {Promise<string>} 例如：「台中市清水區」或「嘉義縣阿里山鄉」
   */
  static async reverseGeocode(lat, lng) {
    const roundedLat = parseFloat(lat.toFixed(3));
    const roundedLng = parseFloat(lng.toFixed(3));
    const cacheKey = `${roundedLat},${roundedLng}`;

    if (this.memoryCache.has(cacheKey)) {
      return this.memoryCache.get(cacheKey);
    }

    // 1. 嘗試由 BigDataCloud 免費 Client API 獲取（速度極快且支援多語言）
    try {
      const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=zh`;
      const res = await fetch(bdcUrl);
      if (res.ok) {
        const data = await res.json();
        let name = '';
        
        if (data.countryCode === 'TW') {
          // 台灣地區格式化：例如 台中市 清水區
          const admin = data.principalSubdivision || '';
          const locality = data.locality || data.city || '';
          name = `${admin} ${locality}`.trim();
        } else {
          // 海外地區：例如 日本 東京都 / 美國 加州
          const country = data.countryName || '';
          const city = data.city || data.principalSubdivision || '';
          name = `${country} ${city}`.trim();
        }

        if (name && name.length > 1) {
          this.memoryCache.set(cacheKey, name);
          return name;
        }
      }
    } catch (err) {
      console.warn('BigDataCloud 逆地理編碼未回應，嘗試備援方案...');
    }

    // 2. 備援方案：OpenStreetMap Nominatim
    try {
      const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=zh-TW`;
      const res = await fetch(osmUrl, {
        headers: { 'User-Agent': 'SkyFireGPS/1.0' }
      });
      if (res.ok) {
        const data = await res.json();
        const addr = data.address || {};
        let name = addr.county || addr.city || addr.state || '';
        if (addr.town || addr.suburb || addr.district) {
          name += ` ${addr.town || addr.suburb || addr.district}`;
        }
        if (name) {
          this.memoryCache.set(cacheKey, name.trim());
          return name.trim();
        }
      }
    } catch (err) {
      console.warn('Nominatim 逆地理編碼失敗:', err);
    }

    // 3. 若皆失敗，回傳格式化經緯度
    const coordStr = `${lat > 0 ? 'N' : 'S'}${Math.abs(lat).toFixed(2)}°, ${lng > 0 ? 'E' : 'W'}${Math.abs(lng).toFixed(2)}°`;
    return `自選座標 (${coordStr})`;
  }
}

if (typeof window !== 'undefined') {
  window.GeocodingService = GeocodingService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeocodingService;
}
