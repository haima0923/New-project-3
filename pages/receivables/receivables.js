const {
  decorateRecords,
  generateDunningMessage,
  getReceivablePaymentError,
  recordDunning,
  recordPayment
} = require('../../utils/business');
const { diffDays, today } = require('../../utils/date');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

Page({
  data: {
    receivables: [],
    paymentAmounts: {}
  },

  onShow() {
    requestOrderFilterReset();
    this.load();
  },

  load() {
    const state = getState();
    const receivables = decorateRecords(state, state.receivables)
      .filter((item) => ['待收', '部分收款'].includes(item.status))
      .map((item) => ({
      ...item,
      overdueDays: item.dueDate ? Math.max(0, -diffDays(item.dueDate, today())) : 0,
      remainingAmount: Math.max(0, Number(item.amount || 0) - Number(item.paidAmount || 0))
      }));
    this.setData({ receivables });
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  updatePaymentAmount(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({
      [`paymentAmounts.${id}`]: event.detail.value
    });
  },

  savePayment(event) {
    const id = event.currentTarget.dataset.id;
    const amount = this.data.paymentAmounts[id];
    if (!amount || Number(amount) <= 0) {
      wx.showToast({ title: '先填本次收款金额', icon: 'none' });
      return;
    }
    const state = getState();
    const receivable = (state.receivables || []).find((item) => item.id === id);
    const error = getReceivablePaymentError(receivable, amount);
    if (error) {
      wx.showToast({ title: error, icon: 'none' });
      return;
    }
    const payment = recordPayment(state, id, amount);
    if (!payment) {
      wx.showToast({ title: '这笔收款没有保存，请重试', icon: 'none' });
      return;
    }
    saveState(state);
    wx.showToast({ title: payment.completedOrderId ? '订单已完成' : '收款已记录', icon: 'success' });
    this.setData({
      [`paymentAmounts.${id}`]: ''
    });
    this.load();
  },

  copyDunning(event) {
    const id = event.currentTarget.dataset.id;
    const tone = event.currentTarget.dataset.tone;
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
  }
});
