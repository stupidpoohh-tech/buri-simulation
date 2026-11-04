/*
 * 입력 상태: 빈 기본값, 저장·복원(이 브라우저의 localStorage), 이전 버전 변환,
 * 설정 파일 내보내기·불러오기 검증.
 *
 * 원칙
 *  - 공개 기본값은 비어 있습니다. 실제 사업정보로 빈칸을 채우지 않습니다.
 *  - 빈칸(null, 미입력)과 사용자가 입력한 0은 저장·변환·파일 이동 중에도 구분합니다.
 *  - 저장값을 읽지 못하면 덮어쓰거나 지우지 않습니다. 사용자가 고를 때까지 저장을 멈춥니다.
 *  - 서버로 보내거나 다른 방문자와 공유하지 않습니다.
 */
(function (root) {
  'use strict';
  var P = (typeof module !== 'undefined' && module.exports) ? require('./products.js') : root.BuriProducts;

  var STORAGE_KEY = 'buri-sim:v1';          // 이전 버전과 같은 위치 (기존 저장값을 그대로 찾기 위함)
  var BACKUP_PREFIX = 'buri-sim:backup:';   // 변환·복원 실패 시 원본 보관 위치
  var SCHEMA = 2;
  var FILE_FORMAT = 'buri-simulation-settings';
  var OPTIONAL = ['commissionRate', 'extraSellingCost', 'oneTimeCost', 'monthlyFixed'];
  var GENERAL_RATES = { low: 75, base: 100, high: 125 };   // 사업정보가 아닌 일반 설정

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** 공개용 빈 상태 */
  function empty() {
    return {
      v: SCHEMA,
      productName: '',
      planName: '',
      quantity: null,
      months: null,
      costMode: 'quote',
      costItems: [],
      quoteCost: null,
      price: null,
      commissionRate: null,
      extraSellingCost: null,
      oneTimeCost: null,
      oneTimeSource: null,
      monthlyFixed: null,
      salesMode: 'direct',
      commonMonthly: null,
      overrides: [],
      channel: { stores: null, perStorePerDay: null, businessDays: null, otherMonthly: null },
      scenarioRates: clone(GENERAL_RATES),
      targetMonthlyProfit: null,
      pricingBasisQty: null,
      userPresets: [],
      example: false
    };
  }

  /* ---------------- 값 변환 (빈칸은 빈칸 그대로) ---------------- */
  function isBlankValue(v) { return v === null || v === undefined || v === ''; }
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v.replace(/,/g, ''))) return Number(v.replace(/,/g, ''));
    return NaN;
  }
  /**
   * 필드 하나를 읽음. 없으면 null(빈칸), 형식이 틀리면 errors 에 기록하고 null.
   * kind: 'nonneg' | 'int' | 'months' | 'any'
   */
  function readNum(raw, key, kind, errors, label) {
    var v = raw ? raw[key] : undefined;
    if (isBlankValue(v)) return null;
    var n = toNumber(v);
    var ok = !isNaN(n);
    if (ok && kind !== 'any' && n < 0) ok = false;
    if (ok && kind === 'months' && (n < 1 || n > 60)) ok = false;
    if (!ok) { errors.push(label || key); return null; }
    if (kind === 'int' || kind === 'months') n = Math.floor(n);
    return n;
  }
  function readText(raw, key, max, errors, label) {
    var v = raw ? raw[key] : undefined;
    if (isBlankValue(v)) return '';
    if (typeof v !== 'string') { errors.push(label || key); return ''; }
    return v.slice(0, max);
  }

  /**
   * 저장값·설정 파일의 상태 객체를 현재 구조(v2)로 변환합니다.
   * 누락된 항목은 빈칸으로 두며, 실제 사업정보나 다른 기본값으로 보충하지 않습니다.
   * @returns {{state:Object, errors:string[]}}
   */
  function convert(raw) {
    var errors = [];
    var s = empty();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: s, errors: ['전체 형식'] };
    s.productName = readText(raw, 'productName', 60, errors, '제품명');
    s.planName = readText(raw, 'planName', 60, errors, '계획 이름');
    s.quantity = readNum(raw, 'quantity', 'int', errors, '생산수량');
    s.months = readNum(raw, 'months', 'months', errors, '판매기간');
    if (raw.costMode !== undefined && raw.costMode !== 'quote' && raw.costMode !== 'itemized') errors.push('원가 입력 방식');
    else if (raw.costMode) s.costMode = raw.costMode;
    if (raw.costItems !== undefined) {
      if (!Array.isArray(raw.costItems)) errors.push('원가 항목');
      else s.costItems = raw.costItems.slice(0, 30).map(function (it, i) {
        it = it || {};
        var e = [];
        var item = {
          id: typeof it.id === 'string' ? it.id.slice(0, 40) : 'item' + i,
          name: readText(it, 'name', 40, e, '원가 항목 이름'),
          amount: readNum(it, 'amount', 'nonneg', e, '원가 항목 금액')
        };
        if (e.length) errors.push('원가 항목 ' + (i + 1));
        return item;
      });
    }
    s.quoteCost = readNum(raw, 'quoteCost', 'nonneg', errors, '완제품 견적 원가');
    s.price = readNum(raw, 'price', 'nonneg', errors, '납품가');
    OPTIONAL.forEach(function (k) { s[k] = readNum(raw, k, 'nonneg', errors, k); });
    if (s.oneTimeCost !== null && (raw.oneTimeSource === 'user' || raw.oneTimeSource === 'example')) s.oneTimeSource = raw.oneTimeSource;
    else if (s.oneTimeCost !== null) s.oneTimeSource = 'user';
    if (raw.salesMode !== undefined && raw.salesMode !== 'direct' && raw.salesMode !== 'channel') errors.push('판매계획 방식');
    else if (raw.salesMode) s.salesMode = raw.salesMode;
    s.commonMonthly = readNum(raw, 'commonMonthly', 'nonneg', errors, '월 판매량');
    if (raw.overrides !== undefined) {
      if (!Array.isArray(raw.overrides)) errors.push('월별 판매량');
      else s.overrides = raw.overrides.slice(0, 60).map(function (v, i) { return readNum({ v: v }, 'v', 'nonneg', errors, (i + 1) + '개월 차 판매량'); });
    }
    var c = raw.channel || {};
    if (raw.channel !== undefined && (typeof raw.channel !== 'object' || raw.channel === null)) errors.push('판매처 기준 값');
    s.channel = {
      stores: readNum(c, 'stores', 'nonneg', errors, '매장 수'),
      perStorePerDay: readNum(c, 'perStorePerDay', 'nonneg', errors, '매장당 하루 판매수량'),
      businessDays: readNum(c, 'businessDays', 'nonneg', errors, '월 영업일'),
      otherMonthly: readNum(c, 'otherMonthly', 'nonneg', errors, '기타 월 판매수량')
    };
    var r = raw.scenarioRates;
    if (r && typeof r === 'object') {
      ['low', 'base', 'high'].forEach(function (k) {
        var n = readNum(r, k, 'nonneg', errors, '시나리오 비율');
        s.scenarioRates[k] = n === null ? GENERAL_RATES[k] : n;   // 일반 설정은 기본 비율 사용 가능
      });
    }
    s.targetMonthlyProfit = readNum(raw, 'targetMonthlyProfit', 'any', errors, '목표 월 이익');
    s.pricingBasisQty = readNum(raw, 'pricingBasisQty', 'int', [], '');
    if (raw.userPresets !== undefined) {
      if (!Array.isArray(raw.userPresets)) errors.push('저장한 조건');
      else s.userPresets = raw.userPresets.slice(0, 20).map(function (p, i) {
        var e = [], q = p || {};
        var preset = {
          id: typeof q.id === 'string' ? q.id.slice(0, 40) : 'preset' + i,
          label: readText(q, 'label', 40, e, '') || '저장한 조건 ' + (i + 1),
          quantity: readNum(q, 'quantity', 'int', e, ''),
          costMode: q.costMode === 'itemized' ? 'itemized' : 'quote',
          quoteCost: readNum(q, 'quoteCost', 'nonneg', e, ''),
          price: readNum(q, 'price', 'nonneg', e, ''),
          costItems: Array.isArray(q.costItems) ? q.costItems.slice(0, 30).map(function (it, j) {
            it = it || {};
            return { id: typeof it.id === 'string' ? it.id : 'item' + j, name: readText(it, 'name', 40, e, ''), amount: readNum(it, 'amount', 'nonneg', e, '') };
          }) : []
        };
        if (e.length) errors.push('저장한 조건 ' + (i + 1));
        return preset;
      });
    }
    s.example = raw.example === true;
    return { state: s, errors: errors };
  }

  /* ---------------- 브라우저 저장공간 ---------------- */
  /**
   * 저장값을 읽습니다. 읽지 못해도 저장값을 지우거나 덮어쓰지 않습니다.
   * status: 'empty' | 'restored' | 'failed' | 'unavailable'
   */
  function load(storage) {
    var txt;
    try {
      if (!storage) return { state: empty(), status: 'unavailable' };
      txt = storage.getItem(STORAGE_KEY);
    } catch (e) { return { state: empty(), status: 'unavailable' }; }
    if (txt === null || txt === undefined) return { state: empty(), status: 'empty' };
    var obj;
    try { obj = JSON.parse(txt); } catch (e) { return { state: empty(), status: 'failed', reason: '저장 데이터가 손상되어 읽을 수 없습니다.', raw: txt }; }
    if (!obj || typeof obj !== 'object' || (obj.v !== 1 && obj.v !== SCHEMA)) {
      return { state: empty(), status: 'failed', reason: '이 버전에서 알 수 없는 저장 형식입니다.', raw: txt };
    }
    var res = convert(obj);
    if (res.errors.length) {
      // 일부 값을 읽지 못함: 자동으로 고치거나 덮어쓰지 않고, 사용자가 고르게 함
      return { state: empty(), status: 'failed', reason: '저장값 중 일부를 읽을 수 없습니다: ' + res.errors.join(', '), raw: txt, partial: res.state };
    }
    if (obj.v === 1) {
      // 이전 버전 원본은 변환 전에 한 번 보관 (덮어쓰지 않음)
      try { if (storage.getItem(BACKUP_PREFIX + 'v1') === null) storage.setItem(BACKUP_PREFIX + 'v1', txt); } catch (e) { /* 보관 실패해도 원본 키는 그대로 */ }
    }
    return { state: res.state, status: 'restored', migratedFrom: obj.v === 1 ? 1 : null, warnings: res.errors, savedAt: obj.savedAt || null };
  }

  /** 저장. 실패하면 null (저장됐다고 표시하지 않기 위함) */
  function save(storage, state) {
    try {
      if (!storage) return null;
      var obj = clone(state);
      obj.v = SCHEMA;
      obj.savedAt = new Date().toISOString();
      storage.setItem(STORAGE_KEY, JSON.stringify(obj));
      return storage.getItem(STORAGE_KEY) ? obj.savedAt : null;
    } catch (e) { return null; }
  }

  /** 읽지 못한 원본을 따로 보관 (새로 시작하기 전에 사용) */
  function backupRaw(storage, raw) {
    try {
      var key = BACKUP_PREFIX + new Date().toISOString();
      storage.setItem(key, raw);
      return key;
    } catch (e) { return null; }
  }

  /* ---------------- 설정 파일 ---------------- */
  function exportPayload(state) {
    var s = clone(state);
    delete s.savedAt;
    s.v = SCHEMA;
    return { format: FILE_FORMAT, version: SCHEMA, app: 'BURI시뮬레이션', exportedAt: new Date().toISOString(), state: s };
  }
  /**
   * 설정 파일을 먼저 검사합니다. 하나라도 형식이 맞지 않으면 불러오지 않습니다.
   * 이 앱이 내보낸 파일과, 브라우저 저장값 원본(v1·v2)을 모두 받습니다.
   */
  function parseImport(text) {
    var obj;
    if (typeof text !== 'string' || text.length > 2000000) return { ok: false, errors: ['파일이 너무 크거나 텍스트가 아닙니다.'] };
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: ['JSON 형식이 아닙니다.'] }; }
    var raw;
    if (obj && obj.format === FILE_FORMAT) {
      if (obj.version !== 1 && obj.version !== SCHEMA) return { ok: false, errors: ['지원하지 않는 설정 파일 버전입니다 (' + obj.version + ').'] };
      raw = obj.state;
    } else if (obj && (obj.v === 1 || obj.v === SCHEMA)) {
      raw = obj;
    } else {
      return { ok: false, errors: ['BURI시뮬레이션 설정 파일이 아닙니다.'] };
    }
    if (!raw || typeof raw !== 'object') return { ok: false, errors: ['설정 내용이 없습니다.'] };
    var res = convert(raw);
    if (res.errors.length) return { ok: false, errors: res.errors.map(function (e) { return '값이 올바르지 않음: ' + e; }) };
    return { ok: true, state: res.state };
  }

  /* ---------------- 상태 판단 ---------------- */
  /** 사용자가 작성한 내용이 하나도 없는지 */
  function isBlank(s) {
    if ((s.productName || '').trim() || (s.planName || '').trim()) return false;
    var nums = [s.quantity, s.months, s.quoteCost, s.price, s.commonMonthly, s.targetMonthlyProfit].concat(OPTIONAL.map(function (k) { return s[k]; }));
    if (nums.some(function (v) { return v !== null && v !== undefined; })) return false;
    if (s.costItems.length || s.userPresets.length) return false;
    if (s.overrides.some(function (v) { return v !== null && v !== undefined; })) return false;
    var c = s.channel || {};
    if ([c.stores, c.perStorePerDay, c.businessDays, c.otherMonthly].some(function (v) { return v !== null && v !== undefined; })) return false;
    return true;
  }

  /** 계산에 꼭 필요한 기본 조건 중 비어 있는 것 */
  function missingRequired(s) {
    var m = [];
    if (s.quantity === null || s.quantity === undefined || s.quantity <= 0) m.push({ key: 'quantity', label: '생산수량' });
    if (s.costMode === 'quote' ? s.quoteCost === null : !s.costItems.some(function (it) { return it.amount !== null && it.amount !== undefined; })) m.push({ key: 'cost', label: '상자당 원가' });
    if (s.price === null || s.price === undefined) m.push({ key: 'price', label: '납품가' });
    var months = s.months;
    if (months === null || months === undefined) m.push({ key: 'months', label: '판매기간' });
    var n = months || 0;
    var allOverridden = n > 0 && s.overrides.slice(0, n).filter(function (v) { return v !== null && v !== undefined; }).length === n;
    if (s.salesMode === 'channel') {
      var c = s.channel || {};
      if (!allOverridden && (c.stores === null || c.perStorePerDay === null || c.businessDays === null)) m.push({ key: 'channel', label: '판매처 기준 판매량' });
    } else if (!allOverridden && (s.commonMonthly === null || s.commonMonthly === undefined)) m.push({ key: 'sales', label: '월 판매량' });
    return m;
  }

  /** 가상 예시 적용 (사용자가 선택했을 때만) */
  function applyExample() {
    var s = empty(), e = clone(P.EXAMPLE);
    Object.keys(e).forEach(function (k) { s[k] = e[k]; });
    s.pricingBasisQty = s.quantity;
    s.example = true;
    return s;
  }
  /** 사용자가 저장한 조건 적용 */
  function applyUserPreset(state, id) {
    var p = (state.userPresets || []).filter(function (x) { return x.id === id; })[0];
    if (!p) return state;
    var s = clone(state);
    s.quantity = p.quantity; s.costMode = p.costMode; s.quoteCost = p.quoteCost; s.price = p.price;
    if (p.costMode === 'itemized') s.costItems = clone(p.costItems);
    s.pricingBasisQty = p.quantity;
    return s;
  }
  function makeUserPreset(state, label) {
    return {
      id: 'preset' + Date.now().toString(36),
      label: (label || '').trim().slice(0, 40) || ((state.quantity !== null ? state.quantity.toLocaleString('ko-KR') + '상자' : '저장한') + ' 조건'),
      quantity: state.quantity, costMode: state.costMode, quoteCost: state.quoteCost, price: state.price,
      costItems: state.costMode === 'itemized' ? clone(state.costItems) : []
    };
  }

  // 이전 이름 호환
  function defaults() { return empty(); }
  function sanitize(raw) { return convert(raw).state; }

  var api = {
    STORAGE_KEY: STORAGE_KEY, BACKUP_PREFIX: BACKUP_PREFIX, SCHEMA: SCHEMA, FILE_FORMAT: FILE_FORMAT, OPTIONAL: OPTIONAL,
    empty: empty, defaults: defaults, convert: convert, sanitize: sanitize, load: load, save: save, backupRaw: backupRaw,
    exportPayload: exportPayload, parseImport: parseImport, isBlank: isBlank, missingRequired: missingRequired,
    applyExample: applyExample, applyUserPreset: applyUserPreset, makeUserPreset: makeUserPreset, clone: clone
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuriState = api;
})(typeof self !== 'undefined' ? self : this);
