const CORE_TEXT = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；8月15日交货。';

const CORE_ITEMS = Object.freeze([
  Object.freeze({
    productName: '礼品盒',
    quantity: '517',
    unit: '套',
    unitPrice: '3.8',
    priceUnit: '套',
    totalAmount: '1964.6'
  }),
  Object.freeze({
    productName: '饭盒',
    quantity: '319',
    unit: '个',
    unitPrice: '8.5',
    priceUnit: '个',
    totalAmount: '2711.5'
  })
]);

const cases = [
  {
    caseId: 'REC-E2E-MIO-RED-001',
    contractKind: 'RED',
    layer: 'LOCAL_PARSER',
    title: '客户名完整保留',
    scenario: '核心原文必须由真实本地 parser 识别完整客户名。',
    productionLocations: ['utils/parser.js:445'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-002',
    contractKind: 'RED',
    layer: 'CONTROLLED_AI_MERGE',
    title: 'AI 等数量商品错配保护',
    scenario: 'AI 仍返回两个商品但交换数量、单位和价格，总额保持相同。',
    productionLocations: ['utils/ai-parser.js:2052', 'utils/ai-parser.js:2459'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-003',
    contractKind: 'RED',
    layer: 'CONTROLLED_AI_MERGE',
    title: 'AI 不得删除第二项明确事实',
    scenario: '本地已提取饭盒单价8.5，AI两项结果删除第二项单价。',
    productionLocations: ['utils/ai-parser.js:2052', 'utils/parse-safety.js:94'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-004',
    contractKind: 'RED',
    layer: 'CONTROLLED_AI_SAFETY',
    title: '包装厂不能制造包装备注风险',
    scenario: '客户行业名称中的“包装”不能变成特殊包装要求。',
    productionLocations: ['utils/parse-safety.js:22', 'utils/parse-safety.js:178'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-005',
    contractKind: 'RED',
    layer: 'DOMAIN_AND_BUSINESS',
    title: '顶层总额必须与商品合计一致',
    scenario: '覆盖内部错误总额与用户明示冲突总额两种来源。',
    productionLocations: ['utils/record-domain-preflight.js:1128', 'utils/business.js:183', 'utils/parser.js:2056'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-006',
    contractKind: 'RED',
    layer: 'BUSINESS_IDEMPOTENCY',
    title: '同一次保存操作必须幂等',
    scenario: '相同 confirmationSessionId/operationId 重放一次，新的身份允许另存。',
    productionLocations: ['utils/business.js:829', 'utils/business.js:856'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-RED-007',
    contractKind: 'RED',
    layer: 'FORMAL_SAVE_ZERO_MUTATION',
    title: 'SAVE_FORMAL 阻断时零 mutation',
    scenario: '缺失正式订单硬合同交期时，正式保存不得自动写待整理。',
    productionLocations: ['utils/business.js:1153', 'utils/business.js:1170'],
    baselineExpectation: 'CASE_FAIL'
  },
  {
    caseId: 'REC-E2E-MIO-GREEN-001',
    contractKind: 'GREEN_CONTROL',
    layer: 'BUSINESS_CONTROL',
    title: '正确 final draft 单次保存',
    scenario: '可信确认稿只验证 business 条件式 happy path。',
    productionLocations: ['utils/business.js:768'],
    baselineExpectation: 'PASS'
  },
  {
    caseId: 'REC-E2E-MIO-GREEN-002',
    contractKind: 'GREEN_CONTROL',
    layer: 'BUSINESS_CONTROL',
    title: '原文未提供第二项价格时保留不完整商品',
    scenario: '缺价是用户原始事实，不得与 AI 删除已提取价格混淆。',
    productionLocations: ['utils/business.js:154'],
    baselineExpectation: 'PASS'
  },
  {
    caseId: 'REC-E2E-MIO-GREEN-003',
    contractKind: 'GREEN_CONTROL',
    layer: 'SINGLE_ITEM_REGRESSION_CONTROL',
    title: '单商品兼容',
    scenario: '新增多商品断言不得破坏旧单商品订单。',
    productionLocations: ['utils/business.js:144', 'utils/business.js:768'],
    baselineExpectation: 'PASS'
  }
];

module.exports = {
  CORE_ITEMS,
  CORE_TEXT,
  cases
};
