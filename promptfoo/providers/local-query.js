function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const parts = String(value || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return new Date();
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function addDays(dateValue, days) {
  const date = toDate(dateValue);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function endOfMonth(dateValue) {
  const date = toDate(dateValue);
  return formatDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

function buildQueryState() {
  const current = formatDate();
  const monthEnd = endOfMonth(current);

  return {
    customers: [
      { id: 'cus_wang', name: '王总' },
      { id: 'cus_ma', name: '马总' },
      { id: 'cus_chen', name: '陈总' },
      { id: 'cus_liu', name: '刘总' },
      { id: 'cus_zhou', name: '周姐' },
      { id: 'cus_laoli', name: '老李' },
    ],
    quotations: [
      {
        id: 'quo_wang_1',
        customerId: 'cus_wang',
        productName: '卡通水杯',
        quantity: '1000',
        unit: '个',
        unitPrice: '5.5',
        totalAmount: '5500',
        quoteDate: current,
        status: '待确认',
      },
    ],
    orders: [
      {
        id: 'ord_ma_1',
        customerId: 'cus_ma',
        productName: '杯垫',
        quantity: '300',
        unit: '个',
        unitPrice: '0.9',
        totalAmount: '270',
        requiredDeliveryDate: addDays(current, 3),
        status: '待生产',
        orderDate: current,
      },
    ],
    receivables: [
      {
        id: 'rec_chen_1',
        customerId: 'cus_chen',
        amount: '15000',
        paidAmount: '0',
        dueDate: monthEnd,
        status: '待收',
      },
      {
        id: 'rec_liu_1',
        customerId: 'cus_liu',
        amount: '5000',
        paidAmount: '3000',
        dueDate: monthEnd,
        status: '部分收款',
      },
      {
        id: 'rec_laoli_1',
        customerId: 'cus_laoli',
        amount: '23000',
        paidAmount: '10000',
        dueDate: addDays(current, 20),
        status: '部分收款',
      },
      {
        id: 'rec_wang_settled',
        customerId: 'cus_wang',
        amount: '15000',
        paidAmount: '15000',
        dueDate: current,
        status: '已结清',
      },
    ],
    pendingNotes: [
      {
        id: 'pending_1',
        originalText: '孙总欠款一万五，月底结',
        status: '待整理',
      },
    ],
    paymentRecords: [],
    dunningRecords: [],
    orderProgress: [],
    todos: [
      {
        id: 'todo_zhou_today',
        customerId: 'cus_zhou',
        title: '回复周姐礼品盒报价',
        productName: '礼品盒',
        remindDate: current,
        status: '待办',
      },
      {
        id: 'todo_zhou_tomorrow',
        customerId: 'cus_zhou',
        title: '跟进周姐礼品盒',
        productName: '礼品盒',
        remindDate: addDays(current, 1),
        status: '待办',
      },
    ],
  };
}

module.exports = class LocalQueryProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'local-query';
    this.config = options.config || {};
    this.baseUrl = (this.config.baseUrl || 'http://127.0.0.1:3001').replace(/\/$/, '');
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context = {}) {
    const question = context.vars?.question || prompt;
    const state = context.vars?.state || buildQueryState();
    const response = await fetch(`${this.baseUrl}/api/ai/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        question,
        state,
      }),
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        error: `Local query endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      return {
        error: `Local query endpoint returned non-JSON: ${text.slice(0, 500)}`,
      };
    }

    return {
      output: JSON.stringify(payload),
      metadata: {
        baseUrl: this.baseUrl,
        provider: payload.provider,
        readonly: payload.readonly,
      },
    };
  }
};
