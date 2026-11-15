/* 纯 SVG 图表：供需时间线、小时柱状、方案对比。统一坐标系与 tooltip 行为。 */
(function (global) {
  'use strict';
  var U = global.Util;

  function cssVar(name) {
    return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
  }
  function el(tag, attrs, parent) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(node);
    return node;
  }
  function clear(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }

  // 通用边距
  var M = { top: 18, right: 20, bottom: 34, left: 46 };

  /* ============ 1. 供需时间线 ============ */
  function renderTimeline(svg, tooltip, day, opts) {
    clear(svg);
    var W = svg.clientWidth || 1120, H = 380;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var iw = W - M.left - M.right, ih = H - M.top - M.bottom;
    var t0 = day.series[0].time, t1 = day.series[day.series.length - 1].time;
    var maxY = Math.max(day.capacity, day.capacity) + 2;
    function x(t) { return M.left + (t - t0) / (t1 - t0) * iw; }
    function y(v) { return M.top + ih - v / maxY * ih; }

    // 状态背景带（缺车/满桩/断档/存疑）
    day.episodes.forEach(function (ep) {
      if (ep.state === 'ok') return;
      var cls = ep.state.indexOf('stockout') === 0 ? 'stockout' :
        ep.state.indexOf('full') === 0 ? 'full' : 'gap';
      if (ep.state === 'stockout-suspect') cls = 'stockout-suspect';
      if (ep.state === 'full-suspect') cls = 'full';
      var x1 = x(ep.start), x2 = x(Math.min(ep.end, t1));
      el('rect', { x: x1, y: M.top, width: Math.max(1, x2 - x1), height: ih,
        class: 'episode-rect ' + cls, 'data-state': ep.state }, svg);
    });

    // 网格 + Y 轴
    var yTicks = 4;
    for (var i = 0; i <= yTicks; i++) {
      var val = Math.round(maxY * i / yTicks);
      var yy = y(val);
      el('line', { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: 'grid-line' }, svg);
      el('text', { x: M.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis', text: val }, svg);
    }
    // X 轴整点
    for (var h = 6; h <= 23; h++) {
      var tt = U.dayOf(t0) * U.DAY_MINUTES + h * 60;
      if (tt < t0 || tt > t1) continue;
      var xx = x(tt);
      el('line', { x1: xx, x2: xx, y1: M.top + ih, y2: M.top + ih + 4, class: 'axis' }, svg);
      el('text', { x: xx, y: M.top + ih + 18, 'text-anchor': 'middle', class: 'axis', text: h + ':00' }, svg);
    }

    // 容量上限区（满桩阈值带）+ 容量虚线
    el('rect', { x: M.left, y: y(day.capacity), width: iw, height: M.top + ih - y(day.capacity), class: 'area-cap' }, svg);
    el('line', { x1: M.left, x2: W - M.right, y1: y(day.capacity), y2: y(day.capacity), class: 'line-cap' }, svg);
    el('text', { x: W - M.right, y: y(day.capacity) - 5, 'text-anchor': 'end', class: 'direct-label',
      text: '容量 ' + day.capacity + ' 桩（满桩线）' }, svg);

    // 库存折线（断档处断开）
    var pts = day.series.filter(function (p) { return p.count !== null; });
    var path = '', pen = null;
    pts.forEach(function (p) {
      var xx = x(p.time), yy = y(p.count);
      if (pen === null || p.gap) { path += 'M ' + xx + ' ' + yy + ' '; pen = true; }
      else path += 'L ' + xx + ' ' + yy + ' ';
    });
    el('path', { d: path, class: 'line-inv' }, svg);

    // 快照点（漂移/卡死高亮）
    day.snaps.forEach(function (s) {
      var cls = s.quality === 'drift' ? 'point-drift' : s.quality === 'stale' ? 'point-stale' : 'point-snap';
      el('circle', { cx: x(s.time), cy: y(s.reportedBikes), r: s.quality === 'ok' ? 2.6 : 4.5,
        class: cls, 'data-snap': s.time }, svg);
    });

    // 调度事件标记（菱形，在图下方）
    day.events.filter(function (e) { return e.kind === 'dispatch'; }).forEach(function (e) {
      var xx = x(e.time), yy = M.top + ih - 6;
      var color = e.delta > 0 ? cssVar('--series-2') : cssVar('--series-4');
      el('path', { d: 'M ' + xx + ' ' + (yy - 5) + ' L ' + (xx + 5) + ' ' + yy + ' L ' + xx + ' ' + (yy + 5) + ' L ' + (xx - 5) + ' ' + yy + ' Z',
        fill: color, class: 'event-marker', 'data-dispatch': e.time }, svg);
    });

    // 交互：十字线 + tooltip
    var cross = el('line', { x1: 0, x2: 0, y1: M.top, y2: M.top + ih, class: 'crosshair' }, svg);
    cross.style.display = 'none';
    var hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var tt = t0 + (mx - M.left) / iw * (t1 - t0);
      var idx = Math.round((tt - t0) / U.GRID_STEP);
      idx = U.clamp(idx, 0, day.series.length - 1);
      var p = day.series[idx];
      cross.style.display = '';
      cross.setAttribute('x1', x(p.time)); cross.setAttribute('x2', x(p.time));
      var stateCN = { stockout: '缺车（已核实）', 'stockout-suspect': '缺车（断档内存疑）',
        full: '满桩（已核实）', 'full-suspect': '满桩（断档内存疑）', ok: '正常', unverified: '断档·未核实', 'no-data': '无数据' };
      var rows = '<div class="tt-row"><span>时间</span><b>' + U.hm(p.time) + '</b></div>' +
        '<div class="tt-row"><span>可用车辆</span><b>' + (p.count === null ? '无快照' : p.count + ' / ' + day.capacity) + '</b></div>' +
        '<div class="tt-row"><span>状态</span><b>' + stateCN[p.state] + '</b></div>' +
        (p.gap ? '<div class="tt-row"><span>数据</span><b>断档（事件推演值）</b></div>' : '');
      // 该网格内的事件
      var cellEvs = day.events.filter(function (e) { return e.time >= p.time && e.time < p.time + U.GRID_STEP; });
      if (cellEvs.length) {
        rows += '<div class="tt-row"><span>本格事件</span><b>' + cellEvs.length + ' 条</b></div>';
      }
      tooltip.innerHTML = '<div class="tt-title">' + U.dateOf(p.time).slice(5) + '</div>' + rows;
      tooltip.hidden = false;
      var tw = tooltip.offsetWidth;
      var left = Math.min(mx + 14, W - tw - 8);
      tooltip.style.left = Math.max(8, left) + 'px';
      tooltip.style.top = (ev.clientY - rect.top - 10) + 'px';
    });
    hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; tooltip.hidden = true; });
  }

  /* ============ 2. 小时柱状（分组） ============ */
  function renderHourly(svg, tooltip, buckets, opts) {
    clear(svg);
    var W = svg.clientWidth || 1120, H = 320;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var iw = W - M.left - M.right, ih = H - M.top - M.bottom;
    var maxV = Math.max(1, Math.max.apply(null, buckets.map(function (b) {
      return Math.max(b.rentals, b.returns, b.failedRentals, b.dispatchIn + b.dispatchOut);
    })));
    var band = iw / buckets.length;
    function y(v) { return M.top + ih - v / maxV * ih; }
    // 网格
    for (var i = 0; i <= 4; i++) {
      var val = Math.round(maxV * i / 4), yy = y(val);
      el('line', { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: 'grid-line' }, svg);
      el('text', { x: M.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis', text: val }, svg);
    }
    var groups = [
      { key: 'rentals', cls: 'bar-rent', label: '成功借车' },
      { key: 'returns', cls: 'bar-return', label: '成功还车' },
      { key: 'failedRentals', cls: 'bar-fail', label: '失败借车' },
      { key: 'dispatchIn', cls: 'bar-dispatch-in', label: '调度调入' }
    ];
    var bw = Math.min(9, band / 5.2);
    buckets.forEach(function (b, bi) {
      var cx = M.left + band * bi + band / 2;
      groups.forEach(function (g, gi) {
        var v = b[g.key];
        if (!v) return;
        var bx = cx + (gi - 1.5) * (bw + 1.5);
        el('rect', { x: bx, y: y(v), width: bw, height: M.top + ih - y(v), rx: 3,
          class: g.cls, 'data-bi': bi }, svg);
      });
      el('text', { x: cx, y: M.top + ih + 18, 'text-anchor': 'middle', class: 'axis', text: b.hour + '时' }, svg);
    });
    var hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var bi = U.clamp(Math.floor((mx - M.left) / band), 0, buckets.length - 1);
      var b = buckets[bi];
      tooltip.innerHTML = '<div class="tt-title">' + b.hour + ':00–' + (b.hour + 1) + ':00</div>' +
        groups.map(function (g) { return '<div class="tt-row"><span>' + g.label + '</span><b>' + b[g.key] + '</b></div>'; }).join('') +
        '<div class="tt-row"><span>失败还车</span><b>' + b.failedReturns + '</b></div>' +
        '<div class="tt-row"><span>调度调出</span><b>' + b.dispatchOut + '</b></div>';
      tooltip.hidden = false;
      tooltip.style.left = Math.min(mx + 14, W - tooltip.offsetWidth - 8) + 'px';
      tooltip.style.top = (ev.clientY - rect.top - 8) + 'px';
    });
    hit.addEventListener('mouseleave', function () { tooltip.hidden = true; });
  }

  /* ============ 3. 方案对比柱状 ============ */
  function renderPlanCompare(svg, tooltip, base, comp, stationResultsA, stationResultsB, nameA, nameB) {
    clear(svg);
    var W = svg.clientWidth || 520, H = 340;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var iw = W - M.left - M.right, ih = H - M.top - M.bottom;
    var metrics = [
      { key: 'stockoutMin', label: '缺车时长', unit: '分' },
      { key: 'fullMin', label: '满桩时长', unit: '分' },
      { key: 'failedRentals', label: '失败借车', unit: '次' },
      { key: 'failedReturns', label: '失败还车', unit: '次' }
    ];
    var maxV = Math.max(1, Math.max.apply(null, metrics.map(function (m) {
      return Math.max(base.totals[m.key], comp.totals[m.key]);
    })));
    var band = iw / metrics.length;
    function y(v) { return M.top + ih - v / maxV * ih; }
    for (var i = 0; i <= 4; i++) {
      var val = Math.round(maxV * i / 4), yy = y(val);
      el('line', { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: 'grid-line' }, svg);
      el('text', { x: M.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis', text: val }, svg);
    }
    var bw = Math.min(26, band * 0.28);
    metrics.forEach(function (m, mi) {
      var cx = M.left + band * mi + band / 2;
      var vA = base.totals[m.key], vB = comp.totals[m.key];
      // 基线：实心
      el('rect', { x: cx - bw - 2, y: y(vA), width: bw, height: M.top + ih - y(vA), rx: 4,
        fill: cssVar('--series-1'), 'data-mi': mi }, svg);
      // 对比：描边
      el('rect', { x: cx + 2, y: y(vB), width: bw, height: M.top + ih - y(vB), rx: 4,
        fill: cssVar('--surface-1'), stroke: cssVar('--series-4'), 'stroke-width': 2, 'data-mi': mi }, svg);
      el('text', { x: cx - bw / 2 - 2, y: y(vA) - 5, 'text-anchor': 'middle', class: 'direct-label', text: vA }, svg);
      el('text', { x: cx + bw / 2 + 2, y: y(vB) - 5, 'text-anchor': 'middle', class: 'direct-label', text: vB }, svg);
      // 两行标签：名称 + 单位
      var lbl = el('text', { x: cx, y: M.top + ih + 16, 'text-anchor': 'middle', class: 'axis', text: m.label }, svg);
      el('tspan', { x: cx, dy: 13, text: '(' + m.unit + ')' }, lbl);
    });
    // 图例
    var lg = el('g', {}, svg);
    el('rect', { x: M.left, y: 2, width: 12, height: 12, rx: 3, fill: cssVar('--series-1') }, lg);
    el('text', { x: M.left + 16, y: 12, class: 'axis', text: nameA }, lg);
    el('rect', { x: M.left + 120, y: 2, width: 12, height: 12, rx: 3, fill: cssVar('--surface-1'),
      stroke: cssVar('--series-4'), 'stroke-width': 2 }, lg);
    el('text', { x: M.left + 136, y: 12, class: 'axis', text: nameB }, lg);

    var hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var mi = U.clamp(Math.floor((mx - M.left) / band), 0, metrics.length - 1);
      var m = metrics[mi];
      tooltip.innerHTML = '<div class="tt-title">' + m.label + '</div>' +
        '<div class="tt-row"><span>' + nameA + '</span><b>' + base.totals[m.key] + '</b></div>' +
        '<div class="tt-row"><span>' + nameB + '</span><b>' + comp.totals[m.key] + '</b></div>';
      tooltip.hidden = false;
      tooltip.style.left = Math.min(mx + 14, W - tooltip.offsetWidth - 8) + 'px';
      tooltip.style.top = (ev.clientY - rect.top - 8) + 'px';
    });
    hit.addEventListener('mouseleave', function () { tooltip.hidden = true; });
  }

  global.Charts = { renderTimeline: renderTimeline, renderHourly: renderHourly, renderPlanCompare: renderPlanCompare };
})(typeof window !== 'undefined' ? window : globalThis);
