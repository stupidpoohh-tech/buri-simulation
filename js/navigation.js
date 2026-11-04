/*
 * 화면 전환 (대시보드 / 조건 설정 / 상세 내역)
 * 주소 해시(#dashboard, #settings, #detail, #detail/monthly …)로 화면을 바꿉니다.
 * 입력값·계산 상태는 app.js가 하나만 관리하므로, 화면을 바꿔도 값은 그대로 유지됩니다.
 */
(function () {
  'use strict';
  var VIEWS = { dashboard: '대시보드', settings: '조건 설정', detail: '상세 내역' };
  var links = Array.prototype.slice.call(document.querySelectorAll('.side-nav [data-view]'));
  var current = null;
  var scrollMemo = {};

  function parse() {
    var h = (location.hash || '').replace(/^#/, '');
    var parts = h.split('/');
    var view = VIEWS[parts[0]] ? parts[0] : 'dashboard';
    return { view: view, sub: parts[1] || '' };
  }

  function apply() {
    var r = parse();
    var prev = current;
    if (prev && prev !== r.view) scrollMemo[prev] = window.scrollY;
    current = r.view;
    document.querySelectorAll('[data-view-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-view-panel') !== r.view; });
    links.forEach(function (a) {
      var on = a.getAttribute('data-view') === r.view;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var eb = document.getElementById('viewEyebrow');
    if (eb) eb.textContent = '사업 계획 / ' + VIEWS[r.view];
    document.body.setAttribute('data-view', r.view);
    document.dispatchEvent(new CustomEvent('buri:viewchange', { detail: { view: r.view, sub: r.sub, prev: prev } }));

    if (r.sub) {
      var target = document.getElementById('sec-' + r.sub);
      if (target) {
        requestAnimationFrame(function () {
          target.scrollIntoView({ block: 'start' });
          target.focus({ preventScroll: true });
        });
        return;
      }
    }
    if (prev !== null && prev !== r.view) {
      var y = scrollMemo[r.view] || 0;
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    }
  }

  window.addEventListener('hashchange', apply);
  window.BuriNav = {
    current: function () { return current || parse().view; },
    go: function (view, sub) {
      var h = '#' + view + (sub ? '/' + sub : '');
      if (location.hash === h) apply(); else location.hash = h;
    }
  };
  apply();
})();
