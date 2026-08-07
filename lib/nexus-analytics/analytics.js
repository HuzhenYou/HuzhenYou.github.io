/**
 * NEXUS 轻量站点统计埋点（配套后端 src/common/server/analytics/）
 *
 * 用法（静态站，body 末尾）：
 *   <script src="/lib/nexus-analytics/analytics.js" defer></script>
 *   <script>NexusAnalytics.init({ apiBase: 'https://example.com/api/analytics' });</script>
 *
 * 行为：
 * - 页面加载：上报 pv（path/referrer/visit_id）
 * - 页面隐藏或离开：sendBeacon 上报本次停留毫秒数（取最长一次，后端只增不减）
 * - 站长排除：localStorage 里有 nexus_analytics_ignore=1 则整页不上报
 *   （站长看板登录成功时会种下这个标记，站长自己刷博客不污染数据）
 * - 任何失败静默，绝不影响宿主页面
 */
(function (global) {
  'use strict';

  var IGNORE_KEY = 'nexus_analytics_ignore';

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'v-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 12);
  }

  function normalizePath(p) {
    p = (p || '/').split('?')[0].split('#')[0];
    if (p.slice(-10) === 'index.html') p = p.slice(0, -10);
    if (p.slice(-1) !== '/') p += '/';
    return p;
  }

  function init(opts) {
    if (!opts || !opts.apiBase) return;
    try {
      if (localStorage.getItem(IGNORE_KEY) === '1') return;
    } catch (e) { /* localStorage 不可用则照常统计 */ }

    var api = opts.apiBase.replace(/\/$/, '') + '/collect';
    var visitId = uuid();
    var startAt = Date.now();
    var sent = false;

    try {
      fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          type: 'pv',
          visit_id: visitId,
          path: normalizePath(location.pathname),
          referrer: document.referrer || '',
        }),
      }).catch(function () {});
    } catch (e) { /* 静默 */ }

    function reportLeave() {
      var duration = Date.now() - startAt;
      if (duration < 500) return; // 秒开秒关不算停留
      sent = true;
      var payload = JSON.stringify({
        type: 'leave', visit_id: visitId, duration_ms: duration,
      });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            api, new Blob([payload], { type: 'application/json' })
          );
        } else {
          fetch(api, {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }).catch(function () {});
        }
      } catch (e) { /* 静默 */ }
    }

    // visibilitychange(hidden) 覆盖移动端切后台；pagehide 覆盖关页/跳转。
    // 可能都触发——后端按 visit_id 只增不减，多报无害。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') reportLeave();
    });
    global.addEventListener('pagehide', reportLeave);
  }

  var api = { init: init, IGNORE_KEY: IGNORE_KEY };
  global.NexusAnalytics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
