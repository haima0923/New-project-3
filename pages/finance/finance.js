const {
  generateDunningMessage,
  generateReceivableFromOrder,
  recordDunning,
  recordPayment
} = require('../../utils/business');
const { buildFinanceViewModel, getRemainingAmount } = require('../../utils/finance');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

const segmentOptions = [
  { key: 'receivable', label: '待收' },
  { key: 'paid', label: '已收' },
  { key: 'settlement', label: '待结算' },
  { key: 'overdue', label: '逾期' }
];

function refreshTabBarSelected(page) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.updateSelected === 'function') {
    tabBar.updateSelected();
  }
}

function withPaymentDraft(rows, paymentAmounts) {
  return (rows || []).map((item) => Object.assign({}, item, {
    paymentAmountValue: paymentAmounts[item.id] || ''
  }));
}

function getRowsBySegment(viewModel, segment, paymentAmounts = {}) {
  if (segment === 'paid') return viewModel.paymentRows;
  if (segment === 'settlement') return viewModel.settlementRows;
  if (segment === 'overdue') return withPaymentDraft(viewModel.overdueRows, paymentAmounts);
  return withPaymentDraft(viewModel.receivableRows, paymentAmounts);
}

Page({
  data: {
    segmentOptions,
    selectedSegment: 'receivable',
    summary: {},
    stats: {},
    receivableRows: [],
    paymentRows: [],
    settlementRows: [],
    overdueRows: [],
    currentRows: [],
    paymentAmounts: {}
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    let selectedSegment = this.data.selectedSegment;
    const nextSegment = wx.getStorageSync('finance_segment');
    if (nextSegment) {
      wx.removeStorageSync('finance_segment');
      selectedSegment = nextSegment;
      this.setData({ selectedSegment });
    }
    this.load(selectedSegment);
  },

  load(segment = this.data.selectedSegment) {
    const state = getState();
    const viewModel = buildFinanceViewModel(state);
    this.setData(Object.assign({}, viewModel, {
      currentRows: getRowsBySegment(viewModel, segment, this.data.paymentAmounts)
    }));
  },

  changeSegment(event) {
    const selectedSegment = event.currentTarget.dataset.segment || 'receivable';
    const currentRows = getRowsBySegment(this.data, selectedSegment, this.data.paymentAmounts);
    this.setData({
      selectedSegment,
      currentRows
    });
  },

  updatePaymentAmount(event) {
    const id = event.currentTarget.dataset.id;
    const value = event.detail.value;
    const paymentAmounts = Object.assign({}, this.data.paymentAmounts, {
      [id]: value
    });
    const currentRows = this.data.currentRows.map((item) => (
      item.id === id ? Object.assign({}, item, { paymentAmountValue: value }) : item
    ));
    this.setData({
      paymentAmounts,
      currentRows
    });
  },

  savePayment(event) {
    const id = event.currentTarget.dataset.id;
    const amount = this.data.paymentAmounts[id];
    const number = Number(amount || 0);
    if (!number || number <= 0) {
      wx.showToast({ title: '先填本次收款金额', icon: 'none' });
      return;
    }
    const state = getState();
    const receivable = (state.receivables || []).find((item) => item.id === id);
    if (!receivable) {
      wx.showToast({ title: '没有找到这笔应收', icon: 'none' });
      return;
    }
    if (number > getRemainingAmount(receivable)) {
      wx.showToast({ title: '金额大于剩余应收', icon: 'none' });
      return;
    }
    recordPayment(state, id, amount);
    saveState(state);
    wx.showToast({ title: '收款已记录', icon: 'success' });
    const paymentAmounts = Object.assign({}, this.data.paymentAmounts);
    delete paymentAmounts[id];
    this.setData({ paymentAmounts });
    this.load();
  },

  copyDunning(event) {
    const id = event.currentTarget.dataset.id;
    const tone = event.currentTarget.dataset.tone || 'polite';
    const state = getState();
    const message = generateDunningMessage(state, id, tone);
    wx.setClipboardData({
      data: message,
      success: () => wx.showToast({ title: '催款话术已复制', icon: 'success' })
    });
  },

  markDunned(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const message = generateDunningMessage(state, id, 'polite');
    recordDunning(state, id, message);
    saveState(state);
    wx.showToast({ title: '已记录催款', icon: 'success' });
    this.load();
  },

  createReceivable(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const receivable = generateReceivableFromOrder(state, id);
    saveState(state);
    wx.showToast({
      title: receivable ? '已生成应收' : '生成失败',
      icon: receivable ? 'success' : 'none'
    });
    this.setData({ selectedSegment: 'receivable' });
    this.load('receivable');
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  }
});
