/*
 * 공개용 기본 데이터
 * ------------------------------------------------------------
 * 이 파일에는 실제 사업정보를 넣지 않습니다.
 * 처음 접속한 사람은 빈 상태에서 시작하고, 입력값은 각자의 브라우저에만 저장됩니다.
 *
 * EXAMPLE 은 실제 사업과 무관한 가상 데이터이며,
 * 사용자가 ‘예시 체험’을 선택했을 때만 적용됩니다.
 */
(function (root) {
  'use strict';

  // 원가 항목을 추가할 때 이름 제안용 일반 분류
  var COST_CATEGORIES = ['주재료', '부재료', '포장재', '제조·포장 인건비', '기타 제조비'];

  // 가상 예시 (실제 사업과 무관한 숫자)
  var EXAMPLE = {
    productName: '예시 제품 세트',
    planName: '가상 예시 계획',
    quantity: 2000,
    months: 4,
    costMode: 'itemized',
    costItems: [
      { id: 'ex-main', name: '주재료', amount: 3000 },
      { id: 'ex-sub', name: '부재료', amount: 600 },
      { id: 'ex-pack', name: '포장재', amount: 1400 },
      { id: 'ex-labor', name: '제조·포장 인건비', amount: 1000 }
    ],
    quoteCost: null,
    price: 10000,
    commonMonthly: 450
  };

  var api = { COST_CATEGORIES: COST_CATEGORIES, EXAMPLE: EXAMPLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuriProducts = api;
})(typeof self !== 'undefined' ? self : this);
