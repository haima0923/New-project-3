const { buildAllRecords, buildTodayTaskRecords } = require('../../utils/home-workbench');
const { cancelQuotation: cancelQuotationBusiness, softDeleteRecord } = require('../../utils/business');
const { consumeNextRecordFilter, requestOrderFilterReset } = require('../../utils/navigation-state');
const {
  getQuotationConversionUrl,
  getQuotationConversionView,
  getRecordDetailUrl
} = require('../../utils/record-detail');
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
    const records = this.buildRecords(state, this.data.selectedType);
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
    const records = selectedType === 'workbench'
      ? buildTodayTaskRecords(state)
      : buildAllRecords(state, selectedType);
    return records.map((item) => {
      const sourceId = item.sourceId || item.id;
      const base = Object.assign({}, item, {
        swipeKey: `${item.type}:${sourceId}`
      });
      if (item.type !== 'quotation') return base;
      const quotation = (state.quotations || []).find((candidate) => candidate.id === sourceId);
      if (!quotation) return Object.assign(base, { hasQuotationSwipeActions: false });
      const conversionView = getQuotationConversionView(state, quotation);
      const hasQuotationSwipeActions = Boolean(
        conversionView.canCancelQuotation
        || conversionView.canConvertToOrder
        || conversionView.canViewConvertedOrder
      );
      return Object.assign(base, conversionView, {
        hasQuotationSwipeActions,
        quotationRelationMessage: conversionView.hasQuotationOrderConflict
          ? '报价与订单关系异常'
          : '',
        status: conversionView.hasQuotationOrderConflict ? '关系异常' : quotation.status
      });
    });
  },

  recordTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const key = event.currentTarget.dataset.key;
    const record = this.data.records.find((item) => item.swipeKey === key);
    this.recordSwipe = {
      hasActions: record ? record.hasQuotationSwipeActions !== false : true,
      key,
      startX: touch.clientX,
      startY: touch.clientY,
      type: record ? record.type : event.currentTarget.dataset.type
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
    if (swipe.type === 'quotation') {
      this.setData({ openSwipeKey: dx < 0 && swipe.hasActions ? swipe.key : '' });
      return;
    }
    this.setData({ openSwipeKey: dx > 0 ? swipe.key : '' });
  },

  closeSwipe() {
    this.setData({ openSwipeKey: '' });
  },

  requestCancelQuotation(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (!id) return;
    wx.showModal({
      title: '确认取消这张报价？',
      content: '取消后会保留报价记录，但不能再转为订单，也不会继续提醒跟进。',
      confirmText: '取消报价',
      confirmColor: '#D92D20',
      success: (result) => {
        if (!result.confirm) {
          this.closeSwipe();
          return;
        }
        const state = getState();
        const cancelled = cancelQuotationBusiness(state, id);
        if (!cancelled.ok) {
          if (cancelled.code === 'QUOTATION_ORDER_RELATION_CONFLICT') {
            wx.showModal({
              title: '报价与订单关系异常',
              content: '这张报价的订单关系需要先核对，当前不能取消。',
              showCancel: false
            });
          } else {
            const messages = {
              QUOTATION_ALREADY_CANCELLED: '这张报价已经取消',
              QUOTATION_ALREADY_CONVERTED: '这张报价已经转成订单，不能取消报价',
              QUOTATION_ID_CONFLICT: '报价编号存在冲突，请先核对',
              QUOTATION_NOT_FOUND: '报价不存在，请刷新后重试',
              QUOTATION_STATUS_INELIGIBLE: '当前报价不能取消'
            };
            wx.showToast({ title: messages[cancelled.code] || '当前报价不能取消', icon: 'none' });
          }
          this.closeSwipe();
          return;
        }
        saveState(state, { writerSource: 'RECORD_SOFT_DELETE' });
        wx.showToast({ title: '报价已取消', icon: 'success' });
        this.load();
      }
    });
  },

  openQuotationConversion(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const state = getState();
    const quotation = (state.quotations || []).find((item) => item.id === id);
    if (!quotation) return;
    const conversionView = getQuotationConversionView(state, quotation);
    if (!conversionView.canConvertToOrder) return;
    const url = getQuotationConversionUrl(id);
    if (url) wx.navigateTo({ url });
  },

  openQuotationOrder(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const state = getState();
    const quotation = (state.quotations || []).find((item) => item.id === id);
    if (!quotation) return;
    const conversionView = getQuotationConversionView(state, quotation);
    if (!conversionView.canViewConvertedOrder || !conversionView.relatedOrderId) return;
    const url = getRecordDetailUrl('order', conversionView.relatedOrderId);
    if (url) wx.navigateTo({ url });
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
        saveState(state, { writerSource: 'RECORD_SOFT_DELETE' });
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
