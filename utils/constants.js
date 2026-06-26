const INTENT_LABELS = {
  quotation: '报价',
  order: '订单',
  receivable: '应收款',
  payment: '收款',
  dunning: '催款',
  todo: '待办提醒',
  query: '问一句',
  unknown: '待判断'
};

const INPUT_SOURCE_LABELS = {
  voice: '语音',
  typed: '手动输入',
  paste: '粘贴聊天'
};

const QUOTATION_STATUS = ['待确认', '已下单', '已作废'];
const ORDER_STATUS = ['待生产', '生产中', '待发货', '已发货', '已完成', '已取消'];
const RECEIVABLE_STATUS = ['待收', '部分收款', '已结清', '坏账'];
const PENDING_STATUS = ['待整理', '已转正式记录', '已忽略'];

const INDUSTRIES = ['饰品', '玩具', '五金', '箱包', '文具', '日用品', '家电', '其他'];

module.exports = {
  INDUSTRIES,
  INPUT_SOURCE_LABELS,
  INTENT_LABELS,
  ORDER_STATUS,
  PENDING_STATUS,
  QUOTATION_STATUS,
  RECEIVABLE_STATUS
};
