const WeatherService = require('../js/weather-service.js');
const SolarCalc = require('../js/solar-calc.js');

async function checkWeek() {
  const regions = [
    { name: '台北 (象山/大稻埕/淡水)', lat: 25.0330, lng: 121.5654 },
    { name: '台中 (高美濕地/望高寮)', lat: 24.3120, lng: 120.5500 },
    { name: '嘉義/南投 (阿里山/日月潭)', lat: 23.5139, lng: 120.8143 },
    { name: '台南/高雄 (二寮/西子灣)', lat: 22.9997, lng: 120.2270 },
    { name: '台東/花蓮 (三仙台/七星潭)', lat: 23.1238, lng: 121.4055 }
  ];

  for (const r of regions) {
    console.log('====================================================');
    console.log('📍 地區: ' + r.name);
    console.log('====================================================');
    const forecast = await WeatherService.fetchForecast({ lat: r.lat, lng: r.lng, locationName: r.name, forceRefresh: true });
    
    forecast.daysForecast.forEach((d, idx) => {
      const dateStr = d.dateDisplay || d.date;
      const sr = d.sunrise.skyfire;
      const ss = d.sunset.skyfire;
      const srW = d.sunrise.weather;
      const ssW = d.sunset.weather;
      console.log(`📅 ${dateStr} (${d.date}):`);
      console.log(`   🌅 日出: ${sr.score}分 [${sr.rating.badge}] (高${srW.cloudHigh}% 中${srW.cloudMid}% 低${srW.cloudLow}% 透光${sr.metrics.horizonClearance}%)`);
      console.log(`   🌇 日落: ${ss.score}分 [${ss.rating.badge}] (高${ssW.cloudHigh}% 中${ssW.cloudMid}% 低${ssW.cloudLow}% 透光${ss.metrics.horizonClearance}%)`);
    });
    console.log('\n');
  }
}

checkWeek();
