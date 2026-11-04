/*
 * 계산·저장 단위 검증 — 모든 숫자는 실제 사업과 무관한 가상 데이터입니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');
const S = require('../js/state.js');

// 가상 기준 조건: 2,400상자 · 원가 5,000 · 납품가 7,500 · 3개월 · 월 800상자 · 다른 비용 미입력
function base(over) {
  return Object.assign(S.empty(), {
    quantity: 2400, months: 3, costMode: 'quote', quoteCost: 5000, price: 7500, commonMonthly: 800
  }, over || {});
}
function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m
  };
}

/* ---------------- 계산 ---------------- */
test('항목별 원가와 견적 원가는 중복 합산하지 않음', () => {
  const s = base({ costMode: 'itemized', costItems: [{ name: 'a', amount: 3000 }, { name: 'b', amount: 2000 }, { name: 'c', amount: null }] });
  assert.equal(C.unitCost(s), 5000);
  assert.equal(C.unitCost(Object.assign({}, s, { costMode: 'quote', quoteCost: 4000 })), 4000);
});

test('사례 A: 전량 판매 (회수 시점 누적 현금 정확히 0원)', () => {
  const r = C.simulate(base());
  assert.equal(r.initialFunding, 12000000);
  assert.equal(r.totals.revenue, 18000000);
  assert.equal(r.periodProfit, 6000000);
  assert.equal(r.avgMonthlyProfit, 2000000);
  assert.equal(r.endingInventory, 0);
  assert.equal(r.endCash, 6000000);
  assert.equal(r.rows[1].cumCash, 0);
  assert.equal(r.paybackMonth, 2);
  assert.equal(r.unitMargin, 2500);
});

test('사례 B: 일부 판매 (합계 1,500상자) — 월 배분과 무관', () => {
  for (const ov of [[1500, 0, 0], [500, 500, 500], [0, 0, 1500]]) {
    const r = C.simulate(base({ overrides: ov }));
    assert.equal(r.totals.revenue, 11250000);
    assert.equal(r.periodProfit, 3750000);
    assert.equal(r.avgMonthlyProfit, 1250000);
    assert.equal(r.endingInventory, 900);
    assert.equal(r.inventoryCost, 4500000);
    assert.equal(r.endCash, -750000);
    assert.equal(r.paybackMonth, null);
    assert.equal(r.periodProfit - r.inventoryCost, r.endCash, '이익 − 재고 원가 = 기간 말 현금');
  }
});

test('사례 C: 초기 일회성 비용은 한 번만 차감', () => {
  const r = C.simulate(base({ oneTimeCost: 1200000 }));
  assert.equal(r.initialFunding, 13200000);
  assert.equal(r.periodProfit, 4800000);
  assert.equal(r.avgMonthlyProfit, 1600000);
  assert.equal(r.endCash, 4800000);
  assert.equal(r.paybackMonth, 3);
  assert.equal(r.unitCost, 5000);
  assert.deepEqual(r.rows.map(x => x.profit), [2000000, 2000000, 2000000]);
});

test('판매량 0: 손실 없이 미회수, 재고 전량', () => {
  const r = C.simulate(base({ commonMonthly: 0 }));
  assert.equal(r.totals.revenue, 0);
  assert.equal(r.periodProfit, 0);
  assert.equal(r.endingInventory, 2400);
  assert.equal(r.endCash, -12000000);
  assert.equal(r.paybackMonth, null);
});

test('재고 초과 판매계획은 재고 범위로 제한하고 초과분 따로 집계', () => {
  const r = C.simulate(base({ commonMonthly: 1200 }));
  assert.deepEqual(r.rows.map(x => x.sold), [1200, 1200, 0]);
  assert.deepEqual(r.rows.map(x => x.excess), [0, 0, 1200]);
  assert.equal(r.totals.excess, 1200);
  assert.equal(r.endingInventory, 0);
});

test('원가가 납품가보다 높으면 정상적인 적자, 역산은 계산 불가', () => {
  const r = C.simulate(base({ quoteCost: 8000 }));
  assert.equal(r.unitMargin, -500);
  assert.equal(r.periodProfit, -1200000);
  assert.equal(C.requiredSales(base({ quoteCost: 8000 }), 1000000).ok, false);
  assert.match(C.requiredSales(base({ quoteCost: 7500 }), 1000000).reason, /0원/);
});

test('수수료·추가 판매비·고정비 반영, 이익과 현금 분리', () => {
  const s = base({ commissionRate: 10, extraSellingCost: 300, monthlyFixed: 500000 });
  const r = C.simulate(s);
  assert.equal(r.unitSelling, 1050);
  assert.equal(r.unitMargin, 1450);
  assert.equal(r.periodProfit, 1980000);
  assert.equal(r.rows[0].cashFlow, 4660000);
  assert.equal(r.endCash, 1980000);
  assert.equal(r.paybackMonth, 3);
  const q = C.requiredSales(s, 2000000);
  assert.equal(q.perMonth, 1725);
  assert.equal(q.total, 5175);
  assert.equal(q.shortage, 2775);
});

