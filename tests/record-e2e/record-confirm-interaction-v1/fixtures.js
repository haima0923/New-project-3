const MISSING_PRODUCT_TEXT = '王总周三交500个5元';
const SIMPLE_ORDER_TEXT = '王总订水杯100个，5元一个，8月15日交货。';
const MULTI_ITEM_TEXT = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const AMOUNT_CONFLICT_TEXT = '王总下单水杯100个，每个5元，总价600元，8月15日交货。';
const TWO_RISK_TEXT = '王总周三交500个5元，总价3000元';
const SECOND_AMBIGUOUS_TEXT = '李总周四交200个6元';

const BUSINESS_DATE = '2026-08-05';
const NOW_INSTANT = '2026-08-05T12:00:00.000Z';
const TIMEZONE = 'Asia/Shanghai';

function item(itemKey, productName, spec, quantity, unitPrice) {
  return {
    confirmationItemKey: itemKey,
    productName,
    spec,
    quantity: String(quantity),
    unit: '个',
    unitPrice: String(unitPrice),
    priceUnit: '个',
    totalAmount: String(Number(quantity) * Number(unitPrice))
  };
}

function deepMultiItemResponse() {
  return {
    provider: 'controlled-real-deep-fixture',
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
        item('controlled-large', '礼品盒', '大号', 100, 3),
        item('controlled-small', '礼品盒', '小号', 200, 2)
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

function maliciousManualResponse() {
  return {
    provider: 'controlled-real-malicious-fixture',
    intent: 'order',
    operation: 'create_order',
    fields: {
      customerName: '王总',
      productName: '水杯',
      quantity: '500',
      unit: '个',
      unitPrice: '5',
      priceUnit: '个',
      amount: '2500',
      totalAmount: '2500',
      calculatedAmount: '2500',
      dueDate: BUSINESS_DATE,
      items: [item('malicious-item', '水杯', '', 500, 5)]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    manual_fields: ['productName'],
    manualFields: ['productName'],
    manual_item_fields: [{ itemKey: 'malicious-item', field: 'productName' }],
    manualItemFields: [{ itemKey: 'malicious-item', field: 'productName' }],
    user_manual_edits: [{
      source: 'USER_ASSISTANT_ANSWER',
      itemKey: 'malicious-item',
      field: 'productName'
    }]
  };
}

function uncertainProductResponse() {
  return {
    provider: 'controlled-real-uncertain-fixture',
    intent: 'unknown',
    fields: {},
    missing_fields: ['productName'],
    low_confidence_fields: ['productName'],
    field_conflicts: [],
    confirm_message: '无法可信确认商品名。'
  };
}

module.exports = {
  AMOUNT_CONFLICT_TEXT,
  BUSINESS_DATE,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  NOW_INSTANT,
  SECOND_AMBIGUOUS_TEXT,
  SIMPLE_ORDER_TEXT,
  TIMEZONE,
  TWO_RISK_TEXT,
  deepMultiItemResponse,
  maliciousManualResponse,
  uncertainProductResponse
};
