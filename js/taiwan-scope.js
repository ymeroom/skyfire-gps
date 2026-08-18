/**
 * TaiwanScope - SkyFire GPS 台灣限定服務範圍
 * 涵蓋台灣本島、澎湖、馬祖、蘭嶼、綠島與金門。
 */
class TaiwanScope {
  static MAIN_ISLAND_POLYGON = [
    [25.30, 121.54],
    [25.15, 121.92],
    [24.62, 121.92],
    [24.40, 121.90],
    [24.12, 121.78],
    [23.45, 121.50],
    [23.00, 121.45],
    [22.40, 121.00],
    [22.00, 120.90],
    [21.88, 120.90],
    [21.82, 120.75],
    [22.10, 120.55],
    [22.55, 120.20],
    [23.05, 120.00],
    [23.25, 120.05],
    [23.60, 120.10],
    [24.15, 120.30],
    [24.65, 120.60],
    [25.05, 121.00]
  ];

  static ISLAND_GROUPS = [
    { name: '澎湖', lat: 23.57, lng: 119.58, radiusKm: 45 },
    { name: '金門', lat: 24.45, lng: 118.38, radiusKm: 19 },
    { name: '馬祖南竿', lat: 26.16, lng: 119.95, radiusKm: 25 },
    { name: '馬祖東引', lat: 26.37, lng: 120.49, radiusKm: 15 },
    { name: '馬祖東莒', lat: 25.96, lng: 119.97, radiusKm: 15 },
    { name: '烏坵', lat: 24.99, lng: 119.45, radiusKm: 12 },
    { name: '綠島', lat: 22.67, lng: 121.49, radiusKm: 12 },
    { name: '蘭嶼', lat: 22.05, lng: 121.55, radiusKm: 18 }
  ];

  static MAP_BOUNDS = [
    [21.3, 117.8],
    [26.7, 122.7]
  ];

  static contains(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

    return this.pointInPolygon(lat, lng, this.MAIN_ISLAND_POLYGON) ||
      this.ISLAND_GROUPS.some(island => (
        this.distanceKm(lat, lng, island.lat, island.lng) <= island.radiusKm
      ));
  }

  static pointInPolygon(lat, lng, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [latI, lngI] = polygon[i];
      const [latJ, lngJ] = polygon[j];
      const crossesLatitude = (latI > lat) !== (latJ > lat);
      const intersectionLng = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
      if (crossesLatitude && lng < intersectionLng) inside = !inside;
    }
    return inside;
  }

  static distanceKm(lat1, lng1, lat2, lng2) {
    const toRadians = degrees => degrees * Math.PI / 180;
    const earthRadiusKm = 6371;
    const deltaLat = toRadians(lat2 - lat1);
    const deltaLng = toRadians(lng2 - lng1);
    const a = Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
      Math.sin(deltaLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  static formatGpsLocation(lat, lng) {
    if (!this.contains(lat, lng)) return null;
    return `GPS: ${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E`;
  }
}

if (typeof window !== 'undefined') {
  window.TaiwanScope = TaiwanScope;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaiwanScope;
}
