/* 合成数据生成器（可复现：固定随机种子）
 * 生成四类原始记录：
 *   snapshots  车辆位置快照（含传感器漂移/卡死/断档/质量标记）
 *   orders     真实借还订单（仅成功的业务订单，估算订单永远不写入此表）
 *   attempts   借/还尝试流（含失败与改道，是演示“没订单≠没需求”的证据表）
 *   dispatches 调度记录（车辆数变化，不计入用户还车）
 *   history    历史同类时段小时汇总（供潜在需求估算）
 *   plans      两个备选调度方案（供方案对比） */
(function (global) {
  'use strict';
  var U = global.Util, SD = global.StationData;
  var DATES = U.DATES, FOCUS = U.FOCUS_DATE;

  /* ---------- 需求画像：每小时期望借/还量（6..22 点） ---------- */
  var PROFILES = {
    residential: {
      // 早高峰借车需求刻意拉高：在调度掏空后必然触发缺车
      rent:   [4, 12, 20, 15, 6, 3, 3, 4, 5, 7, 11, 10, 7, 5, 4, 3, 2],
      ret:    [1, 2, 3, 4, 3, 3, 4, 4, 4, 5, 7, 9, 8, 6, 5, 4, 3]
    },
    commercial: {
      rent:   [1, 2, 3, 4, 4, 5, 5, 4, 4, 4, 5, 5, 4, 5, 7, 6, 4],
      ret:    [2, 6, 9, 7, 5, 4, 3, 3, 4, 4, 5, 5, 5, 6, 8, 6, 4]
    },
    park: {
      rent:   [2, 3, 5, 6, 6, 6, 5, 5, 4, 4, 5, 6, 6, 5, 4, 3, 2],
      ret:    [1, 2, 3, 4, 4, 4, 3, 3, 3, 4, 4, 5, 5, 4, 3, 2, 2]
    },
    small: {
      rent:   [2, 4, 5, 3, 2, 2, 2, 2, 2, 3, 4, 4, 3, 2, 2, 1, 1],
      ret:    [1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4, 4, 3, 2, 2, 1]
    }
  };
  // 站点需求倍率（同类型站点也有差异）
  var DEMAND_SCALE = { ST01: 1.0, ST02: 0.95, ST03: 0.9, ST04: 0.55, ST05: 0.85 };
  var DAY_FACTOR = { '2026-11-09': 0.92, '2026-11-10': 0.88, '2026-11-11': 0.95, '2026-11-12': 1.0 };

  var rng = U.mulberry32(20261112);
  var seq = { order: 0, attempt: 0, dispatch: 0, snapshot: 0 };
  function nextId(prefix, key) { seq[key]++; return prefix + String(seq[key]).padStart(5, '0'); }

  /* ---------- 全局状态：单车位置台账（生成器内部真值） ---------- */
  var bikes = [];
  var stationBikes = {}; // sid -> bikeId[]
  var warehouseBikes = [];
  function initBikes() {
    SD.STATIONS.forEach(function (st) { stationBikes[st.id] = []; });
    var n = 0;
    SD.STATIONS.forEach(function (st) {
      for (var i = 0; i < st.initialBikes; i++) {
        var b = 'BK' + String(++n).padStart(4, '0');
        bikes.push({ id: b, where: st.id, rented: false });
        stationBikes[st.id].push(b);
      }
    });
    while (n < 130) {
      var w = 'BK' + String(++n).padStart(4, '0');
      bikes.push({ id: w, where: 'WH', rented: false });
      warehouseBikes.push(w);
    }
  }
  function inv(sid) { return stationBikes[sid] ? stationBikes[sid].length : 0; }

  /* ---------- 事件生成 ---------- */
  var orders = [], attempts = [], dispatches = [], snapshots = [], history = [];

  function pushAttempt(rec) {
    rec.id = nextId('AT', 'attempt');
    attempts.push(rec);
    return rec.id;
  }
  function doRent(sid, t, duration) {
    var atId;
    if (inv(sid) <= 0) {
      // 无车即失败：不消耗泊松随机数之外的状态，保证需求序列与有车时可比
      atId = pushAttempt({ time: t, stationId: sid, kind: 'rent', result: 'failed',
        reason: 'empty', orderId: null, note: '站点无可用车，借车需求流失' });
      return { ok: false, attemptId: atId };
    }
    var bike = stationBikes[sid].pop();
    var bikeState = bikes.filter(function (b) { return b.id === bike; })[0];
    bikeState.where = null; bikeState.rented = true;
    var orderId = nextId('OD', 'order');
    atId = pushAttempt({ time: t, stationId: sid, kind: 'rent', result: 'success',
      reason: null, orderId: orderId });
    orders.push({ orderId: orderId, type: 'rent', stationId: sid, time: t,
      bikeId: bike, pairedReturnId: null, attemptId: atId, source: 'user' });
    return { ok: true, orderId: orderId, bikeId: bike, duration: duration, attemptId: atId };
  }
  function doReturn(sid, t, bikeId, rentOrderId, originSid) {
    var cap = U.capacityAt(SD.STATIONS.filter(function (s) { return s.id === sid; })[0], U.dateOf(t));
    if (inv(sid) >= cap) {
      // 满桩：按邻接顺序改道
      var st = SD.STATIONS.filter(function (s) { return s.id === sid; })[0];
      var alt = null;
      for (var i = 0; i < st.neighbors.length; i++) {
        var nid = st.neighbors[i];
        var nst = SD.STATIONS.filter(function (x) { return x.id === nid; })[0];
        if (U.isActive(nst, U.dateOf(t)) && inv(nid) < U.capacityAt(nst, U.dateOf(t))) { alt = nid; break; }
      }
      var failId = pushAttempt({ time: t, stationId: sid, kind: 'return', result: 'failed',
        reason: 'full', orderId: null, redirectedTo: alt, bikeId: bikeId,
        note: alt ? '桩位已满，引导改道至 ' + alt : '桩位已满且邻站均满，还车失败' });
      if (!alt) return { ok: false, attemptId: failId };
      // 改道成功沿用原尝试时间戳：它是同一次还车事件的结果，而非 5 分钟后的新事件，
      // 这样库存变化与失败尝试落在同一时间点，引擎对账不会跨快照边界错位
      stationBikes[alt].push(bikeId);
      var bs = bikes.filter(function (b) { return b.id === bikeId; })[0];
      bs.where = alt; bs.rented = false;
      var retOrderId = nextId('OD', 'order');
      var at2 = pushAttempt({ time: t, stationId: alt, kind: 'return', result: 'success',
        reason: null, orderId: retOrderId, bikeId: bikeId, originStationId: originSid || sid,
        redirectedFrom: sid });
      orders.push({ orderId: retOrderId, type: 'return', stationId: alt, time: t,
        bikeId: bikeId, pairedRentId: rentOrderId, attemptId: at2, source: 'user',
        redirectedFrom: sid });
      return { ok: true, orderId: retOrderId, redirectedFrom: sid, attemptId: at2 };
    }
    stationBikes[sid].push(bikeId);
    var state = bikes.filter(function (b) { return b.id === bikeId; })[0];
    state.where = sid; state.rented = false;
    var oid = nextId('OD', 'order');
    var aid = pushAttempt({ time: t, stationId: sid, kind: 'return', result: 'success',
      reason: null, orderId: oid, bikeId: bikeId, originStationId: originSid || null });
    orders.push({ orderId: oid, type: 'return', stationId: sid, time: t,
      bikeId: bikeId, pairedRentId: rentOrderId, attemptId: aid, source: 'user' });
    return { ok: true, orderId: oid, attemptId: aid };
  }

  // 应用一条调度动作并写调度记录（不产生用户订单、不计入用户还车）
  // 双向容量约束：源站库存不足或目标站桩位不足时按可执行量调，差额如实记录
  function applyMove(mv) {
    var srcPool = mv.from === 'WH' ? warehouseBikes : stationBikes[mv.from];
    var targetCap = mv.to === 'WH' ? Infinity :
      U.capacityAt(SD.STATIONS.filter(function (s) { return s.id === mv.to; })[0], U.dateOf(mv.time));
    var room = mv.to === 'WH' ? Infinity : Math.max(0, targetCap - inv(mv.to));
    var canMove = Math.min(mv.qty, srcPool.length, room);
    // 源站保护：从站点调出时至少保留 0 辆（canMove 已受 srcPool.length 约束），
    // 仓库调出不受此限
    var moved = 0;
    for (var i = 0; i < canMove; i++) {
      var b = srcPool.pop();
      if (mv.to === 'WH') warehouseBikes.push(b); else stationBikes[mv.to].push(b);
      bikes.filter(function (x) { return x.id === b; })[0].where = mv.to;
      moved++;
    }
    var missing = mv.qty - moved;
    var reason = srcPool.length === 0 && mv.qty > moved ? '源端缺车' :
      (room < mv.qty ? '目标站桩位不足' : '源端库存不足');
    dispatches.push({
      id: nextId('DP', 'dispatch'), time: mv.time, from: mv.from, to: mv.to,
      plannedQty: mv.qty, actualQty: moved, missingQty: missing,
      note: mv.note + (missing ? '（' + reason + '，少调 ' + missing + ' 辆）' : ''),
      kind: mv.kind || 'routine'
    });
  }

  // 聚焦日（11-12）实际调度方案：刻意制造缺车/满桩
  var focusMoves = [
    { time: '05:50', from: 'ST01', to: 'WH', qty: 24, note: '凌晨回收（力度过大，掏空早高峰备用车）' },
    { time: '05:55', from: 'ST03', to: 'ST02', qty: 6, note: '向商圈早补车' },
    { time: '07:40', from: 'WH', to: 'ST05', qty: 8, note: '早高峰补车，未覆盖 ST01' },
    { time: '10:05', from: 'ST05', to: 'ST01', qty: 6, note: '平峰回补 ST01' },
    { time: '12:30', from: 'WH', to: 'ST03', qty: 6, note: '午后向公园大站投车（高峰仍可能短时满桩）' },
    { time: '15:10', from: 'ST02', to: 'ST03', qty: 2, note: '商圈向公园转运' }
  ];

  function buildDay(date) {
    var di = U.dateIndex(date);
    var factor = DAY_FACTOR[date];
    var pendingReturns = []; // {due, bikeId, sid, rentOrderId, originSid}
    var scheduledMoves = []; // 当日待触发调度 {time, from, to, qty, note, kind}

    // 关停并入：把 ST04 剩余车转入 ST03（生成一条 merge 调度，非用户还车）
    SD.MERGES.forEach(function (mg) {
      if (mg.effectiveDate === date) {
        scheduledMoves.push({
          time: U.absMinute(date, mg.time), from: mg.from, to: mg.to,
          qty: inv(mg.from), note: mg.note + '，车辆整体划转', kind: 'merge'
        });
      }
    });

    // 常规小调度（非聚焦日也有，保持数据真实感）
    if (date !== FOCUS) {
      scheduledMoves.push({ time: U.absMinute(date, '06:20'), from: 'WH', to: 'ST05', qty: 4, note: '早高峰前补车', kind: 'routine' });
      scheduledMoves.push({ time: U.absMinute(date, '09:30'), from: 'ST05', to: 'ST02', qty: 3, note: '商圈午间补车', kind: 'routine' });
      scheduledMoves.push({ time: U.absMinute(date, '21:00'), from: 'ST02', to: 'WH', qty: 3, note: '夜间回收', kind: 'routine' });
    }
    // 聚焦日实际调度方案
    if (date === FOCUS) {
      focusMoves.forEach(function (m) {
        scheduledMoves.push({ time: U.absMinute(date, m.time), from: m.from, to: m.to,
          qty: m.qty, note: m.note, kind: 'routine' });
      });
    }
    // 次日容量收缩：当晚 23:30 撤出多余车
    var nextDate = DATES[di + 1];
    if (nextDate) {
      SD.STATIONS.forEach(function (st) {
        if (!U.isActive(st, nextDate)) return;
        var nextCap = U.capacityAt(st, nextDate);
        if (inv(st.id) > nextCap) {
          scheduledMoves.push({
            time: di * U.DAY_MINUTES + 1410, from: st.id, to: 'WH',
            qty: inv(st.id) - nextCap,
            note: '次日桩位调整，夜间提前撤出（容量 ' + inv(st.id) + '→' + nextCap + '）',
            kind: 'capacity-adjust'
          });
        }
      });
    }
    scheduledMoves.sort(function (a, b) { return a.time - b.time; });

    // 逐分钟循环。循环从午夜起算，保证凌晨调度（如 05:50 回收）在运营窗口
    // 开始前就真实落账；需求生成与快照仍只在运营窗口 [06:00, 23:00) 内执行。
    // 严格时序：整点快照（区间起点） -> 还车（到期+即时） -> 调度 -> 借车
    for (var local = 0; local < U.WINDOW_END; local++) {
      var t = di * U.DAY_MINUTES + local;
      var inWindow = local >= U.WINDOW_START;
      var h = Math.floor(local / 60), hi = h - 6;

      // 0) 15 分钟整点快照：仅运营窗口内落，读取上一区间结束后的库存
      if (inWindow && local % 15 === 0) takeSnapshot(date, local);

      // 窗口外只触发调度，不生成需求
      if (!inWindow) {
        while (scheduledMoves.length && scheduledMoves[0].time <= t) {
          applyMove(scheduledMoves.shift());
        }
        continue;
      }

      // 1) 还车：先处理到期还车
      for (var pr = pendingReturns.length - 1; pr >= 0; pr--) {
        if (pendingReturns[pr].due <= t) {
          var p = pendingReturns.splice(pr, 1)[0];
          doReturn(p.sid, t, p.bikeId, p.rentOrderId, p.originSid);
        }
      }
      // 1b) 还车：各站按画像产生的即时还车（只提前在途单，不删除计划单）
      SD.STATIONS.forEach(function (st) {
        if (!U.isActive(st, date)) return;
        var nRet = U.poisson(rng, PROFILES[st.type].ret[hi] * DEMAND_SCALE[st.id] * factor / 60);
        for (var k2 = 0; k2 < nRet; k2++) {
          if (!pendingReturns.length) break;
          pendingReturns.sort(function (a, b) { return a.due - b.due; });
          var early = pendingReturns.shift();
          doReturn(st.id, t, early.bikeId, early.rentOrderId, early.originSid);
        }
      });

      // 2) 调度（在借车与快照之前，库存变化先落账）
      while (scheduledMoves.length && scheduledMoves[0].time <= t) {
        applyMove(scheduledMoves.shift());
      }

      // 3) 借车
      SD.STATIONS.forEach(function (st) {
        if (!U.isActive(st, date)) return;
        var prof = PROFILES[st.type];
        var scale = DEMAND_SCALE[st.id] * factor;
        var nRent = U.poisson(rng, prof.rent[hi] * scale / 60);
        for (var k = 0; k < nRent; k++) {
          var dur = Math.round(12 + rng() * 83); // 12~95 分钟
          var r = doRent(st.id, t, dur);
          if (r.ok) {
            pendingReturns.push({
              due: Math.min(t + r.duration, di * U.DAY_MINUTES + U.WINDOW_END - 30),
              bikeId: r.bikeId, sid: st.id, rentOrderId: r.orderId, originSid: st.id
            });
          }
        }
      });
    }

    // 收尾：仍在途的车 23:30 强制还回原借车站（演示数据不留悬空车）
    var endT = di * U.DAY_MINUTES + U.WINDOW_END + 30;
    pendingReturns.slice().forEach(function (p) {
      doReturn(p.sid, endT, p.bikeId, p.rentOrderId, p.originSid);
    });
  }

  /* ---------- 快照（在事件流中实时落账；仅刻意注入漂移/卡死/断档） ---------- */
  var GAP = { start: '09:30', end: '11:00' }; // 聚焦日全局数据断档
  function takeSnapshot(date, local) {
    var di = U.dateIndex(date);
    var t = di * U.DAY_MINUTES + local;
    if (date === FOCUS && local >= 570 && local < 660) return; // 09:30–11:00 全局断档
    SD.STATIONS.forEach(function (st) {
      if (!U.isActive(st, date)) return;
      // 读数直接取自当前单车台账，与订单/调度同源，正常时必然对得上
      var trueCount = inv(st.id);
      var rec = {
        id: nextId('SN', 'snapshot'), time: t, stationId: st.id,
        reportedBikes: trueCount, trueBikes: trueCount, quality: 'ok', note: null
      };
      if (date === FOCUS && st.id === 'ST01' && local === 495) { // 08:15 少报 2
        rec.reportedBikes = U.clamp(trueCount - 2, 0, U.capacityAt(st, date));
        rec.quality = 'drift'; rec.note = '传感器漂移，较台账少报 2 辆';
      }
      if (date === FOCUS && st.id === 'ST05' && local === 1080) { // 18:00 多报 2
        rec.reportedBikes = U.clamp(trueCount + 2, 0, U.capacityAt(st, date));
        rec.quality = 'drift'; rec.note = '传感器漂移，较台账多报 2 辆';
      }
      if (date === FOCUS && st.id === 'ST02' && (local === 855 || local === 870)) { // 14:15/14:30 卡死
        var prevT = t - (local === 855 ? 15 : 30);
        var prev = snapshots.filter(function (s) {
          return s.stationId === 'ST02' && s.time === prevT;
        })[0];
        if (prev) {
          rec.reportedBikes = prev.reportedBikes;
          rec.quality = 'stale';
          rec.note = '传感器卡死，读数与 ' + U.hm(prevT) + ' 相同（真实台账 ' + trueCount + ' 辆）';
        }
      }
      snapshots.push(rec);
    });
  }

  /* ---------- 历史小时汇总（4 个同星期历史周，供估算） ---------- */
  function buildHistory() {
    var focusDow = new Date(2026, 10, 12).getDay(); // 11-12 周四
    var weeks = ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05']; // 均为周四
    SD.STATIONS.forEach(function (st) {
      weeks.forEach(function (wk, wi) {
        for (var h = 6; h <= 22; h++) {
          var prof = PROFILES[st.type], hi = h - 6;
          var scale = DEMAND_SCALE[st.id] * (0.9 + rng() * 0.2);
          var rent = U.poisson(rng, prof.rent[hi] * scale);
          var ret = U.poisson(rng, prof.ret[hi] * scale);
          // 部分历史小时受缺车约束，必须标记，估算时剔除
          var constrained = rng() < 0.08;
          history.push({
            stationId: st.id, weekStart: wk, hour: h, weekday: focusDow,
            observedRentals: constrained ? Math.max(0, rent - 2 - Math.floor(rng() * 2)) : rent,
            observedReturns: ret,
            stockoutConstrained: constrained,
            note: constrained ? '该历史小时发生缺车，观测值低估真实需求，估算时剔除' : null
          });
        }
      });
    });
  }

  /* ---------- 备选调度方案（聚焦日，供方案对比） ---------- */
  function buildPlans() {
    var plans = {
      A: {
        id: 'A', name: '方案A：实际基线调度',
        description: '还原 11-12 当日实际执行的 6 条调度，早高峰前从 ST01 过量回收。',
        moves: dispatches.filter(function (d) {
          return U.dateOf(d.time) === FOCUS && d.kind !== 'merge';
        }).map(function (d) {
          return { time: U.hm(d.time), from: d.from, to: d.to, qty: d.plannedQty, note: d.note };
        })
      },
      B: {
        id: 'B', name: '方案B：早高峰保供',
        description: '取消对 ST01 的凌晨回收，改为仓库直投 ST01，并提前向 ST05 补车。',
        moves: [
          { time: '05:50', from: 'WH', to: 'ST01', qty: 14, note: '仓库直补地铁东门，保早高峰' },
          { time: '05:55', from: 'ST03', to: 'ST02', qty: 6, note: '向商圈早补车（不变）' },
          { time: '07:00', from: 'WH', to: 'ST05', qty: 8, note: '提前 40 分钟补滨河社区' },
          { time: '10:05', from: 'ST05', to: 'ST01', qty: 3, note: '平峰小幅回补' },
          { time: '12:30', from: 'WH', to: 'ST03', qty: 6, note: '午后公园投车（不变）' },
          { time: '15:10', from: 'ST02', to: 'ST03', qty: 2, note: '商圈向公园转运（不变）' }
        ]
      },
      C: {
        id: 'C', name: '方案C：午间均衡再平衡',
        description: '维持实际早班调度，新增 09:00 与 13:30 两轮再平衡，缓解 ST01 缺车与 ST03 满桩。',
        moves: [
          { time: '05:50', from: 'ST01', to: 'WH', qty: 24, note: '凌晨回收（同实际）' },
          { time: '05:55', from: 'ST03', to: 'ST02', qty: 6, note: '向商圈早补车（同实际）' },
          { time: '07:40', from: 'WH', to: 'ST05', qty: 8, note: '早高峰补车（同实际）' },
          { time: '09:00', from: 'WH', to: 'ST01', qty: 12, note: '新增：早高峰前紧急回补 ST01' },
          { time: '10:05', from: 'ST05', to: 'ST01', qty: 6, note: '平峰回补（同实际）' },
          { time: '12:30', from: 'WH', to: 'ST03', qty: 4, note: '公园投车减量，防满桩' },
          { time: '13:30', from: 'ST03', to: 'ST01', qty: 5, note: '新增：公园富余车回流地铁东门' },
          { time: '15:10', from: 'ST02', to: 'ST03', qty: 2, note: '商圈向公园转运（同实际）' }
        ]
      }
    };
    return plans;
  }

  /* ---------- 主流程 ---------- */
  initBikes();
  DATES.forEach(buildDay);
  buildHistory();
  var plans = buildPlans();

  // 排序，保证原始记录按时间可追溯
  function byTime(a, b) { return a.time - b.time || (a.id < b.id ? -1 : 1); }
  orders.sort(byTime); attempts.sort(byTime); dispatches.sort(byTime); snapshots.sort(byTime);

  global.SyntheticData = {
    meta: {
      generatedAt: '2026-11-12 23:59', seed: 20261112,
      dates: DATES.slice(), focusDate: FOCUS,
      gap: { start: U.absMinute(FOCUS, GAP.start), end: U.absMinute(FOCUS, GAP.end) },
      assumptions: [
        '全部数据为合成数据，单车台账是生成器内部真值，快照读数可能偏离真值。',
        '借车尝试在无车时记为 failed/empty；没有订单的时段不等于没有需求。',
        '还车满桩时按邻接站点顺序改道，邻站均满则还车失败。',
        '调度（含站点合并划转）只改变车辆位置，不产生用户订单，不计入用户还车。',
        '历史小时汇总中 stockoutConstrained=true 的样本受缺车约束，估算时剔除。',
        'ST04 于 11-10 关停并入 ST03；ST02 于 11-11 容量由 25 降为 20。'
      ]
    },
    stations: SD.STATIONS, merges: SD.MERGES,
    snapshots: snapshots, orders: orders, attempts: attempts,
    dispatches: dispatches, history: history, plans: plans
  };
})(typeof window !== 'undefined' ? window : globalThis);
