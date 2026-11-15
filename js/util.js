/* 通用工具：时间模型、随机数、格式化、站点版本查询
 * 时间一律用“绝对分钟数”表示：自 2026-11-09 00:00 起的分钟偏移，
 * 避免 Date/时区带来的歧义。 */
(function (global) {
  'use strict';

  var START_DATE = '2026-11-09';
  var DATES = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
  var FOCUS_DATE = '2026-11-12';
  var WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var DAY_MINUTES = 1440;
  var WINDOW_START = 360;  // 06:00
  var WINDOW_END = 1380;   // 23:00
  var GRID_STEP = 5;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // 'YYYY-MM-DD' -> 自起始日的天数
  function dateIndex(date) {
    var p = date.split('-').map(Number);
    var base = START_DATE.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var b = new Date(base[0], base[1] - 1, base[2]);
    return Math.round((d - b) / 86400000);
  }

  function absMinute(date, hm) {
    var hhmm = hm.split(':').map(Number);
    return dateIndex(date) * DAY_MINUTES + hhmm[0] * 60 + hhmm[1];
  }

  function dayOf(abs) { return Math.floor(abs / DAY_MINUTES); }
  function localOf(abs) { return ((abs % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES; }
  function dateOf(abs) { return DATES[dayOf(abs)]; }
  function hourOf(abs) { return Math.floor(localOf(abs) / 60); }

  function hm(abs) {
    var m = localOf(abs);
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  function full(abs) {
    return dateOf(abs).slice(5).replace('-', '/') + ' ' + hm(abs);
  }
  function weekdayCN(date) {
    var p = date.split('-').map(Number);
    return WEEKDAYS_CN[new Date(p[0], p[1] - 1, p[2]).getDay()];
  }
  function dateLabel(date) { return date + ' ' + weekdayCN(date); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  // 可种子化随机数（mulberry32），保证合成数据可复现
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(rng, lambda) {
    if (lambda <= 0) return 0;
    var L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  // 取站点在某日期生效的版本（容量/合并/关停按生效时间计算）
  function versionAt(station, date) {
    var di = dateIndex(date);
    var cur = null;
    station.versions.forEach(function (v) {
      if (dateIndex(v.effectiveDate) <= di) cur = v;
    });
    return cur;
  }
  function isActive(station, date) {
    var v = versionAt(station, date);
    return !!(v && v.active);
  }
  function capacityAt(station, date) {
    return versionAt(station, date).capacity;
  }

  global.Util = {
    START_DATE: START_DATE, DATES: DATES, FOCUS_DATE: FOCUS_DATE,
    DAY_MINUTES: DAY_MINUTES, WINDOW_START: WINDOW_START, WINDOW_END: WINDOW_END,
    GRID_STEP: GRID_STEP, WEEKDAYS_CN: WEEKDAYS_CN,
    dateIndex: dateIndex, absMinute: absMinute, dayOf: dayOf, localOf: localOf,
    dateOf: dateOf, hourOf: hourOf, hm: hm, full: full,
    weekdayCN: weekdayCN, dateLabel: dateLabel,
    clamp: clamp, round1: round1, round2: round2,
    mulberry32: mulberry32, poisson: poisson,
    versionAt: versionAt, isActive: isActive, capacityAt: capacityAt
  };
})(typeof window !== 'undefined' ? window : globalThis);
