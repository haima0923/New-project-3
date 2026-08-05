const ROUTE_CASES = [
  {
    id: 'ROUTE-001',
    classification: 'FAST_LOCAL',
    executor: 'fast-local',
    title: '简单完整单商品保持本地快速路径'
  },
  {
    id: 'ROUTE-002',
    classification: 'AUTO_DEEP',
    executor: 'multi-item-auto-deep',
    title: '多商品规格边界由系统自动深度核对'
  },
  {
    id: 'ROUTE-003',
    classification: 'ASK_USER',
    executor: 'missing-product-ask-user',
    title: '缺商品名时问老板而不是让 AI 猜'
  },
  {
    id: 'ROUTE-004',
    classification: 'ASK_USER',
    executor: 'amount-conflict-ask-user',
    title: '明细合计与用户总额冲突时问老板'
  },
  {
    id: 'ROUTE-005',
    classification: 'AUTO_DEEP',
    executor: 'relation-auto-deep',
    title: '有原文证据的报价转订单可自动核对但不绕过关系门禁'
  },
  {
    id: 'ROUTE-006',
    classification: 'AUTO_DEEP',
    executor: 'trusted-quality-route',
    title: '质量模型只由可信系统路由调用'
  },
  {
    id: 'ROUTE-007',
    classification: 'AUTO_DEEP',
    executor: 'auto-deep-no-save',
    title: '自动深度核对永不自动保存'
  },
  {
    id: 'ROUTE-008',
    classification: 'ASK_USER_OR_SAFE_BLOCKED',
    executor: 'auto-review-failure-target',
    title: '自动核对失败转明确提问或安全阻断'
  }
].map((entry) => Object.assign({ expected: 'PASS' }, entry));

module.exports = {
  ROUTE_CASES
};
