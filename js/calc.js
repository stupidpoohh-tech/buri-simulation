/*
 * 계산 로직 (화면과 분리된 순수 함수)
 * ------------------------------------------------------------
 * 요약 카드, 월별 표, 그래프, 시나리오, 목표 역산이 모두 이 파일의
 * simulate() 결과를 사용합니다. 중간값은 반올림하지 않고, 화면 표시
 * 단계에서만 반올림합니다. 단, 판매수량은 상자 단위 정수로 처리합니다.
 *
 * 가정 (첫 버전)
 *  - 초기 생산 1회, 추가 생산 없음
 *  - 생산비·초기 일회성 비용은 시작 시점(0개월)에 전액 지급
 *  - 판매대금은 판매한 달에 전액 수령 (외상 정산 없음)
 *  - 반품·폐기 없음, 기말 재고는 현금으로 환산하지 않음
 */
(function (root) {
  'use strict';

  var EPS = 1e-9;

  /** 빈 값·잘못된 숫자·무한대를 안전한 숫자로 바꿉니다. */
  function num(v, fallback) {
    if (fallback === undefined) fallback = 0;
    if (v === null || v === undefined || v === '') return fallback;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s원%]/g, ''));
    return isFinite(n) ? n : fallback;
  }
  function nonNeg(v) { var n = num(v); return n < 0 ? 0 : n; }
  function intNonNeg(v) { return Math.floor(nonNeg(v) + EPS); }

  /** 판매수량 반올림 규칙 (전 영역 공통): 0.5 이상 올림, 결과는 0 이상의 정수 */
  function roundQty(x) {
    var n = num(x);
    if (n <= 0) return 0;
    return Math.round(Math.round(n * 1e6) / 1e6);
  }

  function clampMonths(v) {
    var m = Math.floor(num(v, 1) + EPS);
    if (m < 1) m = 1;
    if (m > 60) m = 60;
    return m;
  }

  /** 상자당 원가: 항목별 합계 또는 완제품 견적 단가 중 하나만 사용 (중복 합산 없음) */
  function unitCost(inp) {
    if (inp.costMode === 'quote') return nonNeg(inp.quoteCost);
    var sum = 0;
    var items = inp.costItems || [];
    for (var i = 0; i < items.length; i++) sum += nonNeg(items[i].amount);
    return sum;
  }

  /** 상자당 판매비 = 판매단가 × 수수료율 + 상자당 추가 판매비 */
  function unitSelling(inp) {
    var price = nonNeg(inp.price);
    var commission = price * nonNeg(inp.commissionRate) / 100;
    var extra = nonNeg(inp.extraSellingCost);
    return { commission: commission, extra: extra, total: commission + extra };
  }

  /** 공통 월 판매량 (판매계획 방식에 따라) — 반올림 전 값 */
  function baseMonthlyPlan(inp) {
    if (inp.salesMode === 'channel') {
      var c = inp.channel || {};
      return nonNeg(c.stores) * nonNeg(c.perStorePerDay) * nonNeg(c.businessDays) + nonNeg(c.otherMonthly);
    }
    return nonNeg(inp.commonMonthly);
  }

  /** 월별 판매계획 (시나리오 비율 반영 전, 정수 처리 전) */
  function plannedMonthsRaw(inp) {
    var months = clampMonths(inp.months);
    var base = baseMonthlyPlan(inp);
    var ov = inp.overrides || [];
    var out = [];
    for (var i = 0; i < months; i++) {
      var o = ov[i];
      var has = o !== null && o !== undefined && o !== '' && isFinite(Number(o));
      out.push(has ? nonNeg(o) : base);
    }
    return out;
  }

  /**
   * 핵심 시뮬레이션.
   * @param inp   입력값 (state.js 의 구조)
   * @param opts  { rate: 판매계획 대비 비율(%) — 시나리오용, 기본 100 }
   */
  function simulate(inp, opts) {
    opts = opts || {};
    var rate = opts.rate === undefined ? 100 : nonNeg(opts.rate);

    var months = clampMonths(inp.months);
    var quantity = intNonNeg(inp.quantity);
    var price = nonNeg(inp.price);
    var cost = unitCost(inp);
    var sell = unitSelling(inp);
    var margin = price - cost - sell.total;
    var fixed = nonNeg(inp.monthlyFixed);
    var oneTime = nonNeg(inp.oneTimeCost);

    var productionCost = quantity * cost;
    var initialFunding = productionCost + oneTime;
    var initialCash = -productionCost - oneTime;

    var raw = plannedMonthsRaw(inp);
    var rows = [];
    var inventory = quantity;
    var cum = initialCash;
    var t = { planned: 0, sold: 0, excess: 0, revenue: 0, cogs: 0, selling: 0, fixed: 0, monthProfit: 0, cashFlow: 0 };
    var payback = initialCash >= 0 ? 0 : null;
    var minCash = initialCash, minCashMonth = 0;

    for (var i = 0; i < months; i++) {
      var planned = roundQty(raw[i] * rate / 100);
      var sold = Math.min(planned, inventory);
      var excess = planned - sold;
      inventory -= sold;
      var revenue = sold * price;
      var cogs = sold * cost;
      var selling = sold * sell.total;
      var profit = revenue - cogs - selling - fixed;       // 일회성 비용 차감 전
      var cashFlow = revenue - selling - fixed;             // 생산비는 시작 시 지급했으므로 제외
      cum += cashFlow;
      if (payback === null && cum >= -EPS) payback = i + 1;
      if (cum < minCash - EPS) { minCash = cum; minCashMonth = i + 1; }
      rows.push({
        month: i + 1, planned: planned, sold: sold, excess: excess,
        revenue: revenue, cogs: cogs, selling: selling, fixed: fixed,
        profit: profit, cashFlow: cashFlow, inventoryEnd: inventory, cumCash: cum
      });
      t.planned += planned; t.sold += sold; t.excess += excess;
      t.revenue += revenue; t.cogs += cogs; t.selling += selling; t.fixed += fixed;
      t.monthProfit += profit; t.cashFlow += cashFlow;
    }

    var periodProfit = t.revenue - t.cogs - t.selling - fixed * months - oneTime;

    return {
      rate: rate,
      months: months,
      quantity: quantity,
      price: price,
      unitCost: cost,
      unitCommission: sell.commission,
      unitExtraSelling: sell.extra,
      unitSelling: sell.total,
      unitMargin: margin,
      monthlyFixed: fixed,
      oneTimeCost: oneTime,
      productionCost: productionCost,
      initialFunding: initialFunding,
      initialCash: initialCash,
      rows: rows,
      totals: t,
      periodProfit: periodProfit,
      avgMonthlyProfit: periodProfit / months,
      endingInventory: inventory,
      inventoryCost: inventory * cost,
      endCash: cum,
      paybackMonth: payback,               // 0: 투입 없음, null: 설정 기간 내 미회수
      maxFunding: minCash < 0 ? -minCash : 0,
      maxFundingMonth: minCashMonth        // 0: 시작 시점
    };
  }

  /** 원가 구성 (상자당) */
  function costBreakdown(inp) {
    var cost = unitCost(inp);
    var parts = [];
    if (inp.costMode === 'quote') {
      parts.push({ name: '완제품 견적 단가', amount: cost });
    } else {
      var items = inp.costItems || [];
      for (var i = 0; i < items.length; i++) {
        parts.push({ name: String(items[i].name || '이름 없는 항목'), amount: nonNeg(items[i].amount) });
      }
    }
    for (var j = 0; j < parts.length; j++) parts[j].share = cost > 0 ? parts[j].amount / cost : 0;
    return { total: cost, parts: parts };
  }

  /**
   * 목표 월 이익 역산
   * 필요 월 판매량 = 올림[(목표 월 이익 + 월 고정비 + 초기 일회성 비용 ÷ 판매 개월 수) ÷ 상자당 남는 금액]
   * (선택 기간 안에 초기 일회성 비용도 회수한다는 가정)
   */
  function requiredSales(inp, targetMonthlyProfit) {
    var r = simulate(inp);
    var target = num(targetMonthlyProfit);
    var need = target + r.monthlyFixed + r.oneTimeCost / r.months;
    var res = { ok: false, reason: '', perMonth: 0, total: 0, shortage: 0, need: need, unitMargin: r.unitMargin, months: r.months, quantity: r.quantity };
    if (!(r.unitMargin > EPS)) {
      res.reason = r.unitMargin < -EPS
        ? '상자당 남는 금액이 마이너스입니다. 팔수록 손실이 커지므로 판매량을 늘려서는 목표 이익을 낼 수 없습니다. 판매단가·원가·판매비를 먼저 조정해야 합니다.'
        : '상자당 남는 금액이 0원입니다. 판매량과 무관하게 이익이 늘지 않으므로 필요 판매량을 계산할 수 없습니다.';
      return res;
    }
    var per = need <= 0 ? 0 : Math.ceil(need / r.unitMargin - EPS);
    res.ok = true;
    res.perMonth = per;
    res.total = per * r.months;
    res.shortage = Math.max(0, res.total - r.quantity);
    return res;
  }

  var api = {
    num: num, nonNeg: nonNeg, roundQty: roundQty, clampMonths: clampMonths,
    unitCost: unitCost, unitSelling: unitSelling, baseMonthlyPlan: baseMonthlyPlan,
    plannedMonthsRaw: plannedMonthsRaw, simulate: simulate, costBreakdown: costBreakdown,
    requiredSales: requiredSales
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuriCalc = api;
})(typeof self !== 'undefined' ? self : this);
