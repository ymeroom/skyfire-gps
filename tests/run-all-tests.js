/**
 * run-all-tests.js - 執行 SkyFire GPS 全套專業自動化測試
 */

console.log('====================================================');
console.log('🚀 開始執行 SkyFire GPS 專業全功能自動化測試套件');
console.log('====================================================\n');

try {
  require('./test-solar-calc.js');
  require('./test-skyfire-engine.js');
  require('./test-weather-service.js');
  require('./test-spots-data.js');
  require('./test-dom-bindings.js');

  console.log('====================================================');
  console.log('🏆 恭喜！所有 5 大核心模組與 DOM 測試案例 100% 通過！');
  console.log('====================================================');
} catch (err) {
  console.error('\n❌ 測試未通過，錯誤詳情:', err.message);
  process.exit(1);
}
