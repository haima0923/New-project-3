const {
  AMOUNT_CONFLICT_TEXT,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  SIMPLE_ORDER_TEXT,
  TWO_RISK_TEXT
} = require('./fixtures');

const RED_CASES = [
  ['UX-001', 'assistant-question', '缺商品时直接问老板一个明确问题', MISSING_PRODUCT_TEXT],
  ['UX-002', 'answer-save', '回答商品后就地更新并可保存', MISSING_PRODUCT_TEXT],
  ['UX-005', 'automatic-deep', '多商品自动后台深度核对且无手动点击', MULTI_ITEM_TEXT],
  ['UX-011-A', 'last-risk-answer', '回答最后一个风险后按钮立即恢复', MISSING_PRODUCT_TEXT],
  ['UX-011-B', 'last-risk-direct-edit', '直接编辑最后一个风险后按钮立即恢复', AMOUNT_CONFLICT_TEXT],
  ['UX-011-C', 'risk-queue', '多风险按队列一次只问一个', TWO_RISK_TEXT],
  ['UX-012-TIMEOUT', 'ai-failure', 'AI 超时转明确提问或安全阻断', MULTI_ITEM_TEXT, 'TIMEOUT'],
  ['UX-012-401', 'ai-failure', 'AI 401 转明确提问或安全阻断', MULTI_ITEM_TEXT, 'HTTP_401'],
  ['UX-012-500', 'ai-failure', 'AI 500 转明确提问或安全阻断', MULTI_ITEM_TEXT, 'HTTP_500'],
  ['UX-012-INVALID-JSON', 'ai-failure', 'AI 非法 JSON 转明确提问或安全阻断', MULTI_ITEM_TEXT, 'INVALID_JSON'],
  ['UX-012-EMPTY', 'ai-failure', 'AI 空结果转明确提问或安全阻断', MULTI_ITEM_TEXT, 'EMPTY_PAYLOAD'],
  ['UX-012-UNKNOWN-PROVIDER', 'ai-failure', 'AI 来源未知转明确提问或安全阻断', MULTI_ITEM_TEXT, 'UNKNOWN_PROVIDER'],
  ['UX-012-USER-EDIT', 'stale-user-edit', '请求中用户改原话后旧结果不得覆盖', MULTI_ITEM_TEXT],
  ['UX-012-STALE-REVISION', 'stale-revision', '晚返回旧 revision 不得覆盖新 revision', MULTI_ITEM_TEXT],
  ['UX-012-DUPLICATE', 'duplicate-request', '同一指纹与 revision 只允许一个在途请求', MULTI_ITEM_TEXT]
].map(([id, executor, title, text, networkMode]) => ({
  expected: 'PASS',
  evidenceLevel: id === 'UX-012-UNKNOWN-PROVIDER'
    ? 'Pure route / safety'
    : 'Controlled fixture + PageVM',
  id,
  executor,
  layer: 'UX',
  networkMode,
  text,
  title
}));

const GREEN_CASES = [
  ['GREEN-001', 'simple-local', '明确单商品快速路由不请求 AI', SIMPLE_ORDER_TEXT],
  ['GREEN-002', 'original-text', '原话在确认数据中完整保留', SIMPLE_ORDER_TEXT]
].map(([id, executor, title, text, networkMode]) => ({
  evidenceLevel: 'Controlled fixture + PageVM',
  expected: 'PASS', id, executor, layer: 'GREEN', networkMode, text, title
}));

const MIGRATED_RED_CASES = [
  ['GREEN-003', 'failure-no-mutation', 'AI 失败不得写 business 或 storage', MULTI_ITEM_TEXT, 'TIMEOUT'],
  ['GREEN-004', 'provenance', 'AI 不得伪造用户人工确认 provenance', MULTI_ITEM_TEXT, 'SUCCESS']
].map(([id, executor, title, text, networkMode]) => ({
  evidenceLevel: 'Controlled fixture + PageVM',
  expected: 'PASS', id, executor, layer: 'MIGRATED_RED', networkMode, text, title
}));

module.exports = {
  ALL_CASES: RED_CASES.concat(MIGRATED_RED_CASES, GREEN_CASES),
  GREEN_CASES,
  MIGRATED_RED_CASES,
  RED_CASES
};
