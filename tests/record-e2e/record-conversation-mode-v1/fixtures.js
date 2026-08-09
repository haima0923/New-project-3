const MISSING_PRODUCT_TEXT = '王总周三交500个5元';
const SIMPLE_ORDER_TEXT = '王总订水杯100个，5元一个，8月15日交货。';
const MULTI_ITEM_TEXT = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const ANSWER_TO_DEEP_TEXT = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计5000元；8月15日交货。';

function item(itemKey, productName, spec, quantity, unitPrice, unit = '个') {
  return {
    confirmationItemKey: itemKey,
    productName,
    spec,
    quantity: String(quantity),
    unit,
    unitPrice: String(unitPrice),
    priceUnit: unit,
    totalAmount: String(Number(quantity) * Number(unitPrice))
  };
}

function multiSuccessResponse() {
  return {
    provider: 'controlled-real-conversation-fixture',
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
        item('conversation-large', '礼品盒', '大号', 100, 3),
        item('conversation-small', '礼品盒', '小号', 200, 2)
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

function answerToDeepSuccessResponse() {
  return {
    provider: 'controlled-real-conversation-fixture',
    intent: 'order',
    operation: 'create_order',
    fields: {
      customerName: '宏达包装厂',
      productName: '礼品盒',
      quantity: '517',
      unit: '套',
      unitPrice: '3.8',
      priceUnit: '套',
      amount: '4676.1',
      totalAmount: '4676.1',
      calculatedAmount: '4676.1',
      dueDate: '2026-08-15',
      items: [
        item('conversation-gift', '礼品盒', '', 517, 3.8, '套'),
        item('conversation-lunch', '饭盒', '', 319, 8.5, '个')
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

function check(code, pass, expected, actual, evidenceLayer = 'PAGE_VM') {
  return { actual, code, evidenceLayer, expected, pass: pass === true };
}

module.exports = {
  ANSWER_TO_DEEP_TEXT,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  SIMPLE_ORDER_TEXT,
  answerToDeepSuccessResponse,
  check,
  multiSuccessResponse
};