test('최대 필요자금: 고정비로 시작 이후 더 낮아짐', () => {
  const r = C.simulate(base({ overrides: [0, 800, 800], monthlyFixed: 800000 }));
  assert.equal(r.initialFunding, 12000000);
  assert.equal(r.maxFunding, 12800000);
  assert.equal(r.maxFundingMonth, 1);
});

test('시나리오 비율 반올림 규칙과 재고 한도', () => {
  const s = base({ commonMonthly: 333 });
  assert.deepEqual(C.simulate(s, { rate: 75 }).rows.map(x => x.sold), [250, 250, 250]);
  assert.deepEqual(C.simulate(s, { rate: 125 }).rows.map(x => x.sold), [416, 416, 416]);
  const big = C.simulate(base(), { rate: 125 });
  assert.equal(big.totals.sold, 2400);
  assert.equal(big.totals.excess, 600);
});

test('판매처 기준 계산', () => {
  const s = base({ salesMode: 'channel', channel: { stores: 8, perStorePerDay: 4, businessDays: 25, otherMonthly: null } });
  assert.equal(C.baseMonthlyPlan(s), 800);
  assert.equal(C.simulate(s).periodProfit, 6000000);
});

test('빈 값·잘못된 숫자에도 NaN·Infinity 없음', () => {
  const r = C.simulate(base({ quantity: '', months: 0, price: 'abc', quoteCost: NaN, commonMonthly: Infinity }));
  const walk = o => { for (const v of Object.values(o)) { if (typeof v === 'number') assert.ok(Number.isFinite(v)); else if (v && typeof v === 'object') walk(v); } };
  walk(r);
});

/* ---------------- 공개용 빈 상태 ---------------- */
test('빈 상태: 사업정보 없음, 필수 조건 5개 부족', () => {
  const s = S.empty();
  assert.equal(s.productName, '');
  for (const k of ['quantity', 'months', 'price', 'quoteCost', 'commonMonthly', 'commissionRate', 'extraSellingCost', 'oneTimeCost', 'monthlyFixed', 'targetMonthlyProfit']) assert.equal(s[k], null, k);
  assert.deepEqual(s.costItems, []);
  assert.deepEqual(s.userPresets, []);
  assert.deepEqual(s.scenarioRates, { low: 75, base: 100, high: 125 });
  assert.deepEqual(S.missingRequired(s).map(m => m.key), ['quantity', 'cost', 'price', 'months', 'sales']);
  assert.equal(S.isBlank(s), true);
  assert.deepEqual(S.missingRequired(base()), []);
});

test('월별 판매량을 모두 입력하면 공통 월 판매량 없이도 계산 가능', () => {
  const s = base({ commonMonthly: null, overrides: [100, 200, 300] });
  assert.deepEqual(S.missingRequired(s), []);
  assert.deepEqual(S.missingRequired(base({ commonMonthly: null, overrides: [100, null, 300] })).map(m => m.key), ['sales']);
});

test('가상 예시는 선택했을 때만, 비용은 미입력으로', () => {
  const e = S.applyExample();
  assert.equal(e.example, true);
  assert.deepEqual(S.missingRequired(e), []);
  assert.equal(e.commissionRate, null);
  assert.equal(S.empty().example, false);
});

/* ---------------- 저장 · 복원 · 이전 버전 변환 ---------------- */
test('저장값 없음: 빈 상태, 저장공간에 아무것도 쓰지 않음', () => {
  const st = memStorage();
  const r = S.load(st);
  assert.equal(r.status, 'empty');
  assert.equal(st._map.size, 0);
});

test('v2 저장·복원: 빈칸과 0원 구분 유지', () => {
  const st = memStorage();
  const s = base({ productName: '내 제품', oneTimeCost: 0, oneTimeSource: 'user', commissionRate: null, overrides: [null, 500] });
  assert.ok(S.save(st, s));
  const r = S.load(st);
  assert.equal(r.status, 'restored');
  assert.equal(r.state.oneTimeCost, 0);
  assert.equal(r.state.commissionRate, null);
  assert.deepEqual(r.state.overrides, [null, 500]);
  assert.equal(r.state.productName, '내 제품');
});

