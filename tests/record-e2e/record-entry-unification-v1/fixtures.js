const MISSING_PRODUCT_TEXT = '王总周三交500个5元';
const SIMPLE_ORDER_TEXT = '王总订水杯100个，5元一个，8月15日交货。';
const PASTE_ORDER_TEXT = '王总：订水杯100个，5元一个，8月15日交货。';
const VOICE_ORDER_TEXT = '王总订水杯100个5元一个8月15日交货';
const MULTI_ITEM_TEXT = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const STALE_TEXT_A = '王总订礼品盒10个，3元一个，8月15日交货。';
const NEW_TEXT_B = '李总订饭盒20个，5元一个，8月16日交货。';

function multiSuccessResponse() {
  return {
    provider: 'controlled-real-entry-fixture',
    intent: 'order',
    operation: 'create_order',
    fields: {
      customerName: '王总',
      productName: '礼品盒',
      spec: '大号',
      quantity: '100',
      unit: '个',
      unitPrice: '3',
      priceUnit: '个',
      amount: '700',
      totalAmount: '700',
      calculatedAmount: '700',
      dueDate: '2026-08-15',
      items: [
        {
          confirmationItemKey: 'entry-large', productName: '礼品盒', spec: '大号',
          quantity: '100', unit: '个', unitPrice: '3', priceUnit: '个', totalAmount: '300'
        },
        {
          confirmationItemKey: 'entry-small', productName: '礼品盒', spec: '小号',
          quantity: '200', unit: '个', unitPrice: '2', priceUnit: '个', totalAmount: '400'
        }
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

const FORBIDDEN_HANDOFF_KEYS = Object.freeze([
  'parseResult', 'fields', 'route', 'parse_route', 'routeDecision', 'clientRoute', 'requestedRoute', 'reviewMode',
  'autoDeep', 'modelTier', 'provider', 'providerKind', 'manual_fields',
  'manual_item_fields', 'user_manual_edits', 'proof', 'activeQuestion',
  'formalReady', 'formal_ready', 'disableFormalSave', 'preflight', 'preflightResult',
  'domainPreflight', 'domain_preflight', 'saveEligibility', 'safety'
]);

module.exports = {
  FORBIDDEN_HANDOFF_KEYS,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  NEW_TEXT_B,
  PASTE_ORDER_TEXT,
  SIMPLE_ORDER_TEXT,
  STALE_TEXT_A,
  VOICE_ORDER_TEXT,
  multiSuccessResponse
};
