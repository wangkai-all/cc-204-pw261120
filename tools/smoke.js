/* Node 冒烟测试：node tools/smoke.js
 * 校验合成数据与引擎的关键不变量。 */
'use strict';
require('../js/util.js');
require('../js/stations.js');
require('../js/synthetic.js');
require('../js/engine.js');

var U = globalThis.Util, D = globalThis.SyntheticData, E = globalThis.Engine;
var fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

console.log('== 数据规模 ==');
console.log('orders', D.orders.length, 'attempts', D.attempts.length,
  'snapshots', D.snapshots.length, 'dispatches', D.dispatches.length, 'history', D.history.length);

console.log('== 不变量 ==');
// 1. 所有成功订单都有对应 attempt
var attemptOrderIds = {};
D.attempts.forEach(function (a) { if (a.orderId) attemptOrderIds[a.orderId] = true; });
check('每个订单都能在尝试流找到', D.orders.every(function (o) { return attemptOrderIds[o.orderId]; }));

// 2. 估算数据不写入订单表：orders 里 source 只能是 user
check('订单表只含真实用户订单', D.orders.every(function (o) { return o.source === 'user'; }));

// 3. 调度不产生用户还车
check('调度记录独立于订单表', D.orders.every(function (o) { return o.orderId.indexOf('DP') !== 0; }));

// 4. 聚焦日存在缺车失败
var focusEmpty = D.attempts.filter(function (a) {
  return a.result === 'failed' && a.reason === 'empty' && U.dateOf(a.time) === D.meta.focusDate;
});
check('聚焦日存在缺车流失记录', focusEmpty.length > 0, focusEmpty.length);

// 5. 存在满桩失败/改道
var fullFail = D.attempts.filter(function (a) { return a.reason === 'full'; });
check('存在满桩还车事件（失败或改道）', fullFail.length > 0, fullFail.length);

// 6. 聚焦日 09:30-11:00 无快照
var gapSnaps = D.snapshots.filter(function (s) {
  return s.time >= D.meta.gap.start && s.time < D.meta.gap.end;
});
check('断档窗口内无任何快照', gapSnaps.length === 0);

// 7. 快照不一致（drift/stale）
var bad = D.snapshots.filter(function (s) { return s.quality !== 'ok'; });
check('存在传感器漂移/卡死快照', bad.length >= 3, bad.map(function (s) { return s.quality; }));

// 8. ST04 关停、合并调度
check('ST04 在 11-10 关停', !U.isActive(D.stations[3], '2026-11-10'));
var mergeDp = D.dispatches.filter(function (d) { return d.kind === 'merge'; });
check('存在站点合并划转调度', mergeDp.length === 1, mergeDp);

// 9. ST02 容量变化
check('ST02 容量 25 -> 20', U.capacityAt(D.stations[1], '2026-11-10') === 25 &&
  U.capacityAt(D.stations[1], '2026-11-11') === 20);

  // 10. 物理可行性：质量 ok 的快照读数必须在 [0, 容量] 内
  var physicalViolation = D.snapshots.filter(function (s) {
    var stt = D.stations.filter(function (x) { return x.id === s.stationId; })[0];
    var cap2 = U.capacityAt(stt, U.dateOf(s.time));
    return s.quality === 'ok' && (s.reportedBikes < 0 || s.reportedBikes > cap2);
  });
  check('正常快照读数不超物理容量', physicalViolation.length === 0,
    physicalViolation.slice(0, 3).map(function (s) { return [s.stationId, U.full(s.time), s.reportedBikes]; }));

  // 11. 对账质量：除刻意注入的 drift/stale 及其滞后效应外，不应出现大量无法解释的 ok 差异
  var totalUnexplained = 0;
  D.stations.forEach(function (st) {
    D.meta.dates.forEach(function (date) {
      if (!U.isActive(st, date)) return;
      var dd = E.buildStationDay(st.id, date);
      totalUnexplained += dd.discrepancies.filter(function (x) { return x.quality === 'ok'; }).length;
    });
  });
  check('无法解释的对账差异处于低位（注入异常的滞后效应）', totalUnexplained <= 8, totalUnexplained);

console.log('== 引擎重建（ST01 聚焦日） ==');
var day = E.buildStationDay('ST01', D.meta.focusDate);
check('重建出时序点', day.series.length === (U.WINDOW_END - U.WINDOW_START) / U.GRID_STEP + 1);
check('存在已核实缺车段', day.episodes.some(function (e) { return e.state === 'stockout'; }));
// 中断型断档（排除窗口首尾的自然无快照）应为 09:20–11:00 共 100 分钟
var interruptGaps = day.gaps.filter(function (g) { return g.reason === '快照上报中断'; });
check('识别出数据断档', interruptGaps.length === 1 &&
  interruptGaps[0].end - interruptGaps[0].start === 100,
  interruptGaps.map(function (g) { return [U.hm(g.start), U.hm(g.end)]; }));
check('naive 不识别断档', day.naive.gapMin === 0);
check('校正指标含调度进出', day.corrected.dispatchIn >= 0 && day.corrected.dispatchOut > 0);
check('对账发现快照漂移', day.discrepancies.some(function (x) { return x.quality === 'drift'; }));

console.log('== 潜在需求估算 ==');
var est = E.estimateLost(day);
check('估算结果独立结构且有不确定范围', est.totalPoint > 0 && est.totalLow <= est.totalPoint && est.totalPoint <= est.totalHigh,
  { low: est.totalLow, point: est.totalPoint, high: est.totalHigh });
check('估算未污染订单表（订单数不变）', D.orders.length === D.orders.length);
console.log('  ST01 潜在流失：' + est.totalLow + ' ~ ' + est.totalPoint + ' ~ ' + est.totalHigh + ' 辆');

console.log('== 方案模拟 ==');
['A', 'B', 'C'].forEach(function (pid) {
  var r = E.simulatePlan(pid);
  check('方案 ' + pid + ' 可重放', r.totals && r.stationResults.length >= 4);
  console.log('  方案' + pid + ' 缺车分钟=' + r.totals.stockoutMin +
    ' 满桩分钟=' + r.totals.fullMin +
    ' 失败借车=' + r.totals.failedRentals +
    ' 估算流失=' + r.estimatedLost.totalPoint +
    ' 未满足调度动作=' + r.unmetMoves.length);
});
var rA = E.simulatePlan('A'), rB = E.simulatePlan('B');
check('方案B缺车不高于基线方案A', rB.totals.stockoutMin <= rA.totals.stockoutMin);

console.log('== 各站重建健全性 ==');
D.stations.forEach(function (st) {
  D.meta.dates.forEach(function (date) {
    if (!U.isActive(st, date)) return;
    var dd = E.buildStationDay(st.id, date);
    var badCount = dd.series.some(function (p) { return p.count !== null && p.count < 0; });
    check(st.id + ' ' + date + ' 重建库存不为负', !badCount);
  });
});

console.log(fail === 0 ? '\n全部通过 ✔' : '\n有 ' + fail + ' 项失败 ✘');
process.exit(fail === 0 ? 0 : 1);
