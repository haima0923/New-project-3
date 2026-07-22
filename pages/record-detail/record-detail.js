const { buildRecordDetail, getRecordDetailUrl } = require('../../utils/record-detail');
const { getState } = require('../../utils/storage');

Page({
  data: {
    id: '',
    type: '',
    detail: null,
    notFound: false
  },

  onLoad(options) {
    this.setData({
      id: options.id || '',
      type: options.type || ''
    });
  },

  onShow() {
    this.load();
  },

  load() {
    const detail = buildRecordDetail(getState(), this.data.type, this.data.id);
    this.setData({ detail, notFound: !detail });
    if (detail && detail.typeLabel) wx.setNavigationBarTitle({ title: detail.typeLabel });
  },

  openCustomer() {
    const customerId = this.data.detail && this.data.detail.customerId;
    if (!customerId) return;
    wx.navigateTo({ url: `/pages/customer/customer?id=${encodeURIComponent(customerId)}` });
  },

  openOrder() {
    const orderId = this.data.detail && this.data.detail.relatedOrderId;
    const url = getRecordDetailUrl('order', orderId);
    if (url) wx.navigateTo({ url });
  },

  editOrder() {
    const detail = this.data.detail;
    if (!detail || detail.type !== 'order' || !detail.id) return;
    wx.setStorageSync('record_to_edit', { type: 'order', id: detail.id });
    wx.switchTab({ url: '/pages/input/input' });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: '/pages/records/records' });
  }
});
