/* 轻量 DOM stub：验证 app.js 在无浏览器环境下的渲染逻辑与数据绑定。
 * 不实现完整布局，只提供 app.js/charts.js 用到的 API。 */
'use strict';

function makeNode(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [], attributes: {},
    style: { setProperty: function (k, v) { this[k] = v; } }, dataset: {},
    classList: {
      _set: new Set(),
      add: function (c) { this._set.add(c); },
      remove: function (c) { this._set.delete(c); },
      toggle: function (c, force) {
        var has = this._set.has(c);
        var on = force === undefined ? !has : force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains: function (c) { return this._set.has(c); }
    },
    _text: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    _html: '',
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild: function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    setAttribute: function (k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); },
    getAttribute: function (k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; },
    addEventListener: function (ev, fn) { (this._listeners || (this._listeners = {}))[ev] = fn; },
    dispatch: function (ev, payload) { var fn = this._listeners && this._listeners[ev]; if (fn) fn(payload || { target: this, closest: function () { return null; } }); },
    querySelector: function (sel) {
      if (sel === 'tbody' || sel === 'thead') {
        var want = sel === 'tbody' ? 'TBODY' : 'THEAD';
        var found = null;
        (function walk(node) {
          if (found) return;
          node.children.forEach(function (c) {
            if (found) return;
            if (c.tagName === want) { found = c; return; }
            walk(c);
          });
        })(this);
        if (found) return found;
        // 无静态子节点时创建并挂载，保证 app.js 反复查询拿到同一稳定对象
        var created = makeNode(want);
        this.appendChild(created);
        return created;
      }
      return makeNode(sel.replace(/[.<>#]/g, ''));
    },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 1120, height: 380 }; },
    get offsetWidth() { return 200; }, get offsetHeight() { return 100; },
    get firstChild() { return this.children[0] || null; },
    clientWidth: 1120
  };
}

var ids = {};
function ensure(id) { if (!ids[id]) ids[id] = makeNode('div'); return ids[id]; }

global.document = {
  getElementById: function (id) { return ensure(id); },
  createElement: function (tag) { return makeNode(tag); },
  createTextNode: function (text) { var n = makeNode('#text'); n._text = String(text); return n; },
  createElementNS: function (ns, tag) { var n = makeNode(tag); n.namespaceURI = ns; return n; },
  documentElement: makeNode('html'),
  querySelector: function () { return makeNode('root'); }
};
global.window = global;
global.getComputedStyle = function () {
  return { getPropertyValue: function (name) {
    var map = { '--series-1': '#2a78d6', '--series-2': '#eb6834', '--series-3': '#1baf7a',
      '--series-4': '#6250d6', '--surface-1': '#fcfcfb', '--full': '#eda100' };
    return map[name] || '#888';
  } };
};
global.matchMedia = undefined;
window.matchMedia = function () { return { matches: false }; };
window.addEventListener = function () {};
window.__rz = null;

require('../js/util.js');
require('../js/stations.js');
require('../js/synthetic.js');
require('../js/engine.js');
var U = global.Util, D = global.SyntheticData, E = global.Engine;
require('../js/charts.js');

var errors = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name);
  else { errors++; console.error('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

// app.js 用 IIFE 立即执行，包一层捕获
try {
  require('../js/app.js');
  check('app.js 初始化无异常', true);
} catch (e) {
  errors++;
  console.error('  FAIL app.js 初始化抛异常:', e.stack);
  process.exit(1);
}

check('KPI 卡片已渲染（8 张）', ids.kpiRow.children.length === 8, ids.kpiRow.children.length);
check('时间线 SVG 有子节点', ids.timelineChart.children.length > 10, ids.timelineChart.children.length);
check('小时柱状 SVG 有子节点', ids.hourlyChart.children.length > 10, ids.hourlyChart.children.length);
check('方案对比 SVG 有子节点', ids.planCompareChart.children.length > 5, ids.planCompareChart.children.length);
check('估算点估计已写入', ids.estPoint._text !== '' && ids.estPoint._text !== '—', ids.estPoint._text);
check('估算范围已写入', ids.estRange._html.indexOf('不确定范围') >= 0);
check('估算明细表有行', ids.estTable.querySelector('tbody').children.length >= 1);
check('方案表有行', ids.planTable.querySelector('tbody').children.length >= 6);
check('追溯表有行', ids.traceTable.querySelector('tbody').children.length >= 1);
check('追溯计数已写入', ids.traceCount._text.indexOf('共') >= 0, ids.traceCount._text);
check('假设说明已填充', ids.assumptions.children.length === D.meta.assumptions.length);
check('日期下拉有选项', ids.dateSelect.children.length === 4);
check('站点下拉有选项', ids.stationSelect.children.length === 5);
check('图例已渲染', ids.stateLegend.children.length === 6);

// 模拟切换站点到 ST04（关停日）与切换口径
ids.stationSelect.value = 'ST04';
ids.dateSelect.value = '2026-11-10';
try {
  ids.stationSelect.dispatch('change');
  ids.dateSelect.dispatch('change');
  check('切换到关停站点 ST04 不报错', true);
} catch (e) { errors++; console.error('  FAIL 切换关停站点:', e.stack); }

// 切回正常站点，切换 naive 口径
ids.stationSelect.value = 'ST01'; ids.dateSelect.value = D.meta.focusDate;
ids.stationSelect.dispatch('change'); ids.dateSelect.dispatch('change');
try {
  var naiveBtn = makeNode('button'); naiveBtn.dataset = { mode: 'naive' };
  ids.metricMode.dispatch('click', { target: naiveBtn, closest: function () { return naiveBtn; } });
  check('切换校正前口径不报错', true);
} catch (e) { errors++; console.error('  FAIL naive 切换:', e.stack); }

// 模拟追溯搜索
ids.traceSearch.value = 'DP';
try { ids.traceSearch.dispatch('input'); check('追溯搜索不报错', true); }
catch (e) { errors++; console.error('  FAIL 搜索:', e.stack); }

console.log(errors === 0 ? '\nDOM 渲染验证全部通过 ✔' : '\n有 ' + errors + ' 项失败 ✘');
process.exit(errors === 0 ? 0 : 1);
