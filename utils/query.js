const { decorateRecords, getDashboard } = require('./business');
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

  if (/今天|今日|待办|什么事|有啥事|要干啥/.test(source)) {
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

  if (/上次|报价|报多少|价格/.test(source) && customer) {
    const quotation = decorateRecords(state, state.quotations)
      .filter((item) => item.customerId === customer.id)
      .sort((a, b) => String(b.quoteDate).localeCompare(String(a.quoteDate)))[0];
    if (!quotation) return { title: `${customer.name} 暂无报价`, lines: ['可以先用“记一笔”录入第一条报价。'] };
    return {
      title: `${customer.name} 上次报价`,
      lines: [
        `${quotation.productName || '未填产品'}，数量 ${quotation.quantity || '-'}${quotation.unit || ''}`,
        `单价 ${quotation.unitPrice || '-'}，总价 ${quotation.totalAmount || '-'}`,
        `报价日期 ${quotation.quoteDate || '-'}，状态 ${quotation.status}`
      ]
    };
  }

  if (customer && /(?:单子|订单|货|进度).*(?:怎么样|咋样|现在|进展|状态)|(?:怎么样|咋样|现在).*(?:单子|订单|货)/.test(source)) {
    const orders = decorateRecords(state, state.orders)
      .filter((item) => item.customerId === customer.id)
      .filter((item) => !['已完成', '已取消'].includes(item.status))
      .sort((a, b) => String(a.requiredDeliveryDate || '').localeCompare(String(b.requiredDeliveryDate || '')));
    if (!orders.length) return { title: `${customer.name} 暂无进行中订单`, lines: ['没有查到未完成订单。'] };
    return {
      title: `${customer.name} 进行中订单`,
      lines: orders.slice(0, 8).map((item) => `${item.productName || '未填产品'}，${item.quantity || '-'}${item.unit || ''}，${item.requiredDeliveryDate || '-'} 交，状态 ${item.status}`)
    };
  }

  if (/还欠|欠款|欠.*多少|有没有欠|应收|还剩|没收|未收/.test(source)) {
    const receivables = decorateRecords(state, state.receivables)
      .filter((item) => !['已结清', '坏账'].includes(item.status))
      .filter((item) => !customer || item.customerId === customer.id);
    if (!receivables.length) return { title: customer ? `${customer.name} 暂无未结清欠款` : '当前没有未结清欠款', lines: [] };
    return {
      title: customer ? `${customer.name} 未结清欠款` : '未结清欠款',
      lines: receivables.slice(0, 8).map((item) => {
        const amount = Number(item.amount || 0);
        const paid = Number(item.paidAmount || 0);
        const remaining = Math.max(0, amount - paid);
        return `${item.customerDisplay}：应收${item.amount}元，剩余${remaining}元，到期 ${item.dueDate || '-'}，已收 ${item.paidAmount || 0}元`;
      })
    };
  }

  if (/月底前|月末前|本月底/.test(source) || /本周|哪些款|收款|要收/.test(source)) {
    const limitDate = /月底前|月末前|本月底/.test(source) ? endOfMonth(current) : null;
    const receivables = decorateRecords(state, state.receivables)
      .filter((item) => !['已结清', '坏账'].includes(item.status))
      .filter((item) => item.dueDate && (
        limitDate
          ? diffDays(item.dueDate, limitDate) <= 0
          : diffDays(item.dueDate, current) <= 7
      ));
    return {
      title: '近期要处理的款',
      lines: receivables.length
        ? receivables.slice(0, 8).map((item) => `${item.customerDisplay}：${item.amount}元，到期 ${item.dueDate}`)
        : ['最近 7 天没有待收款。']
    };
  }

  if (/没转订单|待跟进|跟进/.test(source)) {
    const quotations = decorateRecords(state, state.quotations)
      .filter((item) => item.status === '待确认')
      .filter((item) => /没转订单/.test(source) || (item.deliveryDate ? diffDays(item.deliveryDate, current) <= 0 : diffDays(current, item.quoteDate) >= 3));
    return {
      title: '待跟进报价',
      lines: quotations.length
        ? quotations.slice(0, 8).map((item) => `${item.customerDisplay}：${item.productName}，报价 ${item.totalAmount || '-'}元，跟进 ${item.deliveryDate || '-'}`)
        : ['暂时没有到跟进时间的报价。']
    };
  }

  if (/交货|要交|订单/.test(source)) {
    const orders = decorateRecords(state, state.orders)
      .filter((item) => !['已完成', '已取消'].includes(item.status))
      .filter((item) => item.requiredDeliveryDate && diffDays(item.requiredDeliveryDate, current) <= 7);
    return {
      title: '近期要交的货',
      lines: orders.length
        ? orders.slice(0, 8).map((item) => `${item.customerDisplay}：${item.productName}，${item.requiredDeliveryDate} 交，状态 ${item.status}`)
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
