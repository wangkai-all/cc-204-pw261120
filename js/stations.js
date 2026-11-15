/* 站点主数据：含容量/关停/合并的版本化记录（按生效时间生效）
 * 注意：所有变更只在 synthetic.js 生成的原始记录里也会留下痕迹，
 * 引擎不直接信任快照，而是用版本表解释快照变化。 */
(function (global) {
  'use strict';

  var STATIONS = [
    {
      id: 'ST01', name: '地铁东门站', type: 'residential',
      neighbors: ['ST05', 'ST02'],
      initialBikes: 14,
      versions: [
        { effectiveDate: '2026-11-09', capacity: 30, active: true, note: '开站，容量 30 桩' }
      ]
    },
    {
      id: 'ST02', name: '科技园南站', type: 'commercial',
      neighbors: ['ST01', 'ST03'],
      initialBikes: 12,
      versions: [
        { effectiveDate: '2026-11-09', capacity: 25, active: true, note: '开站，容量 25 桩' },
        { effectiveDate: '2026-11-11', capacity: 20, active: true, note: '施工拆除 5 桩，容量调整为 20（02:00 生效）' }
      ]
    },
    {
      id: 'ST03', name: '中央公园站', type: 'park',
      neighbors: ['ST02', 'ST01', 'ST05'],
      initialBikes: 20,
      versions: [
        { effectiveDate: '2026-11-09', capacity: 40, active: true, note: '开站，容量 40 桩' },
        { effectiveDate: '2026-11-10', capacity: 60, active: true, note: '并入 ST04 公园西街，扩容至 60 桩（02:00 生效）' }
      ]
    },
    {
      id: 'ST04', name: '公园西街站', type: 'small',
      neighbors: ['ST03'],
      initialBikes: 4,
      versions: [
        { effectiveDate: '2026-11-09', capacity: 12, active: true, note: '开站，容量 12 桩' },
        { effectiveDate: '2026-11-10', capacity: 0, active: false, note: '站点关停并并入 ST03（02:00 起）' }
      ]
    },
    {
      id: 'ST05', name: '滨河社区站', type: 'residential',
      neighbors: ['ST01', 'ST03'],
      initialBikes: 16,
      versions: [
        { effectiveDate: '2026-11-09', capacity: 35, active: true, note: '开站，容量 35 桩' }
      ]
    }
  ];

  // 站点合并事件：from 在 effectiveDate time 关停，剩余车辆作为调度转入 to
  var MERGES = [
    { from: 'ST04', to: 'ST03', effectiveDate: '2026-11-10', time: '02:00', note: 'ST04 关停并入 ST03' }
  ];

  global.StationData = { STATIONS: STATIONS, MERGES: MERGES };
})(typeof window !== 'undefined' ? window : globalThis);
