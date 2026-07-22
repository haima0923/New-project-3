const { buildAllRecords, buildTodayTaskRecords } = require('../../utils/home-workbench');
const { softDeleteRecord } = require('../../utils/business');
const { consumeNextRecordFilter, requestOrderFilterReset } = require('../../utils/navigation-state');
const { getRecordDetailUrl } = require('../../utils/record-detail');
const { getState, saveState } = require('../../utils/storage');

const filterOptions = [
  { type: 'all', label: '全部' },
  { type: 'workbench', label: '待处理' },
  { type: 'quotation', label: '报价' },
  { type: 'order', label: '订单' },
  { type: 'receivable', label: '待收' },
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
    records: [],
    openSwipeKey: ''
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
    const records = this.buildRecords(state, this.data.selectedType).map((item) => Object.assign({}, item, {
      swipeKey: `${item.type}:${item.sourceId || item.id}`
    }));
    this.setData({
      records,
      openSwipeKey: ''
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

  recordTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this.recordSwipe = {
      key: event.currentTarget.dataset.key,
      startX: touch.clientX,
      startY: touch.clientY
    };
  },

  recordTouchEnd(event) {
    const changedTouch = event.changedTouches && event.changedTouches[0];
    const swipe = this.recordSwipe;
    this.recordSwipe = null;
    if (!changedTouch || !swipe || swipe.key !== event.currentTarget.dataset.key) return;
    const dx = changedTouch.clientX - swipe.startX;
    const dy = changedTouch.clientY - swipe.startY;
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    this.recordSwipeFinishedAt = Date.now();
    this.setData({ openSwipeKey: dx > 0 ? swipe.key : '' });
  },

  closeSwipe() {
    this.setData({ openSwipeKey: '' });
  },

  deleteRecord(event) {
    const type = event.currentTarget.dataset.type;
    const id = event.currentTarget.dataset.id;
    if (!type || !id) return;
    const labels = { quotation: '报价', order: '订单', receivable: '待收款', payment: '收款', todo: '提醒', pending: '待整理' };
    const label = labels[type] || '记录';
    const extra = type === 'payment'
      ? '删除后会同步回退对应待收款里的已收金额。'
      : '删除后会移出业务列表，并保留操作日志。';
    wx.showModal({
      title: `删除这条${label}？`,
      content: extra,
      confirmText: '删除',
      confirmColor: '#D92D20',
      success: (result) => {
        if (!result.confirm) {
          this.closeSwipe();
          return;
        }
        const state = getState();
        const deleted = softDeleteRecord(state, type, id);
        if (!deleted.ok) {
          wx.showToast({ title: deleted.error || '不能删除这条记录', icon: 'none' });
          this.closeSwipe();
          return;
        }
        saveState(state);
        wx.showToast({ title: '已删除并记录日志', icon: 'success' });
        this.load();
      }
    });
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  openRecord(event) {
    if (this.recordSwipeFinishedAt && Date.now() - this.recordSwipeFinishedAt < 300) {
      return;
    }
    const key = event.currentTarget.dataset.key;
    if (this.data.openSwipeKey) {
      this.closeSwipe();
      return;
    }
    const type = event.currentTarget.dataset.type;
    const id = event.currentTarget.dataset.id;
    const url = getRecordDetailUrl(type, id);
    if (url) {
      wx.navigateTo({ url });
      return;
    }
    wx.switchTab({ url: '/pages/input/input' });
  }
});
