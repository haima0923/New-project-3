const { completeTodo, decorateRecords, getDashboard } = require('../../utils/business');
const { clearNextOrderFilter, requestOrderFilterReset, setNextOrderFilter } = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

Page({
  data: {
    summary: {
      totalThings: 0,
      dueToday: [],
      overdue: [],
      deliverySoon: [],
      quoteFollowups: [],
      todoActive: [],
      todoDueToday: [],
      todoOverdue: [],
      todoTomorrow: [],
      pendingNotes: []
    },
    dueToday: [],
    overdue: [],
    deliverySoon: [],
    quoteFollowups: [],
    todoActive: [],
    todoDueToday: [],
    todoOverdue: [],
    todoTomorrow: [],
    pendingNotes: []
  },

  onShow() {
    requestOrderFilterReset();
    this.load();
  },

  load() {
    const state = getState();
    const summary = getDashboard(state);
    this.setData({
      summary,
      dueToday: decorateRecords(state, summary.dueToday),
      overdue: decorateRecords(state, summary.overdue),
      deliverySoon: decorateRecords(state, summary.deliverySoon),
      quoteFollowups: decorateRecords(state, summary.quoteFollowups),
      todoActive: decorateRecords(state, summary.todoActive || []),
      todoDueToday: decorateRecords(state, summary.todoDueToday || []),
      todoOverdue: decorateRecords(state, summary.todoOverdue || []),
      todoTomorrow: decorateRecords(state, summary.todoTomorrow || []),
      pendingNotes: summary.pendingNotes
    });
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  goQuery() {
    wx.navigateTo({ url: '/pages/query/query' });
  },

  goReceivables() {
    wx.switchTab({ url: '/pages/receivables/receivables' });
  },

  goOrders() {
    clearNextOrderFilter();
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goDeliverySoonOrders() {
    setNextOrderFilter({
      preset: 'deliverySoon',
      label: '货快到期'
    });
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goQuotations() {
    wx.switchTab({ url: '/pages/quotations/quotations' });
  },

  goPending() {
    wx.navigateTo({ url: '/pages/pending/pending' });
  },

  goTodos() {
    wx.navigateTo({ url: '/pages/todos/todos' });
  },

  completeTodo(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const todo = completeTodo(state, id);
    if (!todo) {
      wx.showToast({ title: '待办不存在', icon: 'none' });
      return;
    }
    saveState(state);
    wx.showToast({ title: '已完成', icon: 'success' });
    this.load();
  }
});
