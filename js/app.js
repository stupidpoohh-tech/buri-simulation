/*
 * 화면 연결: 입력 → 상태(state) → BuriCalc.simulate() → 대시보드·조건 설정·상세 내역
 * 계산은 calc.js 하나만 사용하고, 입력 상태도 하나만 둡니다.
 * 같은 값을 여러 화면에 보여주는 입력칸은 data-path가 같으며, 한 곳을 고치면 나머지도 함께 갱신됩니다.
 */
(function () {
  'use strict';
  var P = window.BuriProducts, C = window.BuriCalc, S = window.BuriState;
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }

  var loaded = S.load(storage);
  var state = loaded.state;
  var undoState = null;
  var baseline = null;      // ‘직전 조건 대비’ 비교 기준 (확정된 입력 기준)
  // 저장값을 읽지 못했으면 사용자가 고를 때까지 자동 저장을 멈춤 (원본을 덮어쓰지 않기 위함)
  var saveBlocked = loaded.status === 'failed';
  var canStore = (function () {
    if (!storage) return false;
    try { storage.setItem('buri-sim:probe', '1'); storage.removeItem('buri-sim:probe'); return true; } catch (e) { return false; }
  })();
  var RATE_DEFAULT = { 'scenarioRates.low': 75, 'scenarioRates.base': 100, 'scenarioRates.high': 125 };

  /* ================= 표시 형식 (최종 단계에서만 반올림) ================= */
  var MINUS = '−';
  function fmtInt(n) {
    n = Math.round(C.num(n));
    if (n === 0) return '0';
    return (n < 0 ? MINUS : '') + Math.abs(n).toLocaleString('ko-KR');
  }
  function won(n) { return fmtInt(n) + '원'; }
  function box(n) { return fmtInt(n) + '상자'; }
  function pct(x) { return (C.num(x) * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%'; }
  /** 읽기 쉬운 단위: 5,000원 / 1,200만 원 / 337.5만 원 / 1억 350만 원 */
  function man(n, opts) {
    opts = opts || {};
    n = Math.round(C.num(n));
    var sign = n < 0 ? MINUS : (opts.plus && n > 0 ? '+' : '');
    var a = Math.abs(n);
    if (a === 0) return '0원';
    if (a < 10000) return sign + a.toLocaleString('ko-KR') + '원';
    var eok = Math.floor(a / 1e8);
    var rest = Math.round((a - eok * 1e8) / 1e4 * 10) / 10;
    if (rest >= 10000) { eok += 1; rest = 0; }
    var restStr = rest ? rest.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '만' : '';
    if (eok) return sign + eok.toLocaleString('ko-KR') + '억' + (restStr ? ' ' + restStr : '') + ' 원';
    return sign + restStr + ' 원';
  }
  function manShort(n) { return man(n).replace(' 원', ''); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** 손익 금액: 음수면 적색(손실) */
  function pl(n, txt) { return '<span class="' + (Math.round(n) < 0 ? 'loss' : '') + '">' + (txt || won(n)) + '</span>'; }
  /** 현금 금액: 음수면 회수 전 색 — 손실과 구분 */
  function cash(n, txt) { return '<span class="' + (Math.round(n) < 0 ? 'cashneg' : '') + '">' + (txt || won(n)) + '</span>'; }
  function paybackText(r) {
    if (r.paybackMonth === 0) return '투입 없음';
    if (r.paybackMonth === null) return '기간 내 미회수';
    return r.paybackMonth + '개월 차';
  }

  /* ================= 상태 경로 ================= */
  function getPath(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  function setPath(obj, path, val) {
    var ks = path.split('.'), o = obj;
    for (var i = 0; i < ks.length - 1; i++) {
      if (o[ks[i]] == null) o[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
      o = o[ks[i]];
    }
    o[ks[ks.length - 1]] = val;
  }

  /* ================= 판매계획 해석 ================= */
  function salesPlanInfo(r) {
    var ov = [];
    for (var i = 0; i < r.months; i++) { var v = state.overrides[i]; if (v !== null && v !== undefined) ov.push(i); }
    return {
      ov: ov, base: C.roundQty(C.baseMonthlyPlan(state)), channel: state.salesMode === 'channel',
      allOverridden: ov.length === r.months, partial: ov.length > 0 && ov.length < r.months, planned: r.totals.planned
    };
  }
  var OPT_LABEL = { commissionRate: '판매 수수료', extraSellingCost: '상자당 추가 판매비', oneTimeCost: '초기 일회성 비용', monthlyFixed: '월 고정비' };
  function costScope() {
    var missing = S.OPTIONAL.filter(function (k) { return state[k] === null; });
    var applied = [];
    if (state.commissionRate !== null) applied.push('수수료 ' + (+state.commissionRate).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '%');
    if (state.extraSellingCost !== null) applied.push('추가 판매비 상자당 ' + won(state.extraSellingCost));
    if (state.oneTimeCost !== null) applied.push('초기비용 ' + man(state.oneTimeCost) + (state.oneTimeSource === 'example' ? '(예시값)' : ''));
    if (state.monthlyFixed !== null) applied.push('월 고정비 ' + man(state.monthlyFixed));
    var n = missing.length, title;
    if (n === 4) title = '추가 비용 반영 전 · 미입력 비용 4개';
    else if (n > 0) title = '입력한 비용 반영 · 미입력 비용 ' + n + '개';
    else title = '추가 비용 4개 반영';
    return { missing: missing, applied: applied, n: n, title: title };
  }

  /* ================= 입력 처리 ================= */
  function parseInput(raw, kind) {
    var t = String(raw).replace(/[,\s원%]/g, '').replace(/[−–]/g, '-');
    if (t === '') return { empty: true };
    if (!/^-?\d*\.?\d*$/.test(t) || t === '-' || t === '.') return { invalid: true };
    var n = Number(t);
    if (!isFinite(n)) return { invalid: true };
    if (kind !== 'signed' && n < 0) return { invalid: true, msg: '0 이상으로 입력해 주세요.' };
    return { value: n };
  }
  function displayValue(v, kind) {
    if (v === null || v === undefined || v === '') return '';
    if (kind === 'text') return v;
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '';
  }
  function setMsg(path, text) { $$('[data-msg="' + path + '"]').forEach(function (el) { el.textContent = text || ''; }); }
  /** 같은 값을 보여주는 다른 입력칸을 맞춤 (입력 중인 칸은 건드리지 않음) */
  function syncPath(path, src) {
    $$('[data-path="' + path + '"]').forEach(function (el) {
      if (el === src || el.type === 'radio') return;
      el.value = displayValue(getPath(state, path), el.getAttribute('data-kind'));
      el.removeAttribute('aria-invalid');
    });
  }

  function onInput(e) {
    var el = e.target, path = el.getAttribute && el.getAttribute('data-path');
    if (!path) return;
    var kind = el.getAttribute('data-kind');
    if (kind === 'radio') {
      if (!el.checked) return;
      setPath(state, path, el.value);
      $$('input[type=radio][data-path="' + path + '"]').forEach(function (r) { r.checked = r.value === el.value; });
      commit();
      return;
    }
    if (kind === 'text') { setPath(state, path, el.value); syncPath(path, el); commit(); return; }
    var p = parseInput(el.value, kind);
    el.removeAttribute('aria-invalid');
    setMsg(path, '');
    if (p.invalid) {
      el.setAttribute('aria-invalid', 'true');
      setMsg(path, p.msg || '숫자만 입력해 주세요. 이 값은 반영되지 않았습니다.');
      return;
    }
    var v;
    if (p.empty) {
      // 빈칸은 0으로 바꾸지 않고 ‘미입력’으로 둠 (시나리오 비율만 일반 기본값)
      v = kind === 'rate' ? RATE_DEFAULT[path] : null;
    } else {
      v = p.value;
      if (kind === 'int') v = Math.floor(v);
      if (kind === 'months') {
        var m = C.clampMonths(v);
        if (m !== v) setMsg(path, '1~60개월 범위로 맞춰 ' + m + '개월로 계산합니다.');
        v = m;
      }
    }
    var prev = getPath(state, path);
    setPath(state, path, v);
    if (path === 'oneTimeCost') state.oneTimeSource = v === null ? null : 'user';
    // 원가·납품가를 입력하면 그 수량 기준의 단가로 봄
    if (path === 'price' || path === 'quoteCost' || /^costItems\.\d+\.amount$/.test(path)) state.pricingBasisQty = state.quantity;
    syncPath(path, el);
    commit({ monthsChanged: path === 'months' && prev !== v });
  }

  // 입력 확정(change) 시에만 ‘직전 조건 대비’ 변화를 계산 — 입력 도중 값은 비교 기준으로 쓰지 않음
  function onChange(e) {
    var el = e.target;
    if (el.id === 'q-preset') { if (el.value) applyUserPresetId(el.value); el.value = ''; return; }
    if (el.id === 'importFile') return onImportFile(el);
    if (!el.getAttribute('data-path')) return;
    if (el.getAttribute('data-kind') === 'radio') onInput(e);
    if (el.getAttribute('aria-invalid') === 'true') return;
    confirmChange();
  }
  function onBlur(e) {
    var el = e.target, kind = el.getAttribute && el.getAttribute('data-kind');
    if (!kind || kind === 'text' || kind === 'radio' || el.getAttribute('aria-invalid') === 'true') return;
    el.value = displayValue(getPath(state, el.getAttribute('data-path')), kind);
  }

  /* ================= 입력칸 채우기 ================= */
  function fillInputs() {
    renderUserPresets();
    renderCostItems();
    renderOverrides();
    $$('[data-path]').forEach(function (el) {
      var path = el.getAttribute('data-path'), kind = el.getAttribute('data-kind');
      var v = getPath(state, path);
      if (kind === 'radio') el.checked = (el.value === v);
      else if (document.activeElement !== el) el.value = displayValue(v, kind);
      el.removeAttribute('aria-invalid');
    });
    $$('[data-msg]').forEach(function (el) { el.textContent = ''; });
  }
  /** 사용자가 직접 저장한 생산 조건 (공개 프리셋 대신) */
  function presetSummary(p) {
    var cost = p.costMode === 'quote' ? p.quoteCost : C.unitCost({ costMode: 'itemized', costItems: p.costItems });
    return (p.quantity !== null ? box(p.quantity) : '수량 미입력') + ' · 원가 ' + (p.costMode === 'quote' && p.quoteCost === null ? '미입력' : won(cost)) + ' · 납품가 ' + (p.price !== null ? won(p.price) : '미입력');
  }
  function renderUserPresets() {
    var list = state.userPresets || [];
    $('#userPresets').innerHTML = list.length ? list.map(function (p) {
      return '<div class="upreset"><div><strong>' + esc(p.label) + '</strong><span>' + esc(presetSummary(p)) + '</span></div>' +
        '<button type="button" class="btn btn--small btn--line" data-apply-preset="' + esc(p.id) + '">적용</button>' +
        '<button type="button" class="icon-btn" data-del-preset="' + esc(p.id) + '" aria-label="' + esc(p.label) + ' 삭제">×</button></div>';
    }).join('') : '<p class="hint">아직 저장한 조건이 없습니다.</p>';
    $('#q-preset').innerHTML = '<option value="">저장한 조건 불러오기</option>' + list.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>'; }).join('');
    $('#qPresetItem').hidden = !list.length;
  }
  function renderCostItems() {
    $('#costItems').innerHTML = state.costItems.map(function (it, i) {
      return '<div class="item">' +
        '<input class="in item__name" type="text" maxlength="40" data-path="costItems.' + i + '.name" data-kind="text" aria-label="원가 항목 ' + (i + 1) + ' 이름" placeholder="항목 이름">' +
        '<div class="control"><input class="in num" inputmode="decimal" data-path="costItems.' + i + '.amount" data-kind="money" aria-label="원가 항목 ' + (i + 1) + ' 상자당 금액"><span class="unit">원</span></div>' +
        '<button type="button" class="icon-btn" data-remove-item="' + i + '" aria-label="원가 항목 ' + (i + 1) + ' 삭제">×</button></div>';
    }).join('') || '<p class="hint">항목이 없습니다. ‘+ 항목 추가’로 입력하세요.</p>';
  }
  function renderOverrides() {
    var months = state.months ? C.clampMonths(state.months) : 0, html = '';
    if (!months) { $('#monthOverrides').innerHTML = '<p class="hint">판매기간을 먼저 입력하세요.</p>'; return; }
    for (var i = 0; i < months; i++) {
      html += '<label class="month"><span>' + (i + 1) + '개월 차</span><span class="control"><input class="in num" inputmode="numeric" data-path="overrides.' + i + '" data-kind="override" data-override="' + i + '"><span class="unit">상자</span></span></label>';
    }
    $('#monthOverrides').innerHTML = html;
  }

  /* ================= 상태 변경 ================= */
  var saveTimer = null;
  function commit(opts) {
    opts = opts || {};
    if (opts.monthsChanged) {
      var m = state.months ? C.clampMonths(state.months) : 0;
      if (m && state.overrides.length > m) state.overrides = state.overrides.slice(0, m);
      renderOverrides();
      $$('#monthOverrides [data-path]').forEach(function (el) { el.value = displayValue(getPath(state, el.getAttribute('data-path')), 'override'); });
    }
    render();
    clearTimeout(saveTimer);
    if (opts.saveNow) saveNow(); else saveTimer = setTimeout(saveNow, 250);
  }
  /** 저장. 실패하면 저장됐다고 표시하지 않고 설정 파일 보관을 안내 */
  function saveNow() {
    clearTimeout(saveTimer);
    if (saveBlocked) { setSaveState('blocked'); return false; }
    var at = canStore ? S.save(storage, state) : null;
    setSaveState(at ? 'saved' : 'failed', at);
    return !!at;
  }
  function setSaveState(kind, at) {
    var el = $('#saveState');
    el.classList.toggle('is-warn', kind === 'blocked' || kind === 'failed');
    if (kind === 'saved') el.innerHTML = '이 브라우저에 자동 저장됩니다 · 저장됨 ' + timeText(at);
    else if (kind === 'idle') el.innerHTML = '이 브라우저에 자동 저장됩니다';
    else if (kind === 'restored') el.innerHTML = '이 브라우저에 자동 저장됩니다 · 복원됨' + (at ? ' ' + timeText(at) : '');
    else if (kind === 'blocked') el.innerHTML = '자동 저장 멈춤 — 저장값 복원 방법을 선택하세요';
    else el.innerHTML = '저장되지 않음 — <button type="button" class="link" data-action="export">내보내기</button>로 설정 파일을 보관하세요';
  }
  function timeText(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- 직전 조건 대비 (핵심 지표별) ---------- */
  function keyMetrics() {
    if (S.missingRequired(state).length) return null;
    var r = C.simulate(state);
    return { profit: r.periodProfit, funding: r.initialFunding, payback: r.paybackMonth };
  }
  function confirmChange() {
    var cur = keyMetrics();
    if (baseline && cur) showDelta(baseline, cur);
    else $$('.kpi__delta').forEach(function (el) { el.hidden = true; });
    baseline = cur;
  }
  function showDelta(a, b) {
    var d = {};
    var dp = Math.round(b.profit) - Math.round(a.profit);
    if (dp !== 0) d.profit = [man(dp, { plus: true }), dp > 0];
    var df = Math.round(b.funding) - Math.round(a.funding);
    if (df !== 0) d.funding = [man(df, { plus: true }), df < 0];
    if (a.payback !== b.payback) {
      var t, good;
      if (a.payback === null) { t = b.payback === 0 ? '투입 없음' : b.payback + '개월 차 회수로 바뀜'; good = true; }
      else if (b.payback === null) { t = '기간 내 미회수로 바뀜'; good = false; }
      else if (b.payback > a.payback) { t = (b.payback - a.payback) + '개월 늦어짐'; good = false; }
      else { t = (a.payback - b.payback) + '개월 빨라짐'; good = true; }
      d.payback = [t, good];
    }
    var any = Object.keys(d).length > 0;
    ['funding', 'profit', 'payback'].forEach(function (k) {
      var el = $('[data-delta="' + k + '"]');
      if (!any) { el.hidden = true; return; }
      if (!d[k]) { el.hidden = true; return; }
      el.innerHTML = '<span class="kpi__delta-l">직전 조건 대비</span> <span class="' + (d[k][1] ? 'up' : 'down') + '">' + (d[k][1] ? '▲ ' : '▼ ') + d[k][0] + '</span>';
      el.hidden = false;
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    });
  }

  /* ================= 결과 렌더링 ================= */
  function out(name, html) { $$('[data-out="' + name + '"]').forEach(function (el) { el.innerHTML = html; }); }
  /** 현재 계획을 한 줄로: 판매 상황 · 회수 · 손익 · 비용 반영 범위 */
  function statusSentence(r, cs) {
    var parts = [];
    if (r.quantity === 0) parts.push('생산수량 0상자');
    else if (r.totals.excess > 0) parts.push('<span class="st-warn">판매계획이 생산량 초과 · ' + box(r.totals.excess) + ' 미반영</span>');
    else if (r.totals.sold === 0) parts.push('<span class="st-warn">판매 없음 · 재고 ' + box(r.endingInventory) + '</span>');
    else if (r.endingInventory === 0) parts.push('전량 판매 계획');
    else parts.push('일부 판매 · 재고 ' + box(r.endingInventory) + ' 남음');
    if (r.paybackMonth === null) parts.push('<span class="st-cash">기간 내 투입금 미회수</span>');
    else if (r.paybackMonth > 0) parts.push('기간 내 투입금 회수 (' + r.paybackMonth + '개월 차)');
    if (r.periodProfit < -0.5) parts.push('<span class="st-loss">기간 손실 예상</span>');
    if (r.maxFunding > r.initialFunding + 0.5) parts.push('<span class="st-cash">추가 자금 필요</span>');
    parts.push(cs.n === 4 ? '<span class="st-missing">추가 비용 반영 전</span>' : cs.n ? '<span class="st-missing">미입력 비용 ' + cs.n + '개</span>' : '추가 비용 반영');
    return parts.join(' · ');
  }

  var lastR = null;
  var cashMode = 'cumulative', stockMode = 'sales';
  function render() {
    var r = C.simulate(state);
    var miss = S.missingRequired(state);
    var ready = !miss.length;
    lastR = ready ? r : null;
    var sp = salesPlanInfo(r);
    var cs = costScope();

    /* --- 제목: 서비스 이름은 고정, 제품명·계획 이름은 사용자가 입력한 내용 --- */
    $('#pageTitle').textContent = 'BURI시뮬레이션';
    document.title = 'BURI시뮬레이션';
    var names = [(state.productName || '').trim(), (state.planName || '').trim()].filter(Boolean);
    $('#planName').innerHTML = (state.example ? '<span class="chip-example">가상 예시</span> ' : '') +
      (names.length ? esc(names.join(' · ')) : '<span class="muted">제품명·계획 이름 미입력</span>');

    /* --- 상단 조건 바 --- */
    var itemized = state.costMode === 'itemized';
    $('#qCostWrap').hidden = itemized;
    $('#qCostFixed').hidden = !itemized;
    if (itemized) {
      var hasItems = state.costItems.some(function (it) { return it.amount !== null && it.amount !== undefined; });
      $('#qCostFixed').innerHTML = (hasItems ? '항목 합계 ' + won(C.unitCost(state)) : '<span class="muted">항목 미입력</span>') + ' <button type="button" class="link" data-drawer-focus="#costItemized">' + (hasItems ? '수정' : '입력') + '</button>';
    }
    var fixed = $('#qSalesFixed'), commonWrap = $('#qCommonWrap');
    var showFixed = sp.allOverridden || sp.channel;
    commonWrap.hidden = showFixed; fixed.hidden = !showFixed;
    $('#qSalesLabel').textContent = sp.partial && !sp.channel ? '나머지 월 판매' : '월 판매';
    if (sp.allOverridden) fixed.innerHTML = '월별 판매계획 적용 <small>총 ' + box(sp.planned) + '</small> <button type="button" class="link" data-drawer-focus="#sgMonthly">수정</button>';
    else if (sp.channel) fixed.innerHTML = '판매처 기준 월 ' + box(sp.base) + (sp.ov.length ? ' <small>+ ' + sp.ov.length + '개월 수정</small>' : '') + ' <button type="button" class="link" data-drawer-focus="#sgSales">수정</button>';
    else if (sp.partial) fixed.hidden = false, fixed.innerHTML = '<small>' + sp.ov.length + '개월 별도 수정</small> <button type="button" class="link" data-drawer-focus="#sgMonthly">수정</button>';
    $('#priceCheck').hidden = !(state.pricingBasisQty !== null && state.quantity !== null && state.quantity !== state.pricingBasisQty);
    out('periodLabel', state.months ? r.months + '개월 계획' : '기간 미입력');
    out('scopeTag', '<button type="button" class="scope-tag ' + (cs.n ? 'is-missing' : 'is-ok') + '" data-drawer-focus="' + (cs.n ? '#f-' + cs.missing[0] : '#sgCost') + '" title="' + esc(cs.n ? '계산에서 빠진 비용: ' + cs.missing.map(function (k) { return OPT_LABEL[k]; }).join(', ') : '반영: ' + cs.applied.join(', ')) + '">' +
      (cs.n === 4 ? '추가 비용 반영 전' : cs.n ? '미입력 비용 ' + cs.n + '개' : '추가 비용 반영') + '</button>');
    renderSettings(r, sp, cs);
    if (!ready) { renderNotReady(miss, cs); return; }

    /* --- 상태 요약 한 줄 (계산 결과에서 만듦) --- */
    $('#statusLine').innerHTML = statusSentence(r, cs);

    /* --- 핵심 지표 4개: 읽기 쉬운 단위, 정확한 금액은 툴팁 --- */
    out('fundingMan', man(r.initialFunding));
    $('[data-out=fundingMan]').title = '정확한 금액 ' + won(r.initialFunding);
    out('fundingSub', r.maxFunding > r.initialFunding + 0.5
      ? '<span class="flag flag--cash">추가 자금</span>' + r.maxFundingMonth + '개월 차까지 최대 ' + man(r.maxFunding) + ' 필요'
      : '기간 중 추가 자금 필요 없음');
    out('profitLabel', r.months + '개월 예상 이익');
    out('profitMan', man(r.periodProfit));
    $('[data-out=profitMan]').title = '정확한 금액 ' + won(r.periodProfit);
    var profitSub = '월평균 ' + pl(r.avgMonthlyProfit, man(r.avgMonthlyProfit)) + ' · 세금 차감 전';
    if (r.unitMargin < -0.5) profitSub = '<span class="flag flag--loss">적자 구조</span>상자당 ' + won(-r.unitMargin) + ' 손실';
    else if (r.periodProfit < -0.5) profitSub = '<span class="flag flag--loss">손실</span>' + profitSub;
    else if (cs.n) profitSub += ' · ' + (cs.n === 4 ? '수수료·배송비·고정비 미반영' : '일부 비용 미반영');
    out('profitSub', profitSub);
    out('paybackBig', paybackText(r));
    out('paybackSub', r.paybackMonth === null ? '기간 말까지 누적 현금이 0원에 못 미침' : r.paybackMonth === 0 ? '투입 자금 없음' : '누적 현금이 0원 이상이 되는 달');
    out('stockBig', box(r.endingInventory));
    out('stockSub', '생산 ' + fmtInt(r.quantity) + ' · 예상 판매 ' + box(r.totals.sold) + (r.totals.excess > 0 ? ' · <span class="loss">계획 ' + fmtInt(r.totals.excess) + '상자 미반영</span>' : ''));
    $('[data-core="profit"]').classList.toggle('is-loss', r.periodProfit < -0.5);
    $('[data-core="payback"]').classList.toggle('is-unrecovered', r.paybackMonth === null);
    $('[data-core="stock"]').classList.toggle('has-stock', r.endingInventory > 0);

    /* --- 모바일 하단 요약 · 패널 요약 --- */
    out('mFunding', man(r.initialFunding));
    out('mProfitLabel', r.months + '개월 이익');
    out('mProfit', pl(r.periodProfit, man(r.periodProfit)));
    out('mPayback', paybackText(r));
    out('drawerSummary', '<span>초기 필요자금 <strong>' + man(r.initialFunding) + '</strong></span><span>' + r.months + '개월 이익 <strong>' + pl(r.periodProfit, man(r.periodProfit)) + '</strong></span><span>회수 <strong>' + paybackText(r) + '</strong></span>');

    $('#overview').classList.remove('is-empty');
    renderCashCard(r);
    renderInvCard(r, sp);
    renderScenarios(r);
    renderPriceCard(r);
    renderDetail(r);
  }

  /* ---------- 기본 조건이 부족할 때: 결과 대신 안내 (빈칸을 0으로 계산하지 않음) ---------- */
  var MISSING_FOCUS = { quantity: '#q-quantity', cost: '#q-quoteCost', price: '#q-price', sales: '#q-commonMonthly', months: '#q-months', channel: '#sgSales' };
  function renderNotReady(miss, cs) {
    var EMPTY = '—';
    var labels = miss.map(function (m) { return m.label; }).join(', ');
    $('#overview').classList.add('is-empty');
    $('#statusLine').innerHTML = '<span class="st-missing">기본 조건을 입력하면 결과가 표시됩니다</span> · 필요: ' + esc(labels) +
      ' <span class="starter-acts"><button type="button" class="btn btn--small" data-action="start">기본 조건 입력</button>' +
      '<button type="button" class="btn btn--small btn--line" data-action="example">예시 체험</button>' +
      '<button type="button" class="btn btn--small btn--line" data-action="import">설정 파일 불러오기</button></span>';
    ['fundingMan', 'profitMan', 'paybackBig', 'stockBig'].forEach(function (k) { out(k, EMPTY); $('[data-out=' + k + ']').removeAttribute('title'); });
    out('profitLabel', (state.months ? C.clampMonths(state.months) + '개월' : '기간') + ' 예상 이익');
    out('fundingSub', '생산수량·원가 입력 후 계산');
    out('profitSub', '기본 조건 입력 후 계산 · 세금 차감 전');
    out('paybackSub', '누적 현금이 0원 이상이 되는 달');
    out('stockSub', '생산수량·판매량 입력 후 계산');
    ['profit', 'payback', 'stock'].forEach(function (k) { $('[data-core="' + k + '"]').classList.remove('is-loss', 'is-unrecovered', 'has-stock'); });
    $$('.kpi__delta').forEach(function (el) { el.hidden = true; });
    var ph = '<p class="chart-empty">기본 조건(' + esc(labels) + ')을 입력하면 표시됩니다.</p>';
    out('cashLead', '<strong class="chart-metric">' + EMPTY + '</strong>');
    $('#cashChart').innerHTML = ph; out('cashCaption', ''); out('cashNote', '');
    $('#scenRows').innerHTML = ph; $('#scenMiniNotes').innerHTML = '';
    out('priceLead', ''); $('#priceBar').innerHTML = ph;
    out('invLead', ''); $('#invChart').innerHTML = ph; out('invCaption', ''); out('invNote', '');
    // 상세 내역
    $('#monthTable tbody').innerHTML = '<tr><td colspan="9" class="empty-cell">' + ph + '</td></tr>'; $('#monthTable tfoot').innerHTML = '';
    out('cashInsight', '기본 조건을 입력하면 월별 판매·자금 회수 내역이 표시됩니다.'); out('reconcile', '');
    $('#scenTable tbody').innerHTML = '<tr><td colspan="4" class="empty-cell">' + ph + '</td></tr>'; $('#scenNotes').innerHTML = '';
    out('scenInsight', '기본 조건을 입력하면 시나리오를 비교합니다.');
    out('rateLow', fmtInt(state.scenarioRates.low) + '%'); out('rateBase', fmtInt(state.scenarioRates.base) + '%'); out('rateHigh', fmtInt(state.scenarioRates.high) + '%');
    out('costInsight', '원가와 납품가를 입력하면 구성이 표시됩니다.'); $('#costBar').innerHTML = '';
    $('#costTable tbody').innerHTML = '<tr><td colspan="4" class="empty-cell">' + ph + '</td></tr>'; $('#costTable tfoot').innerHTML = '';
    $('#targetOut').innerHTML = '<p class="hint">기본 조건을 입력하면 목표 이익에 필요한 판매량을 계산합니다.</p>';
    ['soldXPrice', 'revenue', 'cogs', 'selling', 'fixedTotal', 'oneTime', 'periodProfit', 'avgExact', 'initialCash', 'cashIn', 'endCash', 'maxFunding', 'endInv', 'invCost', 'excessQty'].forEach(function (k) { out(k, EMPTY); });
    out('mFunding', EMPTY); out('mProfit', EMPTY); out('mPayback', EMPTY); out('mProfitLabel', '예상 이익');
    out('drawerSummary', '<span class="st-missing">기본 조건 입력 필요: ' + esc(labels) + '</span>');
  }

  /* ---------- 조건 설정 폼 ---------- */
  function renderSettings(r, sp, cs) {
    $('#costItemized').hidden = state.costMode !== 'itemized';
    $('#costQuote').hidden = state.costMode !== 'quote';
    out('itemsTotal', won(C.unitCost({ costMode: 'itemized', costItems: state.costItems })));
    out('costCountBadge', '');
    var badge = $('[data-out="costCountBadge"]');
    badge.className = 'badge ' + (cs.n ? 'badge--missing' : 'badge--ok');
    badge.textContent = cs.n ? '미입력 ' + cs.n + '개' : '모두 입력';
    out('unitSelling', state.price === null ? '—' : won(r.unitSelling));
    out('unitSellingDesc', '= 납품가 × 수수료율(' + won(r.unitCommission) + ') + 추가 판매비(' + won(r.unitExtraSelling) + ')');
    S.OPTIONAL.forEach(function (k) {
      var b = $('[data-status="' + k + '"]'), v = state[k];
      if (v === null) { b.className = 'badge badge--missing'; b.textContent = '미입력 · 계산 제외'; }
      else if (k === 'oneTimeCost' && state.oneTimeSource === 'example') { b.className = 'badge badge--example'; b.textContent = '이전 버전 예시값 · 확인 필요'; }
      else if (v === 0) { b.className = 'badge badge--ok'; b.textContent = (k === 'commissionRate' ? '0%' : '0원') + ' 확인됨'; }
      else { b.className = 'badge badge--ok'; b.textContent = '입력됨 · 계산 반영'; }
    });
    $('#salesChannel').hidden = !sp.channel;
    $('#salesDirect').hidden = sp.channel;
    var c = state.channel;
    out('channelMonthly', c.stores === null || c.perStorePerDay === null || c.businessDays === null ? '—' : box(sp.base) + '/월');
    var hasBase = sp.channel ? c.stores !== null && c.perStorePerDay !== null && c.businessDays !== null : state.commonMonthly !== null;
    $$('#monthOverrides [data-override]').forEach(function (el) { el.placeholder = hasBase ? fmtInt(sp.base) + ' (공통)' : '미입력'; });
    out('overrideBadge', sp.ov.length ? '<span class="badge badge--info">' + r.months + '개월 중 ' + sp.ov.length + '개월 수정 적용 중</span>' : '');
  }

  /* ---------- 차트 공통 ---------- */
  function niceStep(range, parts) {
    var raw = range / (parts || 4), p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function chartWidth(host) { return Math.max(240, Math.round(host.clientWidth || 640)); }
  /** x축 라벨 선택: 중요 라벨(마지막·회수 시점·시작)을 먼저 두고, 간격이 부족한 라벨은 생략 */
  function pickLabels(n, xOf, must, minGap) {
    var order = must.slice();
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((xOf(n - 1) - xOf(0) + minGap) / minGap))));
    for (var i = 0; i < n; i += every) order.push(i);
    var kept = [];
    order.forEach(function (i) {
      if (i < 0 || i >= n || kept.indexOf(i) >= 0) return;
      if (kept.some(function (k) { return Math.abs(xOf(k) - xOf(i)) < minGap; })) return;
      kept.push(i);
    });
    return kept;
  }
  function roundedBar(x0, y0, w, yy, h, up) {
    var rr = Math.min(4, h / 2, w / 2), x1 = x0 + w;
    if (h < 0.5) return 'M' + x0 + ',' + y0 + 'h' + w;
    if (up) return 'M' + x0 + ',' + y0 + 'V' + (yy + rr) + 'Q' + x0 + ',' + yy + ' ' + (x0 + rr) + ',' + yy + 'H' + (x1 - rr) + 'Q' + x1 + ',' + yy + ' ' + x1 + ',' + (yy + rr) + 'V' + y0 + 'Z';
    return 'M' + x0 + ',' + y0 + 'V' + (yy + h - rr) + 'Q' + x0 + ',' + (yy + h) + ' ' + (x0 + rr) + ',' + (yy + h) + 'H' + (x1 - rr) + 'Q' + x1 + ',' + (yy + h) + ' ' + x1 + ',' + (yy + h - rr) + 'V' + y0 + 'Z';
  }
  function bindTips(host, items, html) {
    var tip = $('#chartTip');
    $$('.hit', host).forEach(function (hEl) {
      var show = function (ev) {
        $$('.hit', host).forEach(function (x) { x.classList.remove('on'); });
        hEl.classList.add('on');
        tip.innerHTML = html(items[+hEl.getAttribute('data-i')]);
        tip.hidden = false;
        var rect = hEl.getBoundingClientRect(), x = (ev && ev.clientX) || rect.left + rect.width / 2;
        tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, x + 12)) + 'px';
        tip.style.top = (rect.top + window.scrollY + 8) + 'px';
      };
      hEl.addEventListener('mousemove', show);
      hEl.addEventListener('click', show);
      hEl.addEventListener('focus', show);
      hEl.addEventListener('blur', function () { tip.hidden = true; hEl.classList.remove('on'); });
      hEl.addEventListener('mouseleave', function () { tip.hidden = true; hEl.classList.remove('on'); });
    });
  }

  /* ---------- 현금 회수: 누적(기본)·월별 전환, 회수 지점 표시 ---------- */
  function renderCashCard(r) {
    var monthly = cashMode === 'monthly';
    $$('[data-cash-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-cash-mode') === cashMode)); });
    var pay = r.paybackMonth;
    var lead;
    if (pay === null) lead = '<strong class="chart-metric is-unrec">기간 내 미회수</strong><span class="chart-context">초기 ' + man(r.initialFunding) + ' 투입 · 기간 말 누적 현금 ' + man(r.endCash) + '</span>';
    else if (pay === 0) lead = '<strong class="chart-metric">투입 자금 없음</strong>';
    else lead = '<strong class="chart-metric">' + pay + '개월 차 회수</strong><span class="chart-context">초기 ' + man(r.initialFunding) + ' 투입 → 누적 현금 0원 이상</span>';
    out('cashLead', lead);
    var notes = [];
    if (r.maxFunding > r.initialFunding + 0.5) notes.push(r.maxFundingMonth + '개월 차 누적 현금이 가장 낮음 · 최대 필요자금 ' + man(r.maxFunding));
    if (r.endingInventory > 0) notes.push('예상 이익과 다른 이유: 남은 재고 ' + box(r.endingInventory) + '의 원가 ' + man(r.inventoryCost) + '는 아직 현금이 아님');
    out('cashNote', notes.join(' · '));
    out('cashCaption', monthly
      ? '그달 현금 유입 − 지출 · 시작 막대는 초기 투입액'
      : '0원 아래는 아직 회수하지 못한 투입금(손실과 다름) · 기간 말 누적 현금 ' + man(r.endCash));

    var host = $('#cashChart');
    var pts = [{ label: '시작', v: r.initialCash, m: 0 }].concat(r.rows.map(function (m) {
      return { label: m.month + '개월', v: monthly ? m.cashFlow : m.cumCash, m: m.month, row: m };
    }));
    var W = chartWidth(host), H = 156, L = 52, R = 12, T = 24, B = 24;
    var vals = pts.map(function (p) { return p.v; });
    var hi = Math.max(0, Math.max.apply(null, vals)), lo = Math.min(0, Math.min.apply(null, vals));
    var step = Math.max(1, niceStep(hi - lo || 1, 3));
    var top = Math.ceil(hi / step) * step, bot = Math.floor(lo / step) * step;
    if (top === bot) top = bot + step;
    var slot = (W - L - R) / pts.length;
    var x = function (i) { return L + slot * (i + .5); };
    var y = function (v) { return T + (top - v) / (top - bot) * (H - T - B); };
    var labels = pickLabels(pts.length, x, [pts.length - 1, 0, pay === null ? -1 : pay], 47);
    var bw = Math.min(22, slot * .52), zero = y(0);
    var name = monthly ? '월별 현금 증감' : '월말 누적 현금';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + name + '. ' + (pay === null ? '기간 내 미회수' : pay > 0 ? pay + '개월 차 회수' : '') + ', 기간 말 누적 현금 ' + won(r.endCash) + '">';
    for (var g = bot; g <= top + step * .001; g += step) {
      var isZero = Math.abs(g) < step * .001;
      svg += '<line class="' + (isZero ? 'cash-zero' : 'grid') + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text class="axis' + (isZero ? ' axis--zero' : '') + '" x="' + (L - 8) + '" y="' + (y(g) + 3) + '" text-anchor="end">' + (isZero ? '0원' : manShort(g)) + '</text>';
    }
    var anchorAt = function (cx) { return cx > W - 60 ? 'end' : cx < L + 40 ? 'start' : 'middle'; };
    pts.forEach(function (p, i) {
      var yy = y(p.v), h = Math.abs(yy - zero);
      if (h > .01) svg += '<path class="cash-column' + (p.v < 0 ? ' is-negative' : '') + '" d="' + roundedBar(x(i) - bw / 2, zero, bw, Math.min(yy, zero), h, p.v >= 0) + '"/>';
      var isPay = pay !== null && pay > 0 && p.m === pay;
      if (labels.indexOf(i) >= 0) {
        svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 7) + '" text-anchor="middle">' + p.label + '</text>';
        if (!isPay && pts.length <= 9 && slot >= 55) svg += '<text class="val" x="' + x(i) + '" y="' + (p.v < 0 ? Math.min(H - B - 3, yy + 12) : yy - 7) + '" text-anchor="middle">' + manShort(p.v) + '</text>';
      }
      svg += '<rect class="hit" data-i="' + i + '" tabindex="0" aria-label="' + (p.m === 0 ? '시작' : p.m + '개월 차') + ' ' + name + ' ' + won(p.v) + '" x="' + (L + slot * i) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '"/>';
    });
    // 회수 지점: 값이 0원이어도 위치가 보이도록 마커로 표시
    if (pay !== null && pay > 0) {
      var px = x(pay), cum = r.rows[pay - 1].cumCash, my = monthly ? zero : y(cum);
      svg += '<line class="pay-line" x1="' + px + '" x2="' + px + '" y1="' + (T - 6) + '" y2="' + (H - B) + '"/>' +
        '<circle class="pay-dot" cx="' + px + '" cy="' + my + '" r="4.5"/>' +
        '<text class="recovery-label" x="' + px + '" y="' + (T - 10) + '" text-anchor="' + anchorAt(px) + '">✓ ' + pay + '개월 차 회수' + (monthly ? '' : ' · ' + manShort(cum)) + '</text>';
    } else if (pay === null) {
      svg += '<text class="unrec-label" x="' + (W - R) + '" y="' + (T - 10) + '" text-anchor="end">기간 내 미회수</text>';
    }
    host.innerHTML = svg + '</svg>';
    bindTips(host, pts, function (p) {
      return '<strong>' + (p.m === 0 ? '시작 시점' : p.m + '개월 차 말') + '</strong><span>' + name + ' ' + cash(p.v) + '</span>' +
        (p.row ? '<span>' + (monthly ? '누적 현금 ' + cash(p.row.cumCash) : '이번 달 현금 증감 ' + cash(p.row.cashFlow)) + '</span>' : '<span>생산 투입 + 초기비용 지출</span>') +
        (p.m > 0 && p.m === pay ? '<span>✓ 투입금 회수</span>' : '');
    });
  }

  /* ---------- 판매 / 재고: 참고 대시보드의 전환형 막대 그래프 ---------- */
  function renderInvCard(r, sp) {
    var inventory = stockMode === 'inventory';
    $$('[data-stock-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-stock-mode') === stockMode)); });
    out('invLead', '생산 ' + box(r.quantity) + ' / 예상 판매 ' + box(r.totals.sold) + ' / 남은 재고 ' + box(r.endingInventory));
    out('invNote', r.totals.excess > 0 ? '<span class="loss">재고 부족</span> 판매계획 중 ' + box(r.totals.excess) + '는 계산에 반영되지 않았습니다.' : '');
    out('invCaption', inventory ? '월말 남은 수량 · 시작은 초기 생산수량' : '실제 판매 반영 수량 · 재고를 초과하는 계획은 빗금 표시');
    var host = $('#invChart');
    var pts = [{ label: '시작', sold: 0, inv: r.quantity, excess: 0, m: 0 }].concat(r.rows.map(function (m) {
      return { label: m.month + '개월', sold: m.sold, inv: m.inventoryEnd, excess: m.excess, m: m.month };
    }));
    var W = chartWidth(host), H = 138, L = 44, R = 12, T = 21, B = 24;
    var maxVal = Math.max.apply(null, pts.map(function (p) { return inventory ? p.inv : p.sold + p.excess; }));
    var step = Math.max(1, niceStep(maxVal || 1, 2)), top = Math.max(step, Math.ceil(maxVal / step) * step);
    var slot = (W - L - R) / pts.length, bw = Math.min(22, slot * .52);
    var x = function (i) { return L + slot * (i + .5); };
    var y = function (v) { return H - B - v / top * (H - T - B); };
    var qtyAxis = function (v) { return v >= 1e8 ? (v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '억' : v >= 1e4 ? (v / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '만' : fmtInt(v); };
    var labels = pickLabels(pts.length, x, [pts.length - 1, 0], 47);
    var name = inventory ? '월말 남은 재고' : '월별 판매수량';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + name + '. 총 판매 ' + box(r.totals.sold) + ', 기말 재고 ' + box(r.endingInventory) + '">';
    svg += '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="hatch-line"/></pattern></defs>';
    for (var g = 0; g <= top + step * .001; g += step) {
      svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text class="axis" x="' + (L - 8) + '" y="' + (y(g) + 3) + '" text-anchor="end">' + qtyAxis(g) + '</text>';
    }
    pts.forEach(function (p, i) {
      var v = inventory ? p.inv : p.sold, total = inventory ? v : v + p.excess;
      if (v > 0) svg += '<path class="' + (inventory ? 'bar-inventory' : 'bar-sold') + '" d="' + roundedBar(x(i) - bw / 2, H - B, bw, y(v), H - B - y(v), true) + '"/>';
      if (!inventory && p.excess > 0) svg += '<rect class="bar-excess" x="' + (x(i) - bw / 2) + '" y="' + y(total) + '" width="' + bw + '" height="' + (y(v) - y(total)) + '" rx="3"/>';
      if (labels.indexOf(i) >= 0) {
        svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 7) + '" text-anchor="middle">' + p.label + '</text>';
        if (pts.length <= 13 && (inventory || i > 0)) svg += '<text class="val" x="' + x(i) + '" y="' + (y(total) - 7) + '" text-anchor="middle">' + qtyAxis(v) + '</text>';
      }
      svg += '<rect class="hit" tabindex="0" aria-label="' + p.label + ' 판매 ' + box(p.sold) + ', 재고 ' + box(p.inv) + '" data-i="' + i + '" x="' + (L + slot * i) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '"/>';
    });
    host.innerHTML = svg + '</svg>';
    bindTips(host, pts, function (p) {
      if (p.m === 0) return '<strong>시작 시점</strong><span>생산 ' + box(p.inv) + '</span>';
      return '<strong>' + p.m + '개월 차</strong><span>판매(반영) ' + box(p.sold) + '</span>' + (p.excess > 0 ? '<span>재고 부족 미반영 ' + box(p.excess) + '</span>' : '') + '<span>월말 남은 재고 ' + box(p.inv) + '</span>';
    });
  }

  /* ---------- ③ 시나리오 ---------- */
  var SC_KEYS = ['low', 'base', 'high'], SC_NAMES = ['보수적', '기준', '낙관적'];
  function scenarioResults() { return SC_KEYS.map(function (k) { return C.simulate(state, { rate: state.scenarioRates[k] }); }); }
  function diffTxt(v, bv) { var d = Math.round(v) - Math.round(bv); return d === 0 ? '<span class="diff">기준과 같음</span>' : '<span class="diff">기준 대비 ' + man(d, { plus: true }) + '</span>'; }
  function scenarioNotes(sc) {
    var rates = state.scenarioRates;
    var notes = sc.map(function (r, i) {
      if (r.totals.excess <= 0) return '';
      return '<p class="note note--danger"><strong>' + SC_NAMES[i] + ' (' + fmtInt(rates[SC_KEYS[i]]) + '%)</strong>판매계획은 ' + box(r.totals.planned) + '지만 생산량이 ' + box(r.quantity) + '여서 ' + box(r.totals.excess) + '는 판매에 반영되지 않습니다.</p>';
    }).join('');
    for (var i = 0; i < 2; i++) {
      var a = sc[i], c = sc[i + 1];
      if (a.totals.sold === c.totals.sold && a.totals.excess + c.totals.excess > 0 && Math.round(a.periodProfit) === Math.round(c.periodProfit)) {
        notes += '<p class="note"><strong>' + SC_NAMES[i] + '·' + SC_NAMES[i + 1] + ' 결과가 같은 이유</strong>두 시나리오 모두 생산한 ' + box(a.quantity) + '를 전부 판매해 더 팔 재고가 없습니다. 추가 생산 비용·단가는 계산에 포함되지 않습니다.</p>';
      }
    }
    return notes;
  }
  function renderScenarios() {
    var sc = scenarioResults(), b = sc[1];
    // 한 시나리오 = 한 행. 예상 이익 막대는 세 시나리오가 같은 금액 축(0원 기준)을 씀
    var profits = sc.map(function (r) { return r.periodProfit; });
    var lo = Math.min(0, Math.min.apply(null, profits)), hi = Math.max(0, Math.max.apply(null, profits));
    var span = hi - lo || 1, zeroPct = (0 - lo) / span * 100;
    var rows = '<div class="scen__row scen__head" role="row"><span role="columnheader">시나리오</span><span role="columnheader">예상 이익</span><span role="columnheader">회수 시점</span></div>';
    rows += sc.map(function (r, i) {
      var v = r.periodProfit, w = Math.abs(v) / span * 100, left = v >= 0 ? zeroPct : zeroPct - w;
      return '<div class="scen__row' + (i === 1 ? ' is-base' : '') + '" role="row">' +
        '<span class="scen__name" role="rowheader"><strong>' + SC_NAMES[i] + '</strong><small>계획의 ' + fmtInt(state.scenarioRates[SC_KEYS[i]]) + '%</small></span>' +
        '<span class="scen__profit" role="cell"><span class="scen__val" title="정확한 금액 ' + won(v) + '">' + pl(v, man(v)) + '</span>' +
        '<span class="scen__bar" aria-hidden="true"><span class="scen__zero" style="left:' + zeroPct + '%"></span><span class="scen__fill' + (v < 0 ? ' is-loss' : '') + '" style="left:' + left + '%;width:' + w + '%"></span></span></span>' +
        '<span class="scen__pay" role="cell"><strong class="' + (r.paybackMonth === null ? 'cashneg' : '') + '">' + paybackText(r) + '</strong><small>재고 ' + box(r.endingInventory) + (r.totals.excess > 0 ? ' · <span class="loss">한도</span>' : '') + '</small></span>' +
        '</div>';
    }).join('');
    $('#scenRows').innerHTML = rows;
    // 비교 영역에 바로 보이는 이유
    var brief = [];
    for (var k = 0; k < 2; k++) {
      var a1 = sc[k], c1 = sc[k + 1];
      if (a1.totals.sold === c1.totals.sold && a1.totals.excess + c1.totals.excess > 0 && Math.round(a1.periodProfit) === Math.round(c1.periodProfit)) {
        brief.push('<strong>' + SC_NAMES[k] + '·' + SC_NAMES[k + 1] + ': 생산량 한도로 결과 동일</strong> ' + SC_NAMES[k + 1] + ' 계획 ' + box(c1.totals.planned) + ' 중 ' + box(c1.totals.excess) + ' 미반영');
      }
    }
    if (!brief.length) sc.forEach(function (r, i) { if (r.totals.excess > 0) brief.push('<strong>' + SC_NAMES[i] + ': 생산량 한도</strong> 계획 ' + box(r.totals.planned) + ' 중 ' + box(r.totals.excess) + ' 미반영'); });
    $('#scenMiniNotes').innerHTML = brief.map(function (t) { return '<p>' + t + '</p>'; }).join('');
    $('#scenNotes').innerHTML = scenarioNotes(sc);

    var full = [
      ['투입자금 회수 시점', function (r) { return '<span class="' + (r.paybackMonth === null ? 'cashneg' : '') + '">' + paybackText(r) + '</span>'; }, null],
      ['기간 말 누적 현금', function (r) { return cash(r.endCash); }, function (r) { return diffTxt(r.endCash, b.endCash); }],
      ['기간 예상 이익', function (r) { return pl(r.periodProfit); }, function (r) { return diffTxt(r.periodProfit, b.periodProfit); }],
      ['남은 재고', function (r) { return box(r.endingInventory) + '<small>재고 원가 ' + won(r.inventoryCost) + '</small>'; }, null],
      ['판매계획 / 반영 판매수량', function (r) { return box(r.totals.sold) + '<small>계획 ' + box(r.totals.planned) + (r.totals.excess > 0 ? ' · 미반영 ' + box(r.totals.excess) : '') + '</small>'; }, null],
      ['전체 매출', function (r) { return won(r.totals.revenue); }, null],
      ['월평균 예상 이익', function (r) { return pl(r.avgMonthlyProfit); }, null]
    ];
    $('#scenTable tbody').innerHTML = full.map(function (l) {
      return '<tr><th scope="row">' + l[0] + '</th>' + sc.map(function (r, i) {
        return '<td class="' + (i === 1 ? 'is-base' : '') + '">' + l[1](r) + (l[2] && i !== 1 ? l[2](r) : '') + '</td>';
      }).join('') + '</tr>';
    }).join('');
    out('rateLow', fmtInt(state.scenarioRates.low) + '%'); out('rateBase', fmtInt(state.scenarioRates.base) + '%'); out('rateHigh', fmtInt(state.scenarioRates.high) + '%');
    var lo = sc[0];
    out('scenInsight', '판매가 계획의 <strong>' + fmtInt(state.scenarioRates.low) + '%</strong>에 그치면(보수적) 기간 예상 이익은 ' + pl(lo.periodProfit, '<strong>' + man(lo.periodProfit) + '</strong>') +
      ', 기간 말 누적 현금은 ' + cash(lo.endCash, '<strong>' + man(lo.endCash) + '</strong>') + ', 회수 시점은 <strong>' + paybackText(lo) + '</strong>입니다.' +
      (lo.endingInventory > 0 ? ' 재고 ' + box(lo.endingInventory) + '(원가 ' + man(lo.inventoryCost) + ')가 남습니다.' : ''));
  }

  /* ---------- ④ 상자당 납품가 구성 ---------- */
  function renderPriceCard(r) {
    var price = r.price, cost = r.unitCost, sell = r.unitSelling, spend = cost + sell;
    var host = $('#priceBar');
    var segs = [{ k: 'cost', name: '생산원가', v: cost }, { k: 'sell', name: '판매비', v: sell }];
    var html;
    if (r.unitMargin >= -0.5) {
      segs.push({ k: 'margin', name: '판매 후 남는 금액', v: Math.max(0, r.unitMargin) });
      var base = price > 0 ? price : 1;
      out('priceLead', '<strong>' + won(r.unitMargin) + '</strong> 판매 후 남는 금액 <span class="price-secondary"><strong>' + (price > 0 ? pct(r.unitMargin / price) : '—') + '</strong> 납품가 대비</span>');
      html = '<div class="pbar__track" role="img" aria-label="납품가 ' + won(price) + ' = 생산원가 ' + won(cost) + ' + 판매비 ' + won(sell) + ' + 남는 금액 ' + won(r.unitMargin) + '">' +
        segs.filter(function (s) { return s.v > 0; }).map(function (s) { return '<span class="pseg pseg--' + s.k + '" style="width:' + (s.v / base * 100) + '%"></span>'; }).join('') + '</div>' +
        '<div class="pbar__scale"><span>0원</span><span>납품가 ' + won(price) + '</span></div>';
      html += '<ul class="pbar__list">' + segs.map(function (s) {
        return '<li><span class="sw pseg--' + s.k + '"></span><span class="pbar__name">' + s.name + '</span><span class="pbar__meter" aria-hidden="true"><span class="pseg--' + s.k + '" style="width:' + Math.min(100, s.v / base * 100) + '%"></span></span><strong>' + won(s.v) + '</strong><span class="pbar__pct">' + (price > 0 ? pct(s.v / price) : '—') + '</span></li>';
      }).join('') + '</ul>';
    } else {
      // 손실: 음수를 구성 비율처럼 그리지 않고, 비용 막대 위에 납품가 위치와 초과분을 따로 표시
      var over = spend - price;
      out('priceLead', '<span class="loss">원가·판매비가 납품가보다 <strong>' + won(over) + '</strong> 많아 상자당 ' + won(over) + ' 손실</span>');
      var pricePos = spend > 0 ? price / spend * 100 : 0;
      html = '<div class="pbar__track pbar__track--loss" role="img" aria-label="생산원가 ' + won(cost) + ' + 판매비 ' + won(sell) + ' = ' + won(spend) + ', 납품가 ' + won(price) + '보다 ' + won(over) + ' 초과">' +
        segs.filter(function (s) { return s.v > 0; }).map(function (s) { return '<span class="pseg pseg--' + s.k + '" style="width:' + (s.v / spend * 100) + '%"></span>'; }).join('') +
        '<span class="pbar__over" style="left:' + pricePos + '%;width:' + (100 - pricePos) + '%"></span><span class="pbar__mark" style="left:' + pricePos + '%"></span></div>' +
        '<div class="pbar__scale"><span>0원</span><span>원가 + 판매비 ' + won(spend) + '</span></div>';
      var anchor = pricePos > 70 ? 'right' : pricePos < 30 ? 'left' : 'mid';
      html = '<div class="pbar__top"><span class="pbar__markl pbar__markl--' + anchor + '" style="left:' + pricePos + '%">납품가 ' + won(price) + '</span></div>' + html;
      html += '<ul class="pbar__list">' + segs.map(function (s) {
        return '<li><span class="sw pseg--' + s.k + '"></span><span class="pbar__name">' + s.name + '</span><span class="pbar__meter" aria-hidden="true"><span class="pseg--' + s.k + '" style="width:' + Math.min(100, s.v / Math.max(1, spend) * 100) + '%"></span></span><strong>' + won(s.v) + '</strong><span class="pbar__pct"></span></li>';
      }).join('') + '<li class="is-loss"><span class="sw pseg--over"></span><span class="pbar__name">상자당 손실</span><span class="pbar__meter" aria-hidden="true"><span class="pseg--over" style="width:100%"></span></span><strong class="loss">' + won(over) + '</strong><span class="pbar__pct"></span></li></ul>';
    }
    host.innerHTML = html;
  }

  /* ---------- 상세 내역 ---------- */
  function renderDetail(r) {
    // 월별 표
    var rows = '<tr class="start"><th scope="row">시작</th><td colspan="5" class="note-cell">생산 투입 ' + won(r.productionCost) + ' (' + box(r.quantity) + ' × ' + won(r.unitCost) + ')' + (r.oneTimeCost > 0 ? ' · 초기 일회성 비용 ' + won(r.oneTimeCost) : '') + '</td>' +
      '<td>' + (r.oneTimeCost > 0 ? pl(-r.oneTimeCost) + '<small>초기 일회성 비용</small>' : '—') + '</td><td>' + box(r.quantity) + '</td><td>' + cash(r.initialCash) + '</td></tr>';
    rows += r.rows.map(function (m) {
      var qty = box(m.sold) + (m.excess > 0 ? '<small class="loss">계획 ' + fmtInt(m.planned) + ' · 재고 부족 ' + fmtInt(m.excess) + '</small>' : '');
      var paid = r.paybackMonth === m.month ? '<small class="okc">✓ 투입자금 회수</small>' : '';
      return '<tr><th scope="row">' + m.month + '개월 차</th><td>' + qty + '</td><td>' + won(m.revenue) + '</td><td>' + won(m.cogs) + '</td><td>' + won(m.selling) + '</td><td>' + won(m.fixed) + '</td><td>' + pl(m.profit) + '</td><td>' + box(m.inventoryEnd) + '</td><td>' + cash(m.cumCash) + paid + '</td></tr>';
    }).join('');
    $('#monthTable tbody').innerHTML = rows;
    var t = r.totals;
    $('#monthTable tfoot').innerHTML =
      '<tr><th scope="row">합계</th><td>' + box(t.sold) + (t.excess > 0 ? '<small class="loss">재고 부족 ' + fmtInt(t.excess) + '</small>' : '') + '</td><td>' + won(t.revenue) + '</td><td>' + won(t.cogs) + '</td><td>' + won(t.selling) + '</td><td>' + won(t.fixed) + '</td><td>' + pl(t.monthProfit) + '</td><td>' + box(r.endingInventory) + '</td><td>' + cash(r.endCash) + '</td></tr>' +
      '<tr><th scope="row" colspan="6">기간 예상 이익 (월 이익 합계 − 초기 일회성 비용 ' + won(r.oneTimeCost) + ')</th><td>' + pl(r.periodProfit) + '</td><td colspan="2">월평균 ' + pl(r.avgMonthlyProfit) + '</td></tr>';
    var mid = r.paybackMonth === null ? r.months + '개월 안에는 회수하지 못하고, 기간 말 누적 현금은 ' + cash(r.endCash, '<strong>' + man(r.endCash) + '</strong>') + '입니다.'
      : r.paybackMonth === 0 ? '투입 자금이 없습니다.' : '<strong>' + r.paybackMonth + '개월 차</strong>에 투입자금을 회수하고, 기간 말 누적 현금은 <strong>' + man(r.endCash) + '</strong>입니다.';
    out('cashInsight', '시작할 때 <strong>' + man(r.initialFunding) + '</strong>를 지출합니다. ' + mid + (r.maxFunding > r.initialFunding + 0.5 ? ' ' + r.maxFundingMonth + '개월 차에 최대 <strong>' + man(r.maxFunding) + '</strong>이 필요합니다.' : ''));
    out('reconcile', r.endingInventory > 0
      ? '<p class="note"><strong>이익과 현금이 다른 이유</strong>기간 말 누적 현금은 ' + man(r.endCash) + '이며, 남은 재고 ' + box(r.endingInventory) + '의 원가는 ' + man(r.inventoryCost) + '입니다. 재고 원가는 현금이 아니므로 누적 현금에 넣지 않았습니다. (예상 이익 ' + man(r.periodProfit) + ' = 누적 현금 ' + man(r.endCash) + ' + 재고 원가 ' + man(r.inventoryCost) + ')</p>'
      : '<p class="note">재고가 모두 팔려 기간 말 누적 현금과 기간 예상 이익이 같습니다.</p>');

    // 원가 내역
    var b = C.costBreakdown(state);
    $('#costTable tbody').innerHTML = b.parts.map(function (p) {
      return '<tr><th scope="row">' + esc(p.name) + '</th><td>' + won(p.amount) + '</td><td>' + pct(p.share) + '</td><td>' + won(p.amount * r.quantity) + '</td></tr>';
    }).join('');
    $('#costTable tfoot').innerHTML =
      '<tr><th scope="row">상자당 생산원가</th><td>' + won(b.total) + '</td><td>' + (b.total > 0 ? '100%' : '—') + '</td><td>' + won(r.productionCost) + '</td></tr>' +
      '<tr class="sub"><th scope="row">+ 상자당 판매비</th><td>' + won(r.unitSelling) + '</td><td></td><td><small>판매한 상자에만 발생</small></td></tr>' +
      '<tr class="sub"><th scope="row">납품가</th><td>' + won(r.price) + '</td><td></td><td></td></tr>' +
      '<tr><th scope="row">상자당 판매 후 남는 금액</th><td>' + pl(r.unitMargin) + '</td><td>' + (r.price > 0 ? '납품가의 ' + pct(r.unitMargin / r.price) : '—') + '</td><td></td></tr>';
    var topItem = b.parts.slice().sort(function (x, y) { return y.amount - x.amount; })[0];
    var ins;
    if (state.costMode === 'quote') ins = '완제품 견적 방식이라 원가 상세 구성 자료가 없습니다. 상자당 원가 <strong>' + won(b.total) + '</strong>는 납품가의 <strong>' + (r.price > 0 ? pct(b.total / r.price) : '—') + '</strong>입니다.';
    else if (topItem && b.total > 0) ins = '원가 중 가장 큰 항목은 <strong>' + esc(topItem.name) + '</strong>로 상자당 ' + won(topItem.amount) + ', 원가의 <strong>' + pct(topItem.share) + '</strong>입니다.';
    else ins = '입력된 원가 항목이 없습니다.';
    out('costInsight', ins);
    var scale = Math.max(b.total, 1);
    var segs = b.parts.map(function (p, i) { return { name: p.name, v: p.amount, cls: 'seg-c' + (i % 6) }; }).filter(function (s) { return s.v > 0; });
    $('#costBar').innerHTML = '<div class="costbar__track" role="img" aria-label="상자당 원가 ' + won(b.total) + ' 구성">' + segs.map(function (s) {
      return '<span class="' + s.cls + '" style="width:' + (s.v / scale * 100) + '%" title="' + esc(s.name) + ' ' + won(s.v) + '"></span>';
    }).join('') + '</div><ul class="costbar__legend">' + segs.map(function (s) {
      return '<li><span class="dot ' + s.cls + '"></span>' + esc(s.name) + ' <strong>' + won(s.v) + '</strong></li>';
    }).join('') + '</ul>';

    // 목표 역산
    var q = C.requiredSales(state, state.targetMonthlyProfit), el = $('#targetOut');
    if (state.targetMonthlyProfit === null) el.innerHTML = '<p class="hint">목표 월 이익을 입력하면 필요한 판매량을 계산합니다.</p>';
    else if (!q.ok) el.innerHTML = '<p class="note note--danger"><strong>계산 불가</strong>' + esc(q.reason) + '</p>';
    else {
      var planAvg = r.totals.planned / r.months, gap = q.perMonth - planAvg;
      var h = '<div class="target__kpis">' +
        '<div class="tk tk--main"><p>필요 월 판매량</p><strong>' + box(q.perMonth) + '</strong><small>' + q.months + '개월 합계 ' + box(q.total) + '</small></div>' +
        '<div class="tk"><p>현재 판매계획 대비</p><strong class="' + (gap > 1e-9 ? 'loss' : 'okc') + '">' + (gap > 1e-9 ? '월 ' + fmtInt(Math.ceil(gap - 1e-9)) + '상자 부족' : '목표 충족') + '</strong><small>현재 계획 월평균 ' + box(Math.round(planAvg)) + '</small></div>' +
        '<div class="tk"><p>생산량</p><strong class="' + (q.shortage > 0 ? 'loss' : 'okc') + '">' + (q.shortage > 0 ? box(q.shortage) + ' 부족' : '충분') + '</strong><small>현재 생산 ' + box(q.quantity) + '</small></div></div>';
      if (q.shortage > 0) h += '<p class="note note--danger"><strong>생산량 부족</strong>필요한 전체 판매량이 현재 생산량보다 ' + box(q.shortage) + ' 많습니다. 추가 생산 비용·단가는 이 계산에 포함되지 않습니다.</p>';
      h += '<p class="hint">필요 월 판매량 = 올림[(목표 월 이익 + 월 고정비 + 초기 일회성 비용 ÷ 판매 개월 수) ÷ 상자당 남는 금액] = 올림[(' + won(state.targetMonthlyProfit) + ' + ' + won(r.monthlyFixed) + ' + ' + won(r.oneTimeCost) + ' ÷ ' + r.months + ') ÷ ' + won(r.unitMargin) + '] = ' + box(q.perMonth) + '. 선택한 판매기간 안에 초기 일회성 비용도 회수한다는 가정입니다.</p>';
      el.innerHTML = h;
    }

    // 계산 근거
    out('soldXPrice', box(r.totals.sold) + ' × ' + won(r.price));
    out('revenue', won(r.totals.revenue));
    out('cogs', won(-r.totals.cogs));
    out('selling', won(-r.totals.selling));
    out('monthsN', String(r.months));
    out('fixedTotal', won(-r.monthlyFixed * r.months));
    out('oneTime', won(-r.oneTimeCost));
    out('periodProfit', pl(r.periodProfit));
    out('avgExact', pl(r.avgMonthlyProfit));
    out('initialCash', cash(r.initialCash));
    out('cashIn', cash(r.totals.cashFlow));
    out('endCash', cash(r.endCash));
    out('maxFunding', won(r.maxFunding) + ' <small>' + (r.maxFundingMonth === 0 ? '시작 시점' : r.maxFundingMonth + '개월 차') + '</small>');
    out('endInv', box(r.endingInventory));
    out('invCost', won(r.inventoryCost));
    out('excessQty', r.totals.excess > 0 ? '<span class="loss">' + box(r.totals.excess) + '</span>' : '0상자');
  }

  /* ================= 조건 수정 패널 ================= */
  var drawer = $('#drawer'), backdrop = $('#drawerBackdrop'), opener = null;
  function drawerOpen() { return !drawer.hidden; }
  function openDrawer(focusSel, from) {
    opener = from || document.activeElement;
    $('#drawerBody').appendChild($('#settingsForm'));   // 같은 폼을 옮겨 씀 (입력 상태 하나)
    drawer.hidden = false; backdrop.hidden = false;
    document.body.classList.add('drawer-open');
    fitDrawer();
    var target = focusSel ? $(focusSel, drawer) : null;
    requestAnimationFrame(function () {
      if (target) {
        target.scrollIntoView({ block: 'start' });
        var input = target.matches('input') ? target : target.querySelector('input:not([type=radio]), button');
        (input || $('#drawerClose')).focus({ preventScroll: true });
      } else {
        $('#drawerBody').scrollTop = 0;
        $('#drawerClose').focus();
      }
    });
  }
  function closeDrawer(restoreFocus) {
    if (!drawerOpen()) return;
    if (document.activeElement && drawer.contains(document.activeElement)) document.activeElement.blur();
    $('#settingsHome').appendChild($('#settingsForm'));
    drawer.hidden = true; backdrop.hidden = true;
    document.body.classList.remove('drawer-open');
    if (restoreFocus !== false && opener && document.contains(opener) && opener.offsetParent !== null) opener.focus();
    opener = null;
  }
  // 모바일 키보드가 올라오면 패널 높이를 보이는 영역에 맞춤 (닫기 버튼·입력칸이 가려지지 않게)
  function fitDrawer() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    drawer.style.setProperty('--kb', kb + 'px');
    drawer.style.setProperty('--vvh', vv.height + 'px');
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitDrawer); window.visualViewport.addEventListener('scroll', fitDrawer); }
  drawer.addEventListener('focusin', function (e) {
    if (e.target.matches('input') && window.matchMedia('(max-width: 820px)').matches) setTimeout(function () { e.target.scrollIntoView({ block: 'center' }); }, 300);
  });
  document.addEventListener('keydown', function (e) {
    if (!drawerOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key === 'Tab') {  // 패널 안에서만 초점 이동
      var f = $$('button, input, select, a[href], [tabindex="0"]', drawer).filter(function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  backdrop.addEventListener('click', function () { closeDrawer(); });

  /* ================= 저장한 조건 · 예시 체험 ================= */
  function applyUserPresetId(id) {
    var before = S.clone(state);
    state = S.applyUserPreset(state, id);
    fillInputs(); commit(); confirmChange();
    var p = state.userPresets.filter(function (x) { return x.id === id; })[0];
    toast((p ? p.label : '저장한 조건') + ' 적용 — 생산수량·원가·납품가를 함께 바꿨습니다.', '되돌리기', function () { restore(before, '적용 전 값으로 되돌렸습니다.'); });
  }
  function restore(prev, msg) { state = prev; fillInputs(); commit({ monthsChanged: true, saveNow: true }); confirmChange(); toast(msg); }
  /** 덮어쓰기 전 확인: 작성 중인 값이 있으면 묻고, 직후 되돌리기 제공 */
  function replaceState(next, question, doneMsg) {
    if (!S.isBlank(state) && !window.confirm(question)) return false;
    var before = S.clone(state);
    state = next;
    fillInputs(); commit({ monthsChanged: true, saveNow: true }); confirmChange();
    toast(doneMsg, '되돌리기', function () { restore(before, '이전 값으로 되돌렸습니다.'); });
    return true;
  }
  function startExample() {
    var ex = S.applyExample();
    ex.scenarioRates = S.clone(state.scenarioRates);
    replaceState(ex, '가상 예시 데이터로 바꾸면 지금 작성 중인 입력값이 바뀝니다. 계속할까요?\n(직후 되돌리기 가능)', '가상 예시 데이터를 적용했습니다. 실제 사업과 무관한 숫자입니다.');
  }

  /* ================= 설정 파일 내보내기·불러오기 (이 기기에만 저장) ================= */
  function stamp() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes());
  }
  function downloadText(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exportSettings() {
    downloadText('buri-simulation-settings-' + stamp() + '.json', JSON.stringify(S.exportPayload(state), null, 2));
    toast('설정 파일을 이 기기에 저장했습니다. 입력한 사업정보가 들어 있으니 공개된 곳에 올리지 마세요.');
  }
  function onImportFile(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = S.parseImport(String(reader.result || ''));
      if (!res.ok) { toast('불러오지 못했습니다 — ' + res.errors.slice(0, 3).join(' · ') + (res.errors.length > 3 ? ' 외 ' + (res.errors.length - 3) + '건' : '') + '. 기존 입력값은 그대로입니다.', null, null, 9000); return; }
      if (saveBlocked) {
        if (!keepRawThen()) return;
      }
      replaceState(res.state, '현재 작성 중인 입력값을 불러온 파일의 값으로 바꿉니다. 계속할까요?\n(직후 되돌리기 가능)', '설정 파일을 불러와 다시 계산했습니다.');
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다. 기존 입력값은 그대로입니다.'); };
    reader.readAsText(file);
  }

  /* ================= 저장값 복원 실패 처리 (원본 보존) ================= */
  function keepRawThen() {
    var key = S.backupRaw(storage, loaded.raw);
    if (!key && !window.confirm('읽지 못한 원본 저장값을 따로 보관하지 못했습니다. 먼저 ‘원본 저장값 파일로 받기’로 보관하는 것을 권합니다.\n그래도 계속할까요?')) return false;
    saveBlocked = false;
    $('#restoreFail').hidden = true;
    return true;
  }
  function showRestoreFail() {
    $('#restoreFail').hidden = false;
    $('#restoreFailReason').textContent = loaded.reason || '';
    var actions = $('#restoreFail .restore-fail__acts');
    if (loaded.partial && !$('#partialRecoverBtn')) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn--line'; b.id = 'partialRecoverBtn'; b.textContent = '읽을 수 있는 값만 복구';
      actions.insertBefore(b, actions.lastElementChild);
    }
  }

  /* ================= 이벤트 ================= */
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('focusout', onBlur);

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-cash-mode')) { cashMode = t.getAttribute('data-cash-mode'); $('#chartTip').hidden = true; renderCashCard(lastR); return; }
    if (t.hasAttribute('data-stock-mode')) { stockMode = t.getAttribute('data-stock-mode'); $('#chartTip').hidden = true; renderInvCard(lastR, salesPlanInfo(lastR)); return; }
    if (t.hasAttribute('data-drawer-focus')) {
      if (window.BuriNav.current() === 'settings') { var tg = $(t.getAttribute('data-drawer-focus')); if (tg) { tg.scrollIntoView({ block: 'start' }); } }
      else openDrawer(t.getAttribute('data-drawer-focus'), t);
      return;
    }
    if (t.id === 'openDrawerBtn') { openDrawer(null, t); return; }
    if (t.id === 'drawerClose') { closeDrawer(); return; }
    var act = t.getAttribute('data-action');
    if (act === 'export' || t.id === 'exportBtn') { exportSettings(); return; }
    if (act === 'import' || t.id === 'importBtn' || t.id === 'rawImportBtn') { $('#importFile').click(); return; }
    if (act === 'example') { startExample(); return; }
    if (act === 'start') {
      var m = S.missingRequired(state)[0];
      var sel = m && MISSING_FOCUS[m.key];
      if (m && (m.key === 'channel' || (m.key === 'cost' && state.costMode === 'itemized'))) openDrawer(m.key === 'channel' ? '#sgSales' : '#costItemized', t);
      else if (sel) { var f = $(sel); f.scrollIntoView({ block: 'center' }); f.focus({ preventScroll: true }); }
      return;
    }
    if (t.id === 'rawDownloadBtn') { downloadText('buri-simulation-원본저장값-' + stamp() + '.json', loaded.raw || ''); toast('읽지 못한 원본 저장값을 파일로 받았습니다.'); return; }
    if (t.id === 'freshStartBtn') {
      if (!keepRawThen()) return;
      state = S.empty(); fillInputs(); commit({ monthsChanged: true, saveNow: true }); baseline = null;
      toast('원본 저장값은 브라우저에 따로 보관하고, 빈 상태로 새로 시작했습니다.');
      return;
    }
    if (t.id === 'partialRecoverBtn') {
      if (!keepRawThen()) return;
      state = loaded.partial; fillInputs(); commit({ monthsChanged: true, saveNow: true }); baseline = keyMetrics();
      toast('읽을 수 있는 값만 복구했습니다. 읽지 못한 항목은 빈칸입니다. 원본은 따로 보관했습니다.');
      return;
    }
    if (t.hasAttribute('data-apply-preset')) { applyUserPresetId(t.getAttribute('data-apply-preset')); return; }
    if (t.hasAttribute('data-del-preset')) {
      var id = t.getAttribute('data-del-preset');
      var before = S.clone(state);
      state.userPresets = state.userPresets.filter(function (p) { return p.id !== id; });
      fillInputs(); commit();
      toast('저장한 조건을 삭제했습니다.', '되돌리기', function () { restore(before, '삭제를 취소했습니다.'); });
      return;
    }
    if (t.id === 'savePresetBtn') {
      if (state.quantity === null && state.price === null && (state.costMode === 'quote' ? state.quoteCost === null : !state.costItems.length)) { toast('저장할 생산수량·원가·납품가를 먼저 입력하세요.'); return; }
      var name = $('#presetName').value;
      state.userPresets = (state.userPresets || []).concat([S.makeUserPreset(state, name)]);
      $('#presetName').value = '';
      fillInputs(); commit();
      toast('현재 생산수량·원가·납품가를 조건으로 저장했습니다.');
      return;
    }
    if (t.hasAttribute('data-zero')) {
      var k = t.getAttribute('data-zero');
      state[k] = 0;
      if (k === 'oneTimeCost') state.oneTimeSource = 'user';
      fillInputs(); commit(); confirmChange();
    } else if (t.hasAttribute('data-remove-item')) {
      state.costItems.splice(+t.getAttribute('data-remove-item'), 1);
      fillInputs(); commit(); confirmChange();
    } else if (t.id === 'addItemBtn') {
      var used = state.costItems.map(function (i) { return i.name; });
      var suggest = P.COST_CATEGORIES.filter(function (c) { return used.indexOf(c) < 0; })[0] || '기타 항목';
      state.costItems.push({ id: 'item' + Date.now(), name: suggest, amount: null });
      fillInputs(); commit();
      var names = $$('#costItems .item__name'); if (names.length) names[names.length - 1].focus();
    } else if (t.id === 'priceCheckBtn') { state.pricingBasisQty = state.quantity; commit(); }
    else if (t.id === 'clearOverridesBtn') { state.overrides = []; fillInputs(); commit(); confirmChange(); }
    else if (t.id === 'resetBtn') {
      if (!window.confirm('이 브라우저에 저장된 입력값을 비웁니다.\n제품명·수량·가격·원가·판매계획·비용·저장한 조건이 모두 빈칸이 됩니다.\n\n계속할까요? 직후에는 ‘되돌리기’로 복구할 수 있습니다.')) return;
      if (saveBlocked && !keepRawThen()) return;
      undoState = S.clone(state);
      state = S.empty();
      fillInputs(); commit({ monthsChanged: true, saveNow: true }); confirmChange();
      toast('입력값을 비웠습니다.', '되돌리기', function () {
        state = undoState; undoState = null;
        fillInputs(); commit({ monthsChanged: true, saveNow: true }); confirmChange();
        toast('비우기 전 값으로 되돌렸습니다.');
      });
    } else if (t.id === 'toastClose') $('#toast').hidden = true;
  });

  // 화면 전환: 패널은 닫고(값 유지), 그래프는 보이는 폭에 맞춰 다시 그림
  document.addEventListener('buri:viewchange', function (e) {
    closeDrawer(false);
    if (lastR && e.detail.view === 'dashboard') { renderCashCard(lastR); renderInvCard(lastR, salesPlanInfo(lastR)); }
    updateMbar();
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (lastR) { renderCashCard(lastR); renderInvCard(lastR, salesPlanInfo(lastR)); } updateMbar(); }, 150);
  });

  var toastTimer = null, toastFn = null;
  function toast(msg, actionLabel, fn, ms) {
    var el = $('#toast');
    $('#toastMsg').textContent = msg;
    var a = $('#toastAction');
    toastFn = fn || null; a.hidden = !fn;
    if (fn) a.textContent = actionLabel;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || (fn ? 10000 : 4500));
  }
  $('#toastAction').addEventListener('click', function () { var f = toastFn; $('#toast').hidden = true; if (f) f(); });

  /* ---------- 모바일 하단 요약: 조건 설정·상세 내역 화면에서, 입력 중이 아닐 때 ---------- */
  var typing = false;
  function updateMbar() {
    var mobile = window.matchMedia('(max-width: 820px)').matches;
    var show = mobile && window.BuriNav.current() !== 'dashboard' && !typing && !drawerOpen();
    $('#mbar').hidden = !show;
    document.body.classList.toggle('has-mbar', show);
  }
  document.addEventListener('focusin', function (e) { if (e.target.matches && e.target.matches('input, select')) { typing = true; updateMbar(); } });
  document.addEventListener('focusout', function (e) { if (e.target.matches && e.target.matches('input, select')) { typing = false; setTimeout(updateMbar, 50); } });

  /* ================= 시작 ================= */
  fillInputs();
  render();
  baseline = keyMetrics();   // 첫 진입: 비교 기준만 저장, 변화량은 표시하지 않음
  updateMbar();
  // 첫 방문·업데이트·복원 실패 어느 경우에도 자동으로 비우거나 덮어쓰지 않음
  if (loaded.status === 'restored') {
    setSaveState('restored', loaded.savedAt);
    toast(loaded.migratedFrom ? '이전 버전에 저장한 입력값을 그대로 불러왔습니다. 원본도 브라우저에 따로 보관했습니다.' : '이 브라우저에 저장된 입력값을 복원했습니다' + (loaded.savedAt ? ' (' + timeText(loaded.savedAt) + ' 저장)' : '') + '.');
  } else if (loaded.status === 'failed') {
    showRestoreFail(); setSaveState('blocked');
  } else if (!canStore) {
    setSaveState('failed');
  } else setSaveState('idle');

  window.__buri = { getState: function () { return S.clone(state); }, simulate: function () { return C.simulate(state); }, scenarios: scenarioResults };
})();
