/*
 * 브라우저 검증 — 공개 배포 기준 (빈 첫 화면, 개인 저장, 설정 이전) + 기존 기능
 * 모든 숫자는 실제 사업과 무관한 가상 데이터입니다.
 * 실행: node tests/e2e/check.js  (Playwright + Chromium 필요)
 * 스크린샷 저장 위치: SHOT_DIR 환경변수 (기본: ./screenshots, 저장소에는 올리지 않음)
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const C = require('../../js/calc.js');
const S = require('../../js/state.js');

const url = 'file://' + path.resolve(__dirname, '../../index.html');
const shotDir = process.env.SHOT_DIR || path.resolve(__dirname, '../../screenshots');
let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : `  → 실제 "${actual}" / 기대 "${expected}"`));
}
// 가상 기준 조건
const BASE = { quantity: 2400, quoteCost: 5000, price: 7500, commonMonthly: 800, months: 3 };

(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (vp, init) => {
    const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 720 }, reducedMotion: 'reduce', acceptDownloads: true });
    if (init) await ctx.addInitScript(init.fn, init.arg);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('dialog', d => { p.lastDialog = d.message(); d.accept(); });
    await p.goto(url);
    return p;
  };
  const tx = (p, sel) => p.locator(sel).first().evaluate(e => e.textContent.replace(/\s+/g, ' ').trim());
  const sim = p => p.evaluate(() => window.__buri.simulate());
  const st = p => p.evaluate(() => window.__buri.getState());
  const type = async (p, sel, v) => { const el = p.locator(sel).first(); await el.fill(String(v)); await el.blur(); };
  const fillBase = async (p, o) => { o = Object.assign({}, BASE, o || {}); for (const k of ['quantity', 'quoteCost', 'price', 'commonMonthly', 'months']) await type(p, '#q-' + k, o[k]); };
  const body = p => p.locator('body').evaluate(b => b.innerText);
  const noBad = async (p, label) => check(label + ': NaN/Infinity/undefined 없음', /NaN|Infinity|undefined/.test(await p.locator('body').evaluate(b => b.textContent)), false);
  const stored = p => p.evaluate(k => localStorage.getItem(k), S.STORAGE_KEY);

  /* ================= 1. 첫 방문: 빈 상태 ================= */
  let page = await newPage();
  check('첫 방문: 저장값 없음', await stored(page), null);
  check('첫 방문: 상태 안내', (await tx(page, '#statusLine')).startsWith('기본 조건을 입력하면 결과가 표시됩니다'), true);
  for (const k of ['fundingMan', 'profitMan', 'paybackBig', 'stockBig']) check('첫 방문: ' + k + ' = —', await tx(page, '[data-out=' + k + ']'), '—');
  check('첫 방문: 입력칸 비어 있음', (await Promise.all(['#q-quantity', '#q-quoteCost', '#q-price', '#q-commonMonthly', '#q-months'].map(s => page.locator(s).inputValue()))).join(''), '');
  check('첫 방문: 제품명 영역은 미입력 안내', await tx(page, '#planName'), '제품명·계획 이름 미입력');
  check('첫 방문: 그래프 대신 안내', (await tx(page, '#cashChart')).startsWith('기본 조건'), true);
  check('첫 방문: 회수·이익 오해 문구 없음', /회수 완료|\d개월 차 회수|0원 이익/.test(await body(page)), false);
  check('첫 방문: 시나리오 비율은 일반 기본값', (await st(page)).scenarioRates.base, 100);
  check('첫 방문: 자동 저장하지 않음', await stored(page), null);
  check('저장 안내 문구', await tx(page, '#saveState'), '이 브라우저에 자동 저장됩니다');
  await noBad(page, '빈 상태');
  await page.screenshot({ path: path.join(shotDir, '1-first-visit-empty.png') });

  // 일부만 입력하면 여전히 결과 없음
  await type(page, '#q-quantity', 2400);
  await type(page, '#q-price', 7500);
  check('일부 입력: 결과 미표시', await tx(page, '[data-out=profitMan]'), '—');
  check('일부 입력: 필요한 항목 안내', (await tx(page, '#statusLine')).includes('필요: 상자당 원가, 판매기간, 월 판매량'), true);
  // ‘기본 조건 입력’ → 첫 빈칸으로 초점
  await page.click('[data-action=start]');
  check('기본 조건 입력 → 원가 칸', await page.evaluate(() => document.activeElement.id), 'q-quoteCost');

  /* ================= 2. 입력 → 계산 → 자동 저장 → 새로고침 복원 ================= */
  await fillBase(page);
  check('계산: 초기 필요자금', await tx(page, '[data-out=fundingMan]'), '1,200만 원');
  check('계산: 3개월 예상 이익', await tx(page, '[data-out=profitMan]'), '600만 원');
  check('계산: 회수 (누적 0원 지점)', await tx(page, '[data-out=paybackBig]'), '2개월 차');
  check('계산: 남은 재고', await tx(page, '[data-out=stockBig]'), '0상자');
  check('계산: 회수 마커', await page.locator('#cashChart .pay-dot').count(), 1);
  check('계산: 화면 = calc.simulate', JSON.stringify(await sim(page)), JSON.stringify(C.simulate(await st(page))));
  await page.waitForTimeout(350);
  check('자동 저장됨', (await stored(page)) !== null, true);
  check('저장 표시', (await tx(page, '#saveState')).startsWith('이 브라우저에 자동 저장됩니다 · 저장됨'), true);
  // 빈칸과 0원 구분
  await page.click('#openDrawerBtn');
  await page.click('[data-zero=commissionRate]');
  await type(page, '#f-productName', '가상 제품');
  await page.keyboard.press('Escape');
  const before = JSON.stringify(await sim(page));
  await page.waitForTimeout(350);
  await page.reload();
  check('새로고침: 계산 동일', JSON.stringify(await sim(page)), before);
  check('새로고침: 입력값 복원', await page.locator('#q-price').inputValue(), '7,500');
  check('새로고침: 0% 확인 유지', await tx(page, '[data-status=commissionRate]'), '0% 확인됨');
  check('새로고침: 미입력 유지', await tx(page, '[data-status=monthlyFixed]'), '미입력 · 계산 제외');
  check('새로고침: 제품명 표시', await tx(page, '#planName'), '가상 제품');
  check('복원 안내', (await tx(page, '#saveState')).includes('복원됨'), true);
  await page.screenshot({ path: path.join(shotDir, '2-restored.png') });

  /* ================= 3. 다른 브라우저(새 저장공간)에는 나타나지 않음 ================= */
  const other = await newPage();
  check('다른 브라우저: 빈 상태', await tx(other, '[data-out=profitMan]'), '—');
  check('다른 브라우저: 저장값 없음', await stored(other), null);
  await other.context().close();

  /* ================= 4. 내보내기 → 다른 브라우저에서 불러오기 ================= */
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const file = path.join(shotDir, 'export-test.json');
  await dl.saveAs(file);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('내보내기 파일 형식', exported.format, S.FILE_FORMAT);
  check('내보내기: 0원·미입력 구분 보존', exported.state.commissionRate === 0 && exported.state.monthlyFixed === null, true);
  const target = await newPage();
  await target.setInputFiles('#importFile', file);
  await target.waitForTimeout(300);
  check('불러오기: 계산 결과 동일', JSON.stringify(await sim(target)), before);
  check('불러오기: 0% 확인 유지', await tx(target, '[data-status=commissionRate]'), '0% 확인됨');
  check('불러오기: 빈 상태라 덮어쓰기 확인 없음', target.lastDialog, undefined);
  // 잘못된 파일 → 기존 값 유지
  const badFile = path.join(shotDir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ format: S.FILE_FORMAT, version: 2, state: { quantity: 'abc', price: -1 } }));
  const keep = JSON.stringify(await st(target));
  await target.setInputFiles('#importFile', badFile);
  await target.waitForTimeout(300);
  check('잘못된 파일: 기존 값 유지', JSON.stringify(await st(target)), keep);
  check('잘못된 파일: 안내', (await tx(target, '#toastMsg')).startsWith('불러오지 못했습니다'), true);
  fs.writeFileSync(badFile, 'this is not json');
  await target.setInputFiles('#importFile', badFile);
  await target.waitForTimeout(300);
  check('JSON 아님: 기존 값 유지', JSON.stringify(await st(target)), keep);
  // 작성 중인 값이 있으면 덮어쓰기 전에 확인
  await target.setInputFiles('#importFile', file);
  await target.waitForTimeout(300);
  check('덮어쓰기 전 확인', (target.lastDialog || '').includes('현재 작성 중인 입력값을 불러온 파일의 값으로 바꿉니다'), true);
  await target.context().close();

  /* ================= 5. 초기화: 빈 상태 저장, 되돌리기 ================= */
  await page.click('#resetBtn');
  check('초기화 확인 문구', (page.lastDialog || '').startsWith('이 브라우저에 저장된 입력값을 비웁니다'), true);
  check('초기화: 빈 상태', await tx(page, '[data-out=profitMan]'), '—');
  check('초기화: 입력칸 비움', await page.locator('#q-price').inputValue(), '');
  await page.click('#toastAction');
  check('되돌리기: 값 복구', JSON.stringify(await sim(page)), before);
  await page.click('#resetBtn');
  await page.waitForTimeout(100);
  await page.reload();
  check('초기화 후 새로고침: 빈 상태 유지', await tx(page, '[data-out=profitMan]'), '—');
  check('초기화 후 새로고침: 실제 사업정보 없음', S.isBlank(await st(page)), true);

  /* ================= 6. 예시 체험 (가상 데이터, 선택했을 때만) ================= */
  await page.click('#statusLine [data-action=example]');
  check('예시 체험: 가상 표시', (await tx(page, '#planName')).startsWith('가상 예시'), true);
  check('예시 체험: 결과 표시', (await tx(page, '[data-out=profitMan]')) !== '—', true);
  check('예시 체험: 비용은 미입력', await tx(page, '[data-out=scopeTag]'), '추가 비용 반영 전');
  await page.click('#resetBtn');

  /* ================= 7. 저장한 조건 (공개 프리셋 대신) ================= */
  await fillBase(page);
  await page.click('.nav-item[data-view=settings]'); await page.waitForTimeout(150);
  await type(page, '#presetName', '소량 테스트');
  await page.click('#savePresetBtn');
  check('조건 저장', await page.locator('#userPresets .upreset').count(), 1);
  await page.click('.nav-item[data-view=dashboard]'); await page.waitForTimeout(150);
  await type(page, '#q-quantity', 5000);
  check('수량 변경 시 단가 확인 안내', await page.locator('#priceCheck').isVisible(), true);
  await type(page, '#q-price', 9000);
  check('납품가 다시 입력하면 안내 해제', await page.locator('#priceCheck').isVisible(), false);
  await page.selectOption('#q-preset', { label: '소량 테스트' });
  check('저장한 조건 적용', (await st(page)).quantity, 2400);
  check('저장한 조건 적용: 납품가', (await st(page)).price, 7500);

  /* ================= 8. 기존 기능: 손실·미회수·재고 초과·장기 ================= */
  await type(page, '#q-price', 4500);
  check('손실: 적자 구조', (await tx(page, '[data-out=profitSub]')).includes('적자 구조'), true);
  check('손실: 상태 요약', (await tx(page, '#statusLine')).includes('기간 손실 예상'), true);
  await type(page, '#q-price', 7500);
  await type(page, '#q-commonMonthly', 400);
  check('일부 판매: 미회수', await tx(page, '[data-out=paybackBig]'), '기간 내 미회수');
  check('일부 판매: 남은 재고', await tx(page, '[data-out=stockBig]'), '1,200상자');
  await type(page, '#q-commonMonthly', 1200);
  check('재고 초과: 상태 요약', (await tx(page, '#statusLine')).startsWith('판매계획이 생산량 초과'), true);
  await type(page, '#q-commonMonthly', 0);
  check('판매 0: 상태 요약', (await tx(page, '#statusLine')).startsWith('판매 없음'), true);
  await type(page, '#q-commonMonthly', 100); await type(page, '#q-months', 36);
  const overlap = await page.evaluate(() => {
    const svg = document.querySelector('#cashChart svg'); const H = svg.viewBox.baseVal.height;
    const ts = [...svg.querySelectorAll('text.axis')].filter(t => +t.getAttribute('y') > H - 20).map(t => t.getBoundingClientRect());
    for (let i = 1; i < ts.length; i++) if (ts[i].left < ts[i - 1].right + 2) return true; return false;
  });
  check('장기 계획: 라벨 겹침 없음', overlap, false);
  check('장기 계획: 이익 라벨', await tx(page, '[data-out=profitLabel]'), '36개월 예상 이익');
  await noBad(page, '장기');
  // 판매기간을 지우면 다시 결과 숨김 (0개월로 계산하지 않음)
  await type(page, '#q-months', '');
  check('판매기간 비움: 결과 숨김', await tx(page, '[data-out=paybackBig]'), '—');
  await type(page, '#q-months', 3); await type(page, '#q-commonMonthly', 800);
  // 키보드 조건 수정 패널
  await page.locator('#openDrawerBtn').focus(); await page.keyboard.press('Enter');
  await page.waitForSelector('#drawer:not([hidden])');
  await page.keyboard.press('Escape');
  check('패널 닫으면 초점 복귀', await page.evaluate(() => document.activeElement.id), 'openDrawerBtn');
  // 설정 이전 안내 화면
  await page.click('.nav-item[data-view=settings]'); await page.waitForTimeout(150);
  await page.locator('#transfer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotDir, '3-transfer-guide.png') });
  await page.context().close();

  /* ================= 9. 기존 사용자 저장값(이전 버전) 유지 ================= */
  const v1 = { v: 1, productName: '이전 버전 가상 제품', quantity: 2400, months: 3, costMode: 'quote', costItems: [], quoteCost: 5000, price: 7500,
    commissionRate: null, extraSellingCost: 0, oneTimeCost: null, monthlyFixed: null, salesMode: 'direct', commonMonthly: 800, overrides: [],
    channel: { stores: null, perStorePerDay: null, businessDays: null, otherMonthly: null }, scenarioRates: { low: 75, base: 100, high: 125 } };
  const seed = { fn: ([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, arg: [S.STORAGE_KEY, JSON.stringify(v1)] };
  const old = await newPage(null, seed);
  check('이전 버전 저장값: 복원', await tx(old, '[data-out=profitMan]'), '600만 원');
  check('이전 버전 저장값: 제품명', await tx(old, '#planName'), '이전 버전 가상 제품');
  check('이전 버전 저장값: 0원 확인 유지', await tx(old, '[data-status=extraSellingCost]'), '0원 확인됨');
  check('이전 버전 저장값: 원본 보관', await old.evaluate(k => localStorage.getItem(k), S.BACKUP_PREFIX + 'v1'), JSON.stringify(v1));
  check('이전 버전 저장값: 누락 항목은 빈칸', (await st(old)).planName, '');
  await old.context().close();

  /* ================= 10. 손상된 저장값: 덮어쓰지 않고 선택하게 함 ================= */
  const corrupt = '{"v":2,"quantity":';
  const bad = await newPage(null, { fn: seed.fn, arg: [S.STORAGE_KEY, corrupt] });
  check('손상 저장값: 복원 실패 안내', await bad.locator('#restoreFail').isVisible(), true);
  check('손상 저장값: 자동 저장 멈춤 표시', (await tx(bad, '#saveState')).startsWith('자동 저장 멈춤'), true);
  await fillBase(bad);
  await bad.waitForTimeout(400);
  check('손상 저장값: 입력해도 원본 그대로', await stored(bad), corrupt);
  await bad.screenshot({ path: path.join(shotDir, '4-restore-failed.png') });
  await bad.click('#freshStartBtn');
  await bad.waitForTimeout(200);
  const backups = await bad.evaluate(p => Object.keys(localStorage).filter(k => k.startsWith(p)).map(k => localStorage.getItem(k)), S.BACKUP_PREFIX);
  check('새로 시작: 원본 따로 보관', backups.includes(corrupt), true);
  check('새로 시작: 빈 상태 저장', S.isBlank(JSON.parse(await stored(bad))), true);
  await bad.context().close();

  /* ================= 11. 저장할 수 없는 환경 ================= */
  const noStore = await newPage(null, { fn: () => { Storage.prototype.setItem = function () { throw new Error('blocked'); }; }, arg: null });
  await fillBase(noStore);
  await noStore.waitForTimeout(350);
  check('저장 불가: 저장됐다고 표시하지 않음', (await tx(noStore, '#saveState')).startsWith('저장되지 않음'), true);
  check('저장 불가: 내보내기 안내', await noStore.locator('#saveState [data-action=export]').count(), 1);
  check('저장 불가에서도 계산', await tx(noStore, '[data-out=profitMan]'), '600만 원');
  await noStore.context().close();

  /* ================= 12. 모바일 ================= */
  const mp = await newPage({ width: 390, height: 844 });
  check('모바일 빈 상태: 가로 넘침 없음', await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mp.screenshot({ path: path.join(shotDir, '5-mobile-empty.png'), fullPage: true });
  await fillBase(mp);
  check('모바일 입력·계산', await tx(mp, '[data-out=paybackBig]'), '2개월 차');
  await mp.waitForTimeout(350);
  await mp.reload();
  check('모바일 저장·복원', await tx(mp, '[data-out=paybackBig]'), '2개월 차');
  check('모바일 결과: 가로 넘침 없음', await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mp.click('#openDrawerBtn'); await mp.waitForSelector('#drawer:not([hidden])');
  check('모바일 하단 패널 닫기 버튼', await mp.locator('#drawerClose').isVisible(), true);
  await mp.screenshot({ path: path.join(shotDir, '6-mobile-restored.png'), fullPage: true });
  await mp.context().close();

  try { fs.unlinkSync(file); fs.unlinkSync(badFile); } catch (e) { /* 정리 */ }
  check('스크립트 오류 없음', errors.join(' | '), '');
  await browser.close();
  console.log(failed ? `\n${failed}건 실패` : '\n모든 브라우저 검증 통과');
  process.exit(failed ? 1 : 0);
})();
