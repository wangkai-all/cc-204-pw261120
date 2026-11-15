/* 应用主控制器：筛选、KPI、时间线、估算、方案对比、原始记录追溯 */
(function () {
  'use strict';
  var U = window.Util, D = window.SyntheticData, E = window.Engine, C = window.Charts;

  var state = {
    date: D.meta.focusDate,
    stationId: 'ST01',
    metricMode: 'corrected',
    planBase: 'A',
    planComp: 'B',
    recordKind: 'all',
    search: ''
  };
  var cache = {}; // "SID|date" -> buildStationDay 结果

  function $(id) { return document.getElementById(id); }
  function stationName(id) {
    var s = D.stations.filter(function (x) { return x.id === id; })[0];
    return s ? s.id + ' ' + s.name : id;
  }
  function fmtMin(m) {
    if (!m) return '0 分';
    var h = Math.floor(m / 60), mm = m % 60;
    return (h ? h + ' 小时 ' : '') + (mm ? mm + ' 分' : (h ? '' : '0 分'));
  }
  function getDay(sid, date) {
    var key = sid + '|' + date;
    if (!cache[key]) cache[key] = E.buildStationDay(sid, date);
    return cache[key];
  }

  /* ---------- 初始化下拉与静态说明 ---------- */
  function initFilters() {
    var ds = $('dateSelect');
    D.meta.dates.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d; o.textContent = U.dateLabel(d) + (d === D.meta.focusDate ? '（聚焦日）' : '');
      if (d === state.date) o.selected = true;
      ds.appendChild(o);
    });
    var ss = $('stationSelect');
    D.stations.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.id + ' ' + s.name;
      if (s.id === state.stationId) o.selected = true;
      ss.appendChild(o);
    });
    $('dataScope').textContent = D.meta.dates[0].slice(5) + '–' + D.meta.dates[3].slice(5) +
      ' · ' + D.orders.length + ' 条订单 · 种子 ' + D.meta.seed;
    var ul = $('assumptions');
    D.meta.assumptions.forEach(function (a) {
      var li = document.createElement('li'); li.textContent = a; ul.appendChild(li);
    });
    // 图例
    var legend = [
      ['--series-1', '可用车辆（重建）', 'line'],
      ['--full', '容量/满桩线', 'line'],
      ['--stockout', '缺车（已核实）', 'box'],
      ['--stockout-suspect', '缺车（断档内存疑）', 'box'],
      ['--full', '满桩', 'box'],
      ['--gap', '数据断档', 'box']
    ];
    var lg = $('stateLegend');
    legend.forEach(function (it) {
      var item = document.createElement('span'); item.className = 'legend-item';
      var sw = document.createElement('span');
      sw.className = 'legend-swatch ' + (it[2] === 'line' ? 'line' : '');
      if (it[2] === 'line') sw.style.borderTopColor = 'var(' + it[0] + ')';
      else sw.style.background = 'var(' + it[0] + ')';
      item.appendChild(sw);
      item.appendChild(document.createTextNode(it[1]));
      lg.appendChild(item);
    });
  }

  /* ---------- KPI ---------- */
  function renderKpi(day) {
    var row = $('kpiRow'); row.innerHTML = '';
    var m = state.metricMode === 'corrected' ? day.corrected : day.naive;
    var isNaive = state.metricMode === 'naive';
    var cards = [
      { label: '用户成功借车', value: day.corrected.userRentals, accent: 'var(--series-1)' },
      { label: '用户成功还车', value: day.corrected.userReturns, accent: 'var(--series-3)',
        sub: '其中改道还车 ' + day.corrected.redirectedReturns + ' 次' },
      { label: '缺车时长（已核实）', value: fmtMin(day.corrected.stockoutMin), accent: 'var(--stockout)',
        sub: '另有存疑 ' + fmtMin(day.corrected.stockoutSuspectMin), subCls: 'up', hideNaive: isNaive },
      { label: '满桩时长', value: fmtMin(isNaive ? day.naive.fullMin : day.corrected.fullMin),
        accent: 'var(--full)' },
      { label: '失败借车（流失需求证据）', value: day.corrected.failedRentals, accent: 'var(--critical)',
        sub: '失败还车 ' + day.corrected.failedReturns + ' 次' },
      { label: '调度调入 / 调出', value: day.corrected.dispatchIn + ' / ' + day.corrected.dispatchOut,
        accent: 'var(--series-2)', sub: '调度不计入用户还车' },
      { label: '数据断档时长', value: fmtMin(day.corrected.gapMin), accent: 'var(--gap)',
        sub: isNaive ? '校正前口径不识别断档' : '断档≠缺车，单独标识', subCls: isNaive ? 'naive-flag' : '' },
      { label: '平均可用车辆', value: (isNaive ? day.naive.avgBikes : day.corrected.avgBikes) + ' 辆',
        accent: 'var(--series-4)',
        sub: isNaive ? '仅按快照读数，未对账' : '事件对账后', subCls: isNaive ? 'naive-flag' : '' }
    ];
    cards.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'kpi' + (isNaive ? ' naive' : '');
      div.style.setProperty('--accent', c.accent);
      div.innerHTML = '<div class="kpi-label">' + c.label + '</div>' +
        '<div class="kpi-value">' + c.value + '</div>' +
        (c.sub ? '<div class="kpi-sub ' + (c.subCls || '') + '">' +
          (c.subCls === 'up' ? '<span class="up">' + c.sub + '</span>' : c.sub) + '</div>' : '');
      row.appendChild(div);
    });
  }

  /* ---------- 时间线 ---------- */
  function renderTimelinePanel(day) {
    C.renderTimeline($('timelineChart'), $('timelineTooltip'), day, {});
    var driftCount = day.discrepancies.filter(function (x) { return x.quality === 'drift'; }).length;
    var staleCount = day.discrepancies.filter(function (x) { return x.quality === 'stale'; }).length;
    $('timelineHint').textContent = '容量 ' + day.capacity + ' 桩 · 菱形=调度 · 橙点=漂移 · 紫点=卡死';
    $('timelineNote').textContent =
      '浅红=已核实缺车，浅橙=断档内存疑缺车，浅黄=满桩，灰色=数据断档（库存为事件推演值，未经快照核实）。' +
      '本站点对账发现快照异常：漂移 ' + driftCount + ' 处、卡死 ' + staleCount + ' 处。' +
      (state.metricMode === 'naive' ? ' 当前为校正前口径：断档被当作状态不变，满桩/缺车时长可能失真。' : '');
  }

  /* ---------- 小时柱状 ---------- */
  function renderHourlyPanel(day) {
    var buckets = E.hourlyBuckets(day);
    C.renderHourly($('hourlyChart'), $('hourlyTooltip'), buckets, {});
  }

  /* ---------- 潜在需求估算 ---------- */
  function renderEstimate(day) {
    var est = E.estimateLost(day);
    $('estPoint').textContent = est.totalPoint;
    $('estRange').innerHTML = '不确定范围 <b>' + est.totalLow + ' – ' + est.totalHigh + '</b> 辆';
    $('estMethod').textContent = est.method + ' · 有效历史小时样本 ' + est.sampleCount + ' 组';
    var conf = est.episodeEstimates.length ? est.episodeEstimates[0].confidence : '低';
    var tag = $('estimateConfidence');
    tag.textContent = '估算置信度：' + conf + '（含假设，仅供决策参考）';
    tag.className = 'estimate-tag tag-confidence-' + conf;
    var ua = $('estAssumptions'); ua.innerHTML = '';
    est.assumptions.forEach(function (a) {
      var li = document.createElement('li'); li.textContent = a; ua.appendChild(li);
    });
    var tb = $('estTable').querySelector('tbody'); tb.innerHTML = '';
    if (!est.episodeEstimates.length) {
      tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">当日无缺车时段，无需估算流失需求</td></tr>';
      return;
    }
    est.episodeEstimates.forEach(function (e) {
      var tr = document.createElement('tr');
      var stateCN = e.state === 'stockout' ? '已核实缺车' : '断档存疑缺车';
      tr.innerHTML =
        '<td class="mono">' + U.hm(e.episodeStart) + '–' + U.hm(e.episodeEnd) + '</td>' +
        '<td><span class="pill ' + (e.state === 'stockout' ? 'stockout' : 'stockout-suspect') + '">' + stateCN + '</span></td>' +
        '<td class="num">' + e.durationMin + '</td>' +
        '<td class="num">' + e.observedRentals + '</td>' +
        '<td class="num">' + e.low + '</td>' +
        '<td class="num"><b>' + e.pointEstimate + '</b></td>' +
        '<td class="num">' + e.high + '</td>' +
        '<td>' + e.confidence + '</td>';
      tb.appendChild(tr);
    });
  }

  /* ---------- 方案对比 ---------- */
  function renderPlans() {
    var base = E.simulatePlan(state.planBase);
    var comp = E.simulatePlan(state.planComp);
    C.renderPlanCompare($('planCompareChart'), $('planTooltip'), base, comp,
      null, null, base.planName, comp.planName);
    $('planColA').textContent = base.planName;
    $('planColB').textContent = comp.planName;
    var rows = [
      ['缺车总时长(分)', 'stockoutMin', true],
      ['满桩总时长(分)', 'fullMin', false],
      ['失败借车(次)', 'failedRentals', true],
      ['失败还车(次)', 'failedReturns', false],
      ['改道还车(次)', 'redirected', false],
      ['估算潜在流失(辆)', null, true]
    ];
    var tb = $('planTable').querySelector('tbody'); tb.innerHTML = '';
    rows.forEach(function (r) {
      var label = r[0], key = r[1], lowerBetter = r[2];
      var va = key ? base.totals[key] : base.estimatedLost.totalPoint;
      var vb = key ? comp.totals[key] : comp.estimatedLost.totalPoint;
      var diff = vb - va;
      var cls = diff === 0 ? 'delta-flat' : (lowerBetter ? (diff < 0 ? 'delta-good' : 'delta-bad') : (diff > 0 ? 'delta-bad' : 'delta-good'));
      var sign = diff > 0 ? '+' : '';
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + label + '</td><td class="num">' + va + '</td><td class="num"><b>' + vb + '</b></td>' +
        '<td class="num ' + cls + '">' + (diff === 0 ? '持平' : sign + diff) + '</td>';
      tb.appendChild(tr);
    });
    // 估算流失的不确定范围单独一行说明
    var tr2 = document.createElement('tr');
    tr2.innerHTML = '<td>估算流失不确定范围(辆)</td><td class="num">' + base.estimatedLost.totalLow + '–' + base.estimatedLost.totalHigh +
      '</td><td class="num">' + comp.estimatedLost.totalLow + '–' + comp.estimatedLost.totalHigh + '</td><td class="num delta-flat">区间</td>';
    tb.appendChild(tr2);

    // 两方案的调度动作
    var wrap = $('planMoves'); wrap.innerHTML = '';
    [base, comp].forEach(function (plan) {
      var card = document.createElement('div'); card.className = 'move-card';
      var html = '<h4>' + plan.planName + '</h4><p class="hint" style="margin:0 0 8px">' + plan.description + '</p>';
      plan.moveLogs.forEach(function (lg) {
        var shortTxt = lg.short ? ' <span class="delta-bad">（少调 ' + lg.short + '）</span>' : '';
        html += '<div class="move-line"><span>' + U.hm(lg.time) + ' ' + lg.from + '→' + lg.to + '</span>' +
          '<span class="mv">' + lg.actual + '/' + lg.planned + ' 辆' + shortTxt + '</span></div>';
      });
      card.innerHTML = html;
      wrap.appendChild(card);
    });
  }

  /* ---------- 原始记录追溯 ---------- */
  function kindOf(rec) {
    if (rec.orderId !== undefined || (rec.type && (rec.type === 'rent' || rec.type === 'return'))) return 'order';
    if (rec.kind === 'rent' || rec.kind === 'return') return 'attempt';
    if (rec.plannedQty !== undefined) return 'dispatch';
    if (rec.reportedBikes !== undefined && rec.trueBikes !== undefined) return 'snapshot';
    return 'other';
  }
  function renderTrace(day) {
    var recs = [];
    // 订单
    D.orders.forEach(function (o) {
      if (o.stationId !== state.stationId || U.dateOf(o.time) !== state.date) return;
      recs.push({ time: o.time, type: 'order', raw: o,
        cells: [o.orderId, '<span class="pill ' + o.type + '">' + (o.type === 'rent' ? '借车' : '还车') + '</span>',
          o.bikeId, U.full(o.time), o.redirectedFrom ? '改道自 ' + o.redirectedFrom : '—', o.attemptId] });
    });
    // 尝试（含失败）
    D.attempts.forEach(function (a) {
      if (a.stationId !== state.stationId || U.dateOf(a.time) !== state.date) return;
      var pill = a.result === 'success' ? '<span class="pill ok">成功</span>' :
        '<span class="pill ' + (a.reason === 'empty' ? 'stockout' : 'full') + '">失败·' +
        (a.reason === 'empty' ? '缺车' : '满桩') + '</span>';
      recs.push({ time: a.time, type: 'attempt', raw: a,
        cells: [a.id, pill, a.bikeId || '—', U.full(a.time), a.note || (a.redirectedTo ? '改道至 ' + a.redirectedTo : '—'), a.orderId || '—'] });
    });
    // 调度
    D.dispatches.forEach(function (dp) {
      if (dp.from !== state.stationId && dp.to !== state.stationId) return;
      if (U.dateOf(dp.time) !== state.date) return;
      var involved = (dp.from === state.stationId ? '调出→' + dp.to : '←调入自 ' + dp.from);
      recs.push({ time: dp.time, type: 'dispatch', raw: dp,
        cells: [dp.id, '<span class="pill dispatch">调度·' + dp.kind + '</span>',
          '计划' + dp.plannedQty + '/实' + dp.actualQty, U.full(dp.time), involved + ' ' + dp.note, '—'] });
    });
    // 快照
    day.snaps.forEach(function (s) {
      var q = s.quality === 'ok' ? '<span class="pill ok">正常</span>' :
        '<span class="pill ' + s.quality + '">' + (s.quality === 'drift' ? '漂移' : '卡死') + '</span>';
      recs.push({ time: s.time, type: 'snapshot', raw: s,
        cells: [s.id, q, '读数' + s.reportedBikes + '/真值' + s.trueBikes, U.full(s.time), s.note || '—', '—'] });
    });
    recs.sort(function (a, b) { return a.time - b.time; });

    var head = $('traceHead');
    head.innerHTML = '<th>记录 ID</th><th>类型/结果</th><th>对象/数量</th><th>时间</th><th>说明</th><th>关联</th>';
    var kw = state.search.trim().toLowerCase();
    var filtered = recs.filter(function (r) {
      if (state.recordKind !== 'all' && r.type !== state.recordKind) return false;
      if (kw) {
        var hay = JSON.stringify(r.raw).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
    $('traceCount').textContent = '共 ' + filtered.length + ' 条（该站当日原始记录 ' + recs.length + ' 条）';
    var tb = $('traceTable').querySelector('tbody'); tb.innerHTML = '';
    filtered.slice(0, 400).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = r.cells.map(function (c) { return '<td class="mono">' + c + '</td>'; }).join('');
      tb.appendChild(tr);
    });
    if (filtered.length > 400) {
      var more = document.createElement('tr');
      more.innerHTML = '<td colspan="6" style="text-align:center;color:var(--text-muted)">仅展示前 400 条，请用筛选缩小范围</td>';
      tb.appendChild(more);
    }
    if (!filtered.length) {
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">无匹配记录</td></tr>';
    }
  }

  /* ---------- 总渲染 ---------- */
  function render() {
    var day = getDay(state.stationId, state.date);
    if (!day.active) {
      $('kpiRow').innerHTML = '<div class="kpi"><div class="kpi-label">该站点当日已关停/合并</div><div class="kpi-value" style="font-size:18px">无运营数据</div></div>';
      $('timelineChart').innerHTML = ''; $('hourlyChart').innerHTML = '';
      $('estTable').querySelector('tbody').innerHTML = '<tr><td colspan="8" style="text-align:center">站点当日不活跃</td></tr>';
      $('traceTable').querySelector('tbody').innerHTML = '<tr><td colspan="6" style="text-align:center">站点当日不活跃</td></tr>';
      return;
    }
    renderKpi(day);
    renderTimelinePanel(day);
    renderHourlyPanel(day);
    renderEstimate(day);
    renderPlans();
    renderTrace(day);
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('dateSelect').addEventListener('change', function (e) { state.date = e.target.value; render(); });
    $('stationSelect').addEventListener('change', function (e) { state.stationId = e.target.value; render(); });
    $('metricMode').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn'); if (!btn) return;
      state.metricMode = btn.dataset.mode;
      this.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      render();
    });
    $('planPick').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn'); if (!btn) return;
      if (!btn.classList.contains('plan-toggle')) {
        // 单选基线方案
        state.planBase = btn.dataset.plan;
        this.querySelectorAll(':scope > .seg-btn:not(.plan-toggle)').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      } else {
        // 对比方案 B/C 互斥：始终只有一个处于激活
        state.planComp = btn.dataset.plan;
        this.querySelectorAll('.plan-toggle').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      }
      renderPlans();
    });
    $('recordKind').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn'); if (!btn) return;
      state.recordKind = btn.dataset.kind;
      this.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      renderTrace(getDay(state.stationId, state.date));
    });
    $('traceSearch').addEventListener('input', function (e) {
      state.search = e.target.value; renderTrace(getDay(state.stationId, state.date));
    });
    $('toggleAssumptions').addEventListener('click', function () {
      var ul = $('assumptions'), hidden = ul.hidden;
      ul.hidden = !hidden;
      this.textContent = hidden ? '收起 ▴' : '展开全部 ▾';
    });
    $('themeToggle').addEventListener('click', function () {
      var root = document.documentElement;
      var cur = root.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
      render(); // 重绘图表以读取新主题色
    });
    window.addEventListener('resize', function () {
      clearTimeout(window.__rz);
      window.__rz = setTimeout(render, 150);
    });
  }

  initFilters();
  bind();
  render();
})();