test('이전 버전(v1) 저장값: 값 그대로 변환, 누락 항목은 빈칸, 원본 보관', () => {
  const v1 = { v: 1, productId: 'old', productName: '이전 제품', presetId: 'x', pricingBasisQty: 1500, quantity: 1500, months: 2,
    costMode: 'itemized', costItems: [{ id: 'a', name: '항목A', amount: 1234 }], itemsBasisQty: 1500, quoteCost: 4321, price: 6789,
    commissionRate: null, extraSellingCost: 0, oneTimeCost: 0, oneTimeSource: 'user', monthlyFixed: null,
    salesMode: 'direct', commonMonthly: 600, overrides: [null, 700],
    channel: { stores: null, perStorePerDay: null, businessDays: null, otherMonthly: null },
    scenarioRates: { low: 70, base: 100, high: 130 }, savedAt: '2026-01-01T00:00:00.000Z' };
  const raw = JSON.stringify(v1);
  const st = memStorage({ [S.STORAGE_KEY]: raw });
  const r = S.load(st);
  assert.equal(r.status, 'restored');
  assert.equal(r.migratedFrom, 1);
  assert.equal(r.state.quantity, 1500);
  assert.equal(r.state.price, 6789);
  assert.equal(r.state.costItems[0].amount, 1234);
  assert.equal(r.state.extraSellingCost, 0, '0원 확인 유지');
  assert.equal(r.state.commissionRate, null, '미입력 유지');
  assert.equal(r.state.planName, '', '누락 항목은 빈칸 (다른 기본값으로 채우지 않음)');
  assert.equal(r.state.targetMonthlyProfit, null);
  assert.deepEqual(r.state.scenarioRates, { low: 70, base: 100, high: 130 });
  assert.equal(st.getItem(S.STORAGE_KEY), raw, '원본 키는 읽기만 함');
  assert.equal(st.getItem(S.BACKUP_PREFIX + 'v1'), raw, '원본 보관');
});

test('손상된 저장값: 실패로 알리고 지우거나 덮어쓰지 않음', () => {
  for (const raw of ['{not json', JSON.stringify({ v: 99, quantity: 1 }), JSON.stringify({ v: 2, quantity: 'abc', price: 1000 })]) {
    const st = memStorage({ [S.STORAGE_KEY]: raw });
    const r = S.load(st);
    assert.equal(r.status, 'failed', raw);
    assert.equal(r.raw, raw);
    assert.equal(st.getItem(S.STORAGE_KEY), raw);
    assert.equal(S.isBlank(r.state), true);
  }
  const partial = S.load(memStorage({ [S.STORAGE_KEY]: JSON.stringify({ v: 2, quantity: 'abc', price: 1000 }) }));
  assert.equal(partial.partial.price, 1000, '읽을 수 있는 값은 별도 복구용으로 제공');
  assert.equal(partial.partial.quantity, null);
});

test('저장공간을 쓸 수 없으면 저장 실패(null)', () => {
  assert.equal(S.save(null, S.empty()), null);
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(S.save(broken, S.empty()), null);
  assert.equal(S.load({ getItem: () => { throw new Error('denied'); } }).status, 'unavailable');
});

/* ---------------- 설정 파일 ---------------- */
test('내보내기 → 불러오기: 조건과 계산 결과 동일, 빈칸·0원 구분 유지', () => {
  const s = base({ productName: '가상 제품', planName: '가상 계획', commissionRate: 0, monthlyFixed: null,
    userPresets: [S.makeUserPreset(base(), '소량')], overrides: [null, 900] });
  const text = JSON.stringify(S.exportPayload(s));
  const res = S.parseImport(text);
  assert.equal(res.ok, true);
  assert.equal(res.state.commissionRate, 0);
  assert.equal(res.state.monthlyFixed, null);
  assert.equal(res.state.userPresets[0].label, '소량');
  assert.deepEqual(C.simulate(res.state), C.simulate(s));
});

test('잘못된 파일은 거절 (형식·값 검사)', () => {
  assert.equal(S.parseImport('not json').ok, false);
  assert.equal(S.parseImport(JSON.stringify({ hello: 1 })).ok, false);
  assert.equal(S.parseImport(JSON.stringify({ format: S.FILE_FORMAT, version: 9, state: {} })).ok, false);
  const bad = S.parseImport(JSON.stringify({ format: S.FILE_FORMAT, version: 2, state: { quantity: -5, price: 'abc' } }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
  // 브라우저 저장값 원본(v1)도 불러올 수 있음
  assert.equal(S.parseImport(JSON.stringify({ v: 1, quantity: 10, price: 100 })).ok, true);
});

test('저장한 조건 적용: 수량·원가·납품가를 함께', () => {
  const p = S.makeUserPreset(base({ quantity: 900, quoteCost: 4000, price: 6000 }), '실험');
  const s = S.applyUserPreset(Object.assign(S.empty(), { userPresets: [p] }), p.id);
  assert.equal(s.quantity, 900); assert.equal(s.quoteCost, 4000); assert.equal(s.price, 6000);
  assert.equal(s.pricingBasisQty, 900);
});
