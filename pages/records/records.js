const { buildAllRecords, buildTodayTaskRecords } = require('../../utils/home-workbench');
const { consumeNextRecordFilter, requestOrderFilterReset } = require('../../utils/navigation-state');
const { getState } = require('../../utils/storage');

const filterOptions = [
  { type: 'all', label: '全部' },
  { type: 'workbench', label: '待处理' },
  { type: 'quotation', label: '报价' },
  { type: 'order', label: '订单' },
  { type: 'receivable', label: '应收' },
  { type: 'payment', label: '收款' },
  { type: 'todo', label: '提醒' },
  { type: 'pending', label: '待整理' }
];

function refreshTabBarSelected(page) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.updateSelected === 'function') {
    tabBar.updateSelected();
  }
}

Page({
  data: {
    filterOptions,
    selectedType: 'all',
    records: []
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    const nextFilter = consumeNextRecordFilter();
    if (nextFilter) this.setData({ selectedType: nextFilter });
    this.load();
  },

  load() {
    const state = getState();
    this.setData({
      records: this.buildRecords(state, this.data.selectedType)
    });
  },

  changeFilter(event) {
    const selectedType = event.currentTarget.dataset.type || 'all';
    this.setFilter(selectedType);
  },

  setFilter(selectedType) {
    const state = getState();
    this.setData({
      selectedType,
      records: this.buildRecords(state, selectedType)
    });
  },

  buildRecords(state, selectedType) {
    if (selectedType === 'workbench') return buildTodayTaskRecords(state);
    return buildAllRecords(state, selectedType);
  },

  touchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this.swipeStartX = touch.clientX;
    this.swipeStartY = touch.clientY;
  },

  touchEnd(event) {
    const changedTouch = event.changedTouches && event.changedTouches[0];
    if (!changedTouch || this.swipeStartX === undefined || this.swipeStartY === undefined) return;
    const dx = changedTouch.clientX - this.swipeStartX;
    const dy = changedTouch.clientY - this.swipeStartY;
    this.swipeStartX = undefined;
    this.swipeStartY = undefined;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    const currentIndex = filterOptions.findIndex((item) => item.type === this.data.selectedType);
    if (currentIndex < 0) return;
    const nextIndex = dx < 0
      ? Math.min(filterOptions.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    if (nextIndex === currentIndex) return;
    this.setFilter(filterOptions[nextIndex].type);
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  openRecord(event) {
    const type = event.currentTarget.dataset.type;
    if (type === 'quotation') {
      wx.navigateTo({ url: '/pages/quotations/quotations' });
      return;
    }
    if (type === 'order') {
      wx.navigateTo({ url: '/pages/orders/orders' });
      return;
    }
    if (type === 'receivable' || type === 'payment') {
      wx.setStorageSync('finance_segment', type === 'payment' ? 'paid' : 'receivable');
      wx.switchTab({ url: '/pages/finance/finance' });
      return;
    }
    if (type === 'todo') {
      wx.navigateTo({ url: '/pages/todos/todos' });
      return;
    }
    if (type === 'pending') {
      wx.navigateTo({ url: '/pages/pending/pending' });
      return;
    }
    wx.switchTab({ url: '/pages/input/input' });
  }
});
