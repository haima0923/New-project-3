const {
  decorateRecords,
  getDashboard,
  getItemsSummary,
  getOrderDepositAmount,
  getOrderRemainingSettlement,
  getRecordItems
} = require('./business');
const { diffDays, endOfMonth, today } = require('./date');

function includesName(customer, keyword) {
  if (!customer || !keyword) return false;
  return customer.name.includes(keyword) || keyword.includes(customer.name.replace(/总$/, ''));
}

function findCustomerKeyword(text, state) {
  const customers = (state.customers || []).filter((customer) => !customer.mergedInto);
  const matched = customers.find((customer) => includesName(customer, text));
  if (matched) return matched;
  const nameMatch = text.match(/([\u4e00-\u9fa5]{1,4}总)/);
  if (!nameMatch) return null;
  return customers.find((customer) => includesName(customer, nameMatch[1]));
}

function getActiveTodos(state) {
  return (state.todos || []).filter((item) => item.status !== '已完成');
}

function formatTodoLine(item) {
  const customer = item.customerDisplay ? `${item.customerDisplay}：` : '';
  const date = item.remindDate ? `，提醒 ${item.remindDate}` : '';
  return `${customer}${item.title || item.remark || '待办提醒'}${date}`;
}

function toMoneyText(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function getActiveOrders(state) {
  return decorateRecords(state, state.orders || [])
    .filter((item) => !['已完成', '已取消'].includes(item.status));
}

function getRecordProductNames(record) {
  const items = getRecordItems(record || {});
  const itemNames = items
    .reduce((list, item) => list.concat(item.productName || '', item.spec || ''), [])
    .filter(Boolean);
  return itemNames.length ? itemNames : [record && record.productName, record && record.spec].filter(Boolean);
}

function formatRecordItemLines(record) {
  return getRecordItems(record).map((item) => {
    const name = [item.productName || '未填产品', item.spec].filter(Boolean).join(' · ');
    const quantity = `${item.quantity || '-'}${item.unit || ''}`;
    const price = item.unitPrice ? `，单价 ${item.unitPrice}/${item.priceUnit || item.unit || '单位'}` : '';
    const amount = item.totalAmount ? `，小计 ${item.totalAmount}元` : '';
    return `${name}：${quantity}${price}${amount}`;
  });
}

function matchesProductInQuestion(record, text) {
  const source = String(text || '').replace(/\s+/g, '');
  return getRecordProductNames(record).some((name) => {
    const product = String(name || '').replace(/\s+/g, '');
    return product && source.includes(product);
  });
}

function getActiveReceivables(state, customer) {
  return decorateRecords(state, state.receivables || [])
    .filter((item) => !['已结清', '坏账'].includes(item.status))
    .filter((item) => !customer || item.customerId === customer.id);
}

function getReceivableRemaining(item) {
  return Math.max(0, Number(item.amount || 0) - Number(item.paidAmount || 0));
}

function formatReceivableLine(item) {
  const remaining = getReceivableRemaining(item);
  return `${item.customerDisplay}：还差${toMoneyText(remaining)}元，已收 ${toMoneyText(item.paidAmount)}元，到期 ${item.dueDate || '未设收款日'}`;
}

function getOrderMoneyLine(state, item) {
  const deposit = getOrderDepositAmount(state, item.id);
  const remaining = getOrderRemainingSettlement(state, item);
  return `${item.customerDisplay}：${getItemsSummary(item) || item.productName || '未填产品'}，订单${toMoneyText(item.totalAmount)}元，已收定金${toMoneyText(deposit)}元，待收尾款${toMoneyText(remaining)}元，状态 ${item.status}`;
}

function answerQuery(text, state) {
  const source = String(text || '').trim();
  if (!source) return { title: '还没输入问题', lines: ['可以问：谁还欠我钱？或者 王总上次报多少？'] };
  const current = today();
  const customer = findCustomerKeyword(source, state);

  if (/明天|明日/.test(source) && /待办|提醒|什么事|有啥事|要干啥/.test(source)) {
    const todos = decorateRecords(state, getActiveTodos(state))
      .filter((item) => item.remindDate && diffDays(item.remindDate, current) === 1)
      .filter((item) => !customer || item.customerId === customer.id);
    return {
      title: todos.length ? '明日待办' : '明天暂无待办',
      lines: todos.length ? todos.slice(0, 8).map(formatTodoLine) : ['明天没有记录待办提醒。']
    };
  }

  if (/今天|今日/.test(source) && /待办|提醒/.test(source)) {
    const todos = decorateRecords(state, getActiveTodos(state))
      .filter((item) => item.remindDate && diffDays(item.remindDate, current) <= 0)
      .filter((item) => !customer || item.customerId === customer.id);
    return {
      title: todos.length ? '今日待办' : '今天暂无待办',
      lines: todos.length ? todos.slice(0, 8).map(formatTodoLine) : ['今天没有到期待办提醒。']
    };
  }

  if (/待办|提醒|要做|没做|未完成/.test(source)) {
    const todos = decorateRecords(state, getActiveTodos(state))
      .filter((item) => !customer || item.customerId === customer.id)
      .sort((a, b) => String(a.remindDate || '9999-12-31').localeCompare(String(b.remindDate || '9999-12-31')));
    return {
      title: customer ? `${customer.name} 相关待办` : '未完成待办',
      lines: todos.length ? todos.slice(0, 8).map(formatTodoLine) : ['当前没有未完成待办。']
    };
  }

  if (/今天|今日|待办|什么事|有啥事|要干啥/.test(source)
    && !/交货|要交|订单|欠款|还欠|待收|收款|回款|报价|尾款|要收|哪些款/.test(source)) {
    const dashboard = getDashboard(state);
    return {
      title: `今天有 ${dashboard.totalThings} 件事`,
      lines: [
        `${dashboard.dueToday.length + dashboard.overdue.length} 笔款要处理`,
        `${dashboard.deliverySoon.length} 批货快到交期`,
        `${dashboard.quoteFollowups.length} 个报价待跟进`,
        `${(dashboard.todoActive || []).length} 个待办提醒`,
        `${dashboard.pendingNotes.length} 条记录待整理`
      ]
    };
  }

  if (/待整理|没整理|未整理/.test(source)) {
    const pendingNotes = (state.pendingNotes || []).filter((item) => item.status === '待整理');
    return {
      title: pendingNotes.length ? `有 ${pendingNotes.length} 条待整理记录` : '没有待整理记录',
      lines: pendingNotes.length
        ? pendingNotes.slice(0, 8).map((item) => item.originalText || item.reason || '未命名待整理记录')
        : ['当前没有待整理记录。']
    };
  }

  if (!customer && /(本月|这个月)/.test(source) && /收了|收到|收款|回款/.test(source) && /多少|合计|总/.test(source)) {
    const monthPrefix = current.slice(0, 7);
    const payments = (state.paymentRecords || []).filter((item) => String(item.paidAt || item.createdAt || '').slice(0, 7) === monthPrefix);
    const total = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const unlinked = payments.filter((item) => ['unlinked_payment', 'unlinked_deposit'].includes(item.kind || item.paymentKind));
    const unlinkedTotal = unlinked.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
      title: payments.length ? '本月已记录收款' : '本月暂无收款记录',
      lines: payments.length
        ? [`合计收到 ${toMoneyText(total)} 元，共 ${payments.length} 笔`]
          .concat(unlinked.length ? [`其中 ${unlinked.length} 笔、${toMoneyText(unlinkedTotal)} 元还没对应到业务，待核对。`] : [])
        : ['本月还没有记录到收款。']
    };
  }

  if (customer
    && !/定金|订金|预付/.test(source)
    && /(?:上次|最近|本月|这个月|今天).*(?:收了|收到|收款|回款)|(?:收了|收到|收款|回款).*(?:多少|几笔|记录|上次|最近)/.test(source)) {
    const payments = decorateRecords(state, state.paymentRecords || [])
      .filter((item) => item.customerId === customer.id)
      .sort((a, b) => String(b.paidAt || b.createdAt || '').localeCompare(String(a.paidAt || a.createdAt || '')));
    const total = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
      title: payments.length ? `${customer.name} 收款记录` : `${customer.name} 暂无收款记录`,
      lines: payments.length
        ? [`已收合计 ${toMoneyText(total)} 元，共 ${payments.length} 笔`].concat(payments.slice(0, 7).map((item) => `${item.paidAt || '-'} 收到 ${toMoneyText(item.amount)} 元`))
        : ['还没有记录到这位客户的收款。']
    };
  }

  if (/上次|报价|报多少|价格/.test(source) && customer) {
    const customerQuotations = decorateRecords(state, state.quotations)
      .filter((item) => item.customerId === customer.id);
    const quotations = customerQuotations.filter((item) => matchesProductInQuestion(item, source));
    const quotation = (quotations.length ? quotations : customerQuotations)
      .sort((a, b) => String(b.quoteDate).localeCompare(String(a.quoteDate)))[0];
    if (!quotation) return { title: `${customer.name} 暂无报价`, lines: ['可以先用“记一笔”录入第一条报价。'] };
    return {
      title: `${customer.name} 上次报价`,
      lines: formatRecordItemLines(quotation)
        .concat(`总价 ${quotation.totalAmount || '-'}元，报价日期 ${quotation.quoteDate || '-'}，状态 ${quotation.status}`)
    };
  }

  if ((/生产中|待结算/.test(source) || (customer && /尾款/.test(source))) && /尾款|没收|未收|待收|多少钱|多少|还差/.test(source)) {
    const orders = getActiveOrders(state)
      .filter((item) => ['待生产', '生产中', '待发货', '已发货'].includes(item.status))
      .filter((item) => !customer || item.customerId === customer.id);
    const total = orders.reduce((sum, item) => sum + getOrderRemainingSettlement(state, item), 0);
    return {
      title: customer ? `${customer.name} 订单待结算尾款` : '生产中待结算尾款',
      lines: orders.length
        ? [`合计待收尾款 ${toMoneyText(total)} 元`].concat(orders.slice(0, 7).map((item) => getOrderMoneyLine(state, item)))
        : ['当前没有生产中待结算订单。']
    };
  }

  if (/定金|订金|预付/.test(source)) {
    const orders = getActiveOrders(state)
      .filter((item) => !customer || item.customerId === customer.id)
      .map((item) => Object.assign({}, item, {
        depositAmount: getOrderDepositAmount(state, item.id)
      }))
      .filter((item) => item.depositAmount > 0);
    if (!orders.length) return { title: customer ? `${customer.name} 暂无定金记录` : '暂无定金记录', lines: [] };
    const total = orders.reduce((sum, item) => sum + item.depositAmount, 0);
    return {
      title: customer ? `${customer.name} 定金记录` : `定金合计 ${toMoneyText(total)} 元`,
      lines: orders.slice(0, 8).map((item) => getOrderMoneyLine(state, item))
    };
  }

  if (customer && /(?:单子|订单|货|进度).*(?:怎么样|咋样|现在|进展|状态)|(?:怎么样|咋样|现在).*(?:单子|订单|货)/.test(source)) {
    const customerOrders = decorateRecords(state, state.orders)
      .filter((item) => item.customerId === customer.id)
      .filter((item) => !['已完成', '已取消'].includes(item.status))
      .sort((a, b) => String(a.requiredDeliveryDate || '').localeCompare(String(b.requiredDeliveryDate || '')));
    const productMatches = customerOrders.filter((item) => matchesProductInQuestion(item, source));
    const orders = productMatches.length ? productMatches : customerOrders;
    if (!orders.length) return { title: `${customer.name} 暂无进行中订单`, lines: ['没有查到未完成订单。'] };
    return {
      title: `${customer.name} 进行中订单`,
      lines: orders.slice(0, 8).map((item) => {
        const deposit = getOrderDepositAmount(state, item.id);
        const remaining = getOrderRemainingSettlement(state, item);
        const money = deposit > 0 ? `，已收定金${toMoneyText(deposit)}元，待收尾款${toMoneyText(remaining)}元` : '';
        const itemDetail = formatRecordItemLines(item).join('；') || (getItemsSummary(item) || item.productName || '未填产品');
        return `${itemDetail}，${item.requiredDeliveryDate || '-'} 交，状态 ${item.status}${money}`;
      })
    };
  }

  if (/还欠|欠款|欠.*多少|有没有欠|应收|还剩|没收|未收|待收/.test(source)) {
    const receivables = getActiveReceivables(state, customer);
    if (!receivables.length) return { title: customer ? `${customer.name} 暂无未结清欠款` : '当前没有未结清欠款', lines: [] };
    const totalRemaining = receivables.reduce((sum, item) => sum + getReceivableRemaining(item), 0);
    const hiddenCount = Math.max(0, receivables.length - 8);
    return {
      title: customer ? `${customer.name} 未结清欠款` : '未结清欠款',
      lines: [`共 ${receivables.length} 笔，还没收合计 ${toMoneyText(totalRemaining)} 元`]
        .concat(receivables.slice(0, 8).map(formatReceivableLine))
        .concat(hiddenCount ? [`还有 ${hiddenCount} 笔未展开。`] : [])
    };
  }

  const asksForCollection = /月底前|月末前|本月底|哪些款|要收|待收/.test(source)
    || /(?:本周|今天|今日).*(?:收款|回款|欠款|款)/.test(source);
  if (asksForCollection) {
    const limitDate = /月底前|月末前|本月底/.test(source) ? endOfMonth(current) : null;
    const onlyToday = /今天|今日/.test(source);
    const receivables = getActiveReceivables(state, customer)
      .filter((item) => item.dueDate && (
        limitDate
          ? diffDays(item.dueDate, limitDate) <= 0
          : (onlyToday ? item.dueDate === current : diffDays(item.dueDate, current) <= 7)
      ));
    const totalRemaining = receivables.reduce((sum, item) => sum + getReceivableRemaining(item), 0);
    return {
      title: onlyToday ? '今天要收的款' : '近期要处理的款',
      lines: receivables.length
        ? [`共 ${receivables.length} 笔，还没收合计 ${toMoneyText(totalRemaining)} 元`].concat(receivables.slice(0, 8).map(formatReceivableLine))
        : [onlyToday ? '今天没有到期的待收款。' : '最近 7 天没有待收款。']
    };
  }

  if (/没转订单|待跟进|跟进/.test(source)) {
    const quotations = decorateRecords(state, state.quotations)
      .filter((item) => item.status === '待确认')
      .filter((item) => /没转订单/.test(source) || (item.deliveryDate ? diffDays(item.deliveryDate, current) <= 0 : diffDays(current, item.quoteDate) >= 3));
    return {
      title: '待跟进报价',
      lines: quotations.length
        ? quotations.slice(0, 8).map((item) => `${item.customerDisplay}：${getItemsSummary(item) || item.productName || '未填产品'}，报价 ${item.totalAmount || '-'}元，跟进 ${item.deliveryDate || '-'}`)
        : ['暂时没有到跟进时间的报价。']
    };
  }

  if (/交货|要交|订单/.test(source)) {
    const orders = decorateRecords(state, state.orders)
      .filter((item) => !['已完成', '已取消'].includes(item.status))
      .filter((item) => !customer || item.customerId === customer.id)
      .filter((item) => item.requiredDeliveryDate && (
        /今天|今日/.test(source)
          ? item.requiredDeliveryDate === current
          : diffDays(item.requiredDeliveryDate, current) <= 7
      ));
    return {
      title: '近期要交的货',
      lines: orders.length
        ? orders.slice(0, 8).map((item) => `${item.customerDisplay}：${getItemsSummary(item) || item.productName || '未填产品'}，${item.requiredDeliveryDate} 交，状态 ${item.status}`)
        : ['最近 7 天没有临近交期订单。']
    };
  }

  return {
    title: '我还没完全听懂',
    lines: ['可以问：谁还欠我钱？月底前要交哪些货？王总上次报多少？']
  };
}

module.exports = {
  answerQuery
};
