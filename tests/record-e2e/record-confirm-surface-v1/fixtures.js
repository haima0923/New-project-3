const MISSING_PRODUCT_TEXT = '王总周三交500个5元';
const SIMPLE_ORDER_TEXT = '王总订水杯100个，5元一个，8月15日交货。';
const MULTI_ITEM_TEXT = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const AMOUNT_CONFLICT_TEXT = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元；8月15日交货。';
const TWO_RISK_TEXT = '王总周三交500个5元，总价3000元';
const MISSING_CUSTOMER_TEXT = '水杯100个，5元一个，8月15日交货。';
const MISSING_DUE_DATE_TEXT = '王总订水杯100个，5元一个。';

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
    provider: 'controlled-real-surface-fixture',
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
        item('surface-large', '礼品盒', '大号', 100, 3),
        item('surface-small', '礼品盒', '小号', 200, 2)
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

function check(code, pass, expected, actual, evidenceLayer = 'PAGE_VM') {
  return {
    actual,
    code,
    evidenceLayer,
    expected,
    pass: pass === true
  };
}

module.exports = {
  AMOUNT_CONFLICT_TEXT,
  MISSING_CUSTOMER_TEXT,
  MISSING_DUE_DATE_TEXT,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  SIMPLE_ORDER_TEXT,
  TWO_RISK_TEXT,
  check,
  deepMultiItemResponse
};
