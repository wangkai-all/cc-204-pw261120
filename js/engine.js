/* 分析引擎：
 *  1) buildStationDay  以快照为锚点、用订单+调度重建可用车辆变化，并对账快照不一致
 *  2) 区分“缺车（已核实）/缺车（断档内，存疑）/数据断档/满桩”
 *  3) 校正前后两套指标（naive 只信快照；corrected 融合事件对账）
 *  4) estimateLost  基于历史同类时段的潜在需求估算，估算结果独立存放、绝不写回订单表
 *  5) simulatePlan  按同一套事件流重放调度方案，输出可对比的缺口变化
 */
(function (global) {
  'use strict';
  var U = global.Util, D = global.SyntheticData;
  var GAP_LIMIT = 20; // 相邻快照间隔 > 20 分钟即判为数据断档

  function stationById(id) {
    return D.stations.filter(function (s) { return s.id === id; })[0];
  }
  function capAt(sid, date) { return U.capacityAt(stationById(sid), date); }

  /* ============ 1. 单站单日重建 ============ */
  function buildStationDay(stationId, date) {
    var st = stationById(stationId);
    var di = U.dateIndex(date);
    var dayStart = di * U.DAY_MINUTES, dayEnd = dayStart + U.DAY_MINUTES;
    var winStart = dayStart + U.WINDOW_START, winEnd = dayStart + U.WINDOW_END;
    var active = U.isActive(st, date);
    var cap = active ? U.capacityAt(st, date) : 0;

    // 快照只在分析窗口内；但事件取全天——凌晨/夜间调度（如 05:50 补车、23:30 撤车）
    // 必须纳入对账，否则首快照锚点无法解释
    var snaps = D.snapshots.filter(function (s) {
      return s.stationId === stationId && s.time >= winStart && s.time <= winEnd;
    });
    var userEvents = D.orders.filter(function (o) {
      return o.stationId === stationId && o.time >= dayStart && o.time < dayEnd;
    }).map(function (o) {
      return { time: o.time, kind: o.type === 'rent' ? 'rent' : 'return',
        orderId: o.orderId, bikeId: o.bikeId, source: 'user',
        redirectedFrom: o.redirectedFrom || null };
    });
    var dispatchEvents = D.dispatches.filter(function (dp) {
      return (dp.from === stationId || dp.to === stationId) && dp.time >= dayStart && dp.time < dayEnd;
    }).map(function (dp) {
      return { time: dp.time, kind: 'dispatch', delta: (dp.to === stationId ? dp.actualQty : -dp.actualQty),
        dispatchId: dp.id, from: dp.from, to: dp.to, dispatchKind: dp.kind };
    });
    var stationAttempts = D.attempts.filter(function (a) {
      return a.stationId === stationId && a.time >= winStart && a.time <= winEnd;
    });

    // 事件合并按时间排序（同一分钟：还车 -> 调度 -> 借车，库存先增后减更安全）
    var rank = { return: 0, dispatch: 1, rent: 2 };
    var events = userEvents.concat(dispatchEvents).sort(function (a, b) {
      return a.time - b.time || rank[a.kind] - rank[b.kind];
    });

    /* ---- 对账重建：以当日首快照为锚点，重放窗口内事件，逐快照校验/纠偏 ----
     * 窗口外（00:00–06:00、23:00–24:00）的凌晨/夜间调度保留在事件清单里可追溯，
     * 其库存影响已包含在首快照读数中，不在窗口内重复推演。 */
    var discrepancies = [];
    var anchorTime = null, snapIdx = -1, predicted = 0;
    if (snaps.length) {
      predicted = snaps[0].reportedBikes; anchorTime = snaps[0].time; snapIdx = 0;
    }
    var trace = [{ time: anchorTime !== null ? anchorTime : winStart,
      count: predicted, kind: 'anchor',
      quality: anchorTime !== null ? snaps[0].quality : 'ok' }];

    events.forEach(function (ev) {
      if (ev.time < winStart || ev.time > winEnd) return;   // 窗口外事件不推演
      if (anchorTime !== null && ev.time < anchorTime) return; // 锚点前事件已含在首快照
      // 整点分钟的快照代表该区间的起点状态，同一分钟的业务事件发生在快照之后，
      // 因此先吸收“时间 <= 事件时刻”的快照再推演事件
      while (snapIdx + 1 < snaps.length && snaps[snapIdx + 1].time <= ev.time) {
        snapIdx++;
        var snap = snaps[snapIdx];
        if (predicted !== snap.reportedBikes) {
          discrepancies.push({
            time: snap.time, predicted: predicted, reported: snap.reportedBikes,
            delta: snap.reportedBikes - predicted, quality: snap.quality, note: snap.note
          });
          predicted = snap.reportedBikes; // 纠偏：以最新快照读数为准
        }
        trace.push({ time: snap.time, count: predicted, kind: 'snapshot', quality: snap.quality });
      }
      if (ev.kind === 'rent') predicted -= 1;
      else if (ev.kind === 'return') predicted += 1;
      else predicted += ev.delta;
      // 容量收缩过渡库存可能暂时超过新容量：不硬钳制，记差异，分段标为满桩
      if (predicted < 0) predicted = 0;
      if (predicted > cap) {
        discrepancies.push({
          time: ev.time, predicted: predicted, reported: null,
          delta: null, quality: 'overflow',
          note: '重建库存 ' + predicted + ' 辆超过当前容量 ' + cap + ' 辆（容量收缩过渡/数据不一致）'
        });
      }
      trace.push({ time: ev.time, count: predicted, kind: ev.kind, ref: ev.orderId || ev.dispatchId,
        dispatchKind: ev.dispatchKind || null, redirectedFrom: ev.redirectedFrom || null });
    });
    // 尾部剩余快照
    while (snapIdx + 1 < snaps.length) {
      snapIdx++;
      var sp = snaps[snapIdx];
      if (predicted !== sp.reportedBikes) {
        discrepancies.push({ time: sp.time, predicted: predicted, reported: sp.reportedBikes,
          delta: sp.reportedBikes - predicted, quality: sp.quality, note: sp.note });
        predicted = sp.reportedBikes;
      }
      trace.push({ time: sp.time, count: predicted, kind: 'snapshot', quality: sp.quality });
    }

    /* ---- 核实覆盖区间：相邻快照间隔 > GAP_LIMIT 即断档 ---- */
    var gaps = [];
    if (snaps.length) {
      if (snaps[0].time > winStart) gaps.push({ start: winStart, end: snaps[0].time, reason: '首快照前无数据' });
      for (var i = 1; i < snaps.length; i++) {
        // 全局断档窗口 09:30–11:00：末条正常快照 09:15 到恢复首条 11:00 间隔 105 分钟，
        // 断档区间从末条快照之后起算（09:15 本身仍是已核实读数）
        if (snaps[i].time - snaps[i - 1].time > GAP_LIMIT) {
          gaps.push({ start: snaps[i - 1].time + U.GRID_STEP, end: snaps[i].time, reason: '快照上报中断' });
        }
      }
      if (snaps[snaps.length - 1].time < winEnd) {
        gaps.push({ start: snaps[snaps.length - 1].time, end: winEnd, reason: '末快照后无数据' });
      }
    } else {
      gaps.push({ start: winStart, end: winEnd, reason: '当日无任何快照' });
    }
    function inGap(t) {
      for (var g = 0; g < gaps.length; g++) {
        if (t >= gaps[g].start && t < gaps[g].end) return true;
      }
      return false;
    }

    /* ---- 5 分钟网格时序（引擎统一时间分辨率） ---- */
    function countAt(t) {
      var c = null;
      for (var i = 0; i < trace.length; i++) {
        if (trace[i].time <= t) c = trace[i].count; else break;
      }
      return c;
    }
    var series = [];
    for (var t = winStart; t <= winEnd; t += U.GRID_STEP) {
      var c = countAt(t);
      var gapFlag = inGap(t);
      // 该 5 分钟网格内的失败借车/还车尝试：快照只有 15 分钟粒度，
      // 瞬时缺车可能在两次快照之间发生并恢复，必须用尝试流补证
      var failedRentInCell = stationAttempts.some(function (a) {
        return a.kind === 'rent' && a.result === 'failed' && a.time >= t && a.time < t + U.GRID_STEP;
      });
      var failedRetInCell = stationAttempts.some(function (a) {
        return a.kind === 'return' && a.result === 'failed' && a.time >= t && a.time < t + U.GRID_STEP;
      });
      var state = 'no-data';
      if (c !== null && !gapFlag) {
        if (c === 0 || failedRentInCell) state = 'stockout';
        else if (c >= cap || failedRetInCell) state = 'full';
        else state = 'ok';
      } else if (c !== null && gapFlag) {
        // 断档内：库存来自事件推演但未经快照核实，只能给“存疑”状态
        if (c === 0 || failedRentInCell) state = 'stockout-suspect';
        else if (c >= cap || failedRetInCell) state = 'full-suspect';
        else state = 'unverified';
      }
      series.push({ time: t, count: c, gap: gapFlag, state: state,
        failedRent: failedRentInCell, failedReturn: failedRetInCell });
    }

    /* ---- 分段（episodes）：把相邻同状态网格合并 ---- */
    var episodes = [];
    series.forEach(function (pt) {
      var last = episodes[episodes.length - 1];
      if (last && last.state === pt.state && pt.time - last.end <= U.GRID_STEP) {
        last.end = pt.time + U.GRID_STEP;
      } else {
        episodes.push({ state: pt.state, start: pt.time, end: pt.time + U.GRID_STEP,
          startCount: pt.count, endCount: pt.count });
      }
    });
    episodes.forEach(function (ep) {
      ep.durationMin = ep.end - ep.start;
      ep.inGap = ep.state === 'stockout-suspect' || ep.state === 'full-suspect' || ep.state === 'unverified';
      ep.failedRentals = stationAttempts.filter(function (a) {
        return a.kind === 'rent' && a.result === 'failed' && a.time >= ep.start && a.time < ep.end;
      }).length;
      ep.failedReturns = stationAttempts.filter(function (a) {
        return a.kind === 'return' && a.result === 'failed' && a.time >= ep.start && a.time < ep.end;
      }).length;
    });

    /* ---- 校正后指标（事件对账） ---- */
    var userRent = userEvents.filter(function (e) { return e.kind === 'rent'; }).length;
    var userReturn = userEvents.filter(function (e) { return e.kind === 'return'; }).length;
    var dispatchIn = dispatchEvents.filter(function (e) { return e.delta > 0; })
      .reduce(function (s, e) { return s + e.delta; }, 0);
    var dispatchOut = dispatchEvents.filter(function (e) { return e.delta < 0; })
      .reduce(function (s, e) { return s + -e.delta; }, 0);
    var failedRent = stationAttempts.filter(function (a) { return a.kind === 'rent' && a.result === 'failed'; }).length;
    var failedRet = stationAttempts.filter(function (a) { return a.kind === 'return' && a.result === 'failed'; }).length;
    var redirectedRet = userEvents.filter(function (e) { return e.kind === 'return' && e.redirectedFrom; }).length;
    var stockoutMin = episodes.filter(function (e) { return e.state === 'stockout'; })
      .reduce(function (s, e) { return s + e.durationMin; }, 0);
    var stockoutSuspectMin = episodes.filter(function (e) { return e.state === 'stockout-suspect'; })
      .reduce(function (s, e) { return s + e.durationMin; }, 0);
    var fullMin = episodes.filter(function (e) { return e.state === 'full'; })
      .reduce(function (s, e) { return s + e.durationMin; }, 0);
    var gapMin = gaps.reduce(function (s, g) { return s + (g.end - g.start); }, 0);

    /* ---- 校正前指标（naive：只信快照，忽略断档语义） ---- */
    var snapZero = snaps.filter(function (s) { return s.reportedBikes === 0; }).length;
    var snapFull = snaps.filter(function (s) { return s.reportedBikes >= cap; }).length;
    var naive = {
      stockoutMin: snapZero * 15,
      fullMin: snapFull * 15,
      avgBikes: snaps.length ? U.round1(snaps.reduce(function (s, x) { return s + x.reportedBikes; }, 0) / snaps.length) : null,
      gapMin: 0, // naive 口径不识别断档，把缺快照当作“正常无事件”
      discrepancyCount: 0,
      failedRentals: failedRent,
      note: 'naive 口径：仅按 15 分钟快照读数统计，缺快照时段视为状态不变，且不做事件对账'
    };

    return {
      stationId: stationId, date: date, active: active, capacity: cap,
      snaps: snaps, events: events, attempts: stationAttempts,
      trace: trace, discrepancies: discrepancies, gaps: gaps,
      series: series, episodes: episodes,
      corrected: {
        userRentals: userRent, userReturns: userReturn,
        dispatchIn: dispatchIn, dispatchOut: dispatchOut,
        failedRentals: failedRent, failedReturns: failedRet,
        redirectedReturns: redirectedRet,
        stockoutMin: stockoutMin, stockoutSuspectMin: stockoutSuspectMin,
        fullMin: fullMin, gapMin: gapMin,
        discrepancyCount: discrepancies.length,
        avgBikes: series.filter(function (p) { return p.count !== null && !p.gap; }).length ?
          U.round1(series.filter(function (p) { return p.count !== null && !p.gap; })
            .reduce(function (s, p) { return s + p.count; }, 0) /
            series.filter(function (p) { return p.count !== null && !p.gap; }).length) : null
      },
      naive: naive
    };
  }

  /* ============ 2. 小时分箱（供柱状图与估算） ============ */
  function hourlyBuckets(day) {
    var di = U.dateIndex(day.date), out = [];
    for (var h = 6; h <= 22; h++) {
      var hs = di * U.DAY_MINUTES + h * 60, he = hs + 60;
      out.push({
        hour: h,
        rentals: day.events.filter(function (e) { return e.kind === 'rent' && e.time >= hs && e.time < he; }).length,
        returns: day.events.filter(function (e) { return e.kind === 'return' && e.time >= hs && e.time < he; }).length,
        failedRentals: day.attempts.filter(function (a) {
          return a.kind === 'rent' && a.result === 'failed' && a.time >= hs && a.time < he; }).length,
        failedReturns: day.attempts.filter(function (a) {
          return a.kind === 'return' && a.result === 'failed' && a.time >= hs && a.time < he; }).length,
        dispatchIn: day.events.filter(function (e) {
          return e.kind === 'dispatch' && e.delta > 0 && e.time >= hs && e.time < he; })
          .reduce(function (s, e) { return s + e.delta; }, 0),
        dispatchOut: day.events.filter(function (e) {
          return e.kind === 'dispatch' && e.delta < 0 && e.time >= hs && e.time < he; })
          .reduce(function (s, e) { return s + -e.delta; }, 0)
      });
    }
    return out;
  }

  /* ============ 3. 潜在需求估算（独立结果，不写回订单表） ============ */
  /* 方法：取同站点、同星期、同小时且“未受缺车约束”的历史样本，
   * 计算平均借车需求率（辆/小时），乘以缺车时长得到期望需求，
   * 减去该时段已观测到的成功借车，得到潜在流失需求。
   * 不确定范围：历史样本最小值/最大值率 × 时长；样本不足则拓宽 ±50%。 */
  function baselineRates(stationId) {
    var rows = D.history.filter(function (h) {
      return h.stationId === stationId && !h.stockoutConstrained;
    });
    var byHour = {};
    rows.forEach(function (r) {
      if (!byHour[r.hour]) byHour[r.hour] = [];
      byHour[r.hour].push(r.observedRentals);
    });
    var out = {};
    Object.keys(byHour).forEach(function (h) {
      var arr = byHour[h].sort(function (a, b) { return a - b; });
      var mean = arr.reduce(function (s, x) { return s + x; }, 0) / arr.length;
      out[h] = {
        n: arr.length, mean: U.round2(mean),
        minRate: arr[0], maxRate: arr[arr.length - 1],
        values: arr
      };
    });
    return out;
  }

  function estimateLost(day) {
    var rates = baselineRates(day.stationId);
    var episodeEstimates = [];
    day.episodes.filter(function (e) {
      return e.state === 'stockout' || e.state === 'stockout-suspect';
    }).forEach(function (ep) {
      var hours = ep.durationMin / 60;
      // 覆盖到的小时，按时长加权
      var hStart = Math.floor(U.localOf(ep.start) / 60);
      var hEnd = Math.floor((U.localOf(ep.end) - 1) / 60);
      var weightSum = 0, meanSum = 0, lowSum = 0, highSum = 0;
      var usedHours = [];
      for (var h = hStart; h <= hEnd; h++) {
        var segS = Math.max(ep.start, U.dayOf(ep.start) * U.DAY_MINUTES + h * 60);
        var segE = Math.min(ep.end, U.dayOf(ep.start) * U.DAY_MINUTES + (h + 1) * 60);
        var w = (segE - segS) / 60;
        var r = rates[h];
        if (!r) continue;
        usedHours.push(h);
        weightSum += w;
        meanSum += r.mean * w;
        lowSum += r.minRate * w;
        highSum += r.maxRate * w;
      }
      if (!weightSum) return;
      var observed = day.events.filter(function (e) {
        return e.kind === 'rent' && e.time >= ep.start && e.time < ep.end;
      }).length;
      var point = Math.max(0, U.round1(meanSum - observed));
      var low = Math.max(0, Math.round(lowSum - observed));
      var high = Math.max(0, Math.round(highSum - observed));
      // 断档内的缺车本身不可核实，额外拓宽不确定带
      if (ep.state === 'stockout-suspect') {
        low = 0; high = Math.round(high * 1.5);
      }
      var confidence = weightSum >= 1 && usedHours.length >= 1 ? '中' : '低';
      if (usedHours.every(function (h) { return rates[h] && rates[h].n >= 3; }) && ep.state === 'stockout') confidence = '中';
      episodeEstimates.push({
        episodeStart: ep.start, episodeEnd: ep.end, state: ep.state,
        durationMin: ep.durationMin, usedHistoryHours: usedHours,
        observedRentals: observed, pointEstimate: point, low: low, high: high,
        confidence: confidence
      });
    });
    var totalPoint = U.round1(episodeEstimates.reduce(function (s, e) { return s + e.pointEstimate; }, 0));
    var totalLow = episodeEstimates.reduce(function (s, e) { return s + e.low; }, 0);
    var totalHigh = episodeEstimates.reduce(function (s, e) { return s + e.high; }, 0);
    return {
      stationId: day.stationId, date: day.date,
      method: '同类时段历史均值法（同站、同星期、同小时，剔除缺车约束样本）',
      assumptions: [
        '历史需求模式在分析日保持稳定，天气/活动等外部因素无显著变化',
        '缺车时段内若有车，借车需求率与同类历史小时相当',
        '已观测到的成功借车从期望需求中扣除，避免重复计算',
        '断档内的“存疑缺车”不可核实，下界取 0、上界放宽 50%',
        '估算结果仅用于缺口评估，不会写入 orders 真实订单表'
      ],
      episodeEstimates: episodeEstimates,
      totalPoint: totalPoint, totalLow: totalLow, totalHigh: totalHigh,
      sampleCount: Object.keys(rates).length
    };
  }

  /* ============ 4. 调度方案重放 ============ */
  function simulatePlan(planId) {
    var plan = D.plans[planId];
    var date = D.meta.focusDate;
    var di = U.dateIndex(date);
    var winStart = di * U.DAY_MINUTES + U.WINDOW_START, winEnd = di * U.DAY_MINUTES + U.WINDOW_END;

    // 初始库存：取当日首快照读数（模拟从开园状态开始）
    var inv = {};
    D.stations.forEach(function (s) {
      if (!U.isActive(s, date)) { inv[s.id] = null; return; }
      var first = D.snapshots.filter(function (sn) {
        return sn.stationId === s.id && sn.time >= winStart;
      })[0];
      inv[s.id] = first ? first.reportedBikes : 0;
    });
    var warehouse = 60;

    // 方案动作转成带绝对时间的库存增量
    var moves = plan.moves.map(function (m) {
      return { time: U.absMinute(date, m.time), from: m.from, to: m.to, qty: m.qty, note: m.note };
    }).sort(function (a, b) { return a.time - b.time; });

    // 真实用户事件流（借/还尝试 + 成功订单），方案不变的部分
    var userEvts = D.attempts.filter(function (a) {
      return a.time >= winStart && a.time <= winEnd && D.stations.some(function (s) {
        return s.id === a.stationId && U.isActive(s, date);
      });
    }).sort(function (a, b) { return a.time - b.time || a.id.localeCompare(b.id); });

    var results = {};
    D.stations.forEach(function (s) {
      if (!U.isActive(s, date)) return;
      results[s.id] = { failedRentals: 0, failedReturns: 0, redirected: 0, stockoutSteps: 0, fullSteps: 0 };
    });
    var moveLogs = [], unmetMoves = [];
    var mi = 0;
    // 模拟库存轨迹：主循环中每次库存变化都记录，供缺车/满桩时长统计
    var inventoryTrace = [];
    function snapTrace(t) {
      var row = { time: t };
      D.stations.forEach(function (s) { if (inv[s.id] !== null) row[s.id] = inv[s.id]; });
      inventoryTrace.push(row);
    }
    snapTrace(winStart);
    userEvts.forEach(function (a) {
      var t = a.time;
      while (mi < moves.length && moves[mi].time <= t) {
        var mv = moves[mi++];
        var src = mv.from === 'WH' ? warehouse : inv[mv.from];
        var actual = Math.min(mv.qty, src === null || src === undefined ? 0 : src);
        if (mv.from === 'WH') warehouse -= actual; else inv[mv.from] -= actual;
        if (mv.to === 'WH') warehouse += actual; else inv[mv.to] += actual;
        moveLogs.push({ time: mv.time, from: mv.from, to: mv.to, planned: mv.qty, actual: actual,
          short: mv.qty - actual, note: mv.note });
        if (actual < mv.qty) unmetMoves.push({ time: mv.time, move: mv, short: mv.qty - actual });
        snapTrace(mv.time);
      }
      if (a.kind === 'rent') {
        // 借车尝试是需求意图：按本方案模拟库存重新判定，而非沿用真实成败
        if (inv[a.stationId] > 0) {
          inv[a.stationId] -= 1; snapTrace(t);
        } else {
          results[a.stationId].failedRentals++;
        }
      } else if (a.kind === 'return') {
        var cap2 = capAt(a.stationId, date);
        if (inv[a.stationId] < cap2) {
          inv[a.stationId] += 1; snapTrace(t);
          if (a.originStationId && a.originStationId !== a.stationId && results[a.originStationId]) {
            // 改道成功的还车：原站在真实方案里发生过一次满桩拒绝
            results[a.originStationId].redirected++;
          }
        } else {
          results[a.stationId].failedReturns++;
        }
      }
    });
    while (mi < moves.length) {
      var mv2 = moves[mi++];
      var src2 = mv2.from === 'WH' ? warehouse : inv[mv2.from];
      var act2 = Math.min(mv2.qty, src2 === null ? 0 : src2);
      if (mv2.from === 'WH') warehouse -= act2; else inv[mv2.from] -= act2;
      if (mv2.to === 'WH') warehouse += act2; else inv[mv2.to] += act2;
      moveLogs.push({ time: mv2.time, from: mv2.from, to: mv2.to, planned: mv2.qty, actual: act2,
        short: mv2.qty - act2, note: mv2.note });
      if (act2 < mv2.qty) unmetMoves.push({ time: mv2.time, move: mv2, short: mv2.qty - act2 });
    }

    // 5 分钟网格统计缺车/满桩时长：直接读主循环记录的模拟库存轨迹
    D.stations.forEach(function (s) {
      if (!U.isActive(s, date)) return;
      var sid = s.id, cap = capAt(sid, date), ti = 0;
      function cnt(t) {
        var v = inventoryTrace[0][sid];
        while (ti + 1 < inventoryTrace.length && inventoryTrace[ti + 1].time <= t) { ti++; v = inventoryTrace[ti][sid]; }
        return v;
      }
      for (var t = winStart; t <= winEnd; t += U.GRID_STEP) {
        var v = cnt(t);
        if (v === 0) results[sid].stockoutSteps++;
        if (v >= cap) results[sid].fullSteps++;
      }
    });

    var summary = {
      planId: planId, planName: plan.name, description: plan.description,
      stationResults: Object.keys(results).map(function (sid) {
        var r = results[sid];
        return {
          stationId: sid,
          failedRentals: r.failedRentals,
          failedReturns: r.failedReturns,
          redirectedReturns: r.redirected,
          stockoutMin: r.stockoutSteps * U.GRID_STEP,
          fullMin: r.fullSteps * U.GRID_STEP
        };
      }),
      moveLogs: moveLogs, unmetMoves: unmetMoves,
      totals: {
        failedRentals: Object.keys(results).reduce(function (s, k) { return s + results[k].failedRentals; }, 0),
        failedReturns: Object.keys(results).reduce(function (s, k) { return s + results[k].failedReturns; }, 0),
        redirected: Object.keys(results).reduce(function (s, k) { return s + results[k].redirected; }, 0),
        stockoutMin: Object.keys(results).reduce(function (s, k) { return s + results[k].stockoutSteps * U.GRID_STEP; }, 0),
        fullMin: Object.keys(results).reduce(function (s, k) { return s + results[k].fullSteps * U.GRID_STEP; }, 0)
      }
    };
    // 潜在流失需求：对每个站的缺车时长用同一估算器折算（独立结果）
    summary.estimatedLost = estimatePlanLost(summary, date);
    return summary;
  }

  // 方案模拟的缺车时段没有 episode 明细，按站点缺车总分钟数 + 历史均值率折算
  function estimatePlanLost(summary, date) {
    var out = [];
    summary.stationResults.forEach(function (r) {
      if (!r.stockoutMin) return;
      var rates = baselineRates(r.stationId);
      // 缺车主要集中在早晚高峰，按 8 点和 18 点两小时等权折算的简化假设
      var peaks = [8, 18];
      var meanRate = peaks.reduce(function (s, h) { return s + (rates[h] ? rates[h].mean : 0); }, 0) / peaks.length;
      var maxRate = peaks.reduce(function (s, h) { return s + (rates[h] ? rates[h].maxRate : 0); }, 0) / peaks.length;
      var hours = r.stockoutMin / 60;
      out.push({
        stationId: r.stationId,
        point: U.round1(meanRate * hours),
        low: 0,
        high: Math.round(maxRate * hours * 1.2),
        note: '按高峰小时（8 点/18 点）历史均值率折算的简化估算，仅供方案间相对比较'
      });
    });
    return {
      items: out,
      totalPoint: U.round1(out.reduce(function (s, x) { return s + x.point; }, 0)),
      totalLow: 0,
      totalHigh: out.reduce(function (s, x) { return s + x.high; }, 0)
    };
  }

  global.Engine = {
    GAP_LIMIT: GAP_LIMIT,
    buildStationDay: buildStationDay,
    hourlyBuckets: hourlyBuckets,
    baselineRates: baselineRates,
    estimateLost: estimateLost,
    simulatePlan: simulatePlan
  };
})(typeof window !== 'undefined' ? window : globalThis);
