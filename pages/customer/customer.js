const { decorateRecords, getItemsSummary, markDuplicateCustomerReviewed, mergeCustomer } = require('../../utils/business');
const { getCustomerDisplay, getState, saveState } = require('../../utils/storage');

function normalizeCustomerName(name) {
  return String(name || '').trim().replace(/总$/, '');
}

function getActiveCustomers(state) {
  return (state.customers || []).filter((customer) => !customer.mergedInto);
}

function getDuplicateNameCounts(customers) {
  return customers.reduce((counts, customer) => {
    const key = normalizeCustomerName(customer.name);
    if (key) counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function getDuplicateNameIndexes(customers) {
  const indexes = {};
  return customers.reduce((map, customer) => {
    const key = normalizeCustomerName(customer.name);
    indexes[key] = (indexes[key] || 0) + 1;
    map[customer.id] = indexes[key];
    return map;
  }, {});
}

Page({
  data: {
    id: '',
    customers: [],
    customer: null,
    duplicateCandidates: [],
    quotations: [],
    orders: [],
    receivables: []
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
  },

  onShow() {
    this.load();
  },

  load() {
    const state = getState();
    const activeCustomers = getActiveCustomers(state);
    const duplicateNameCounts = getDuplicateNameCounts(activeCustomers);
    const duplicateNameIndexes = getDuplicateNameIndexes(activeCustomers);
    if (!this.data.id) {
      this.setData({
        customers: activeCustomers.map((customer) => ({
          ...customer,
          display: duplicateNameCounts[normalizeCustomerName(customer.name)] > 1
            ? `${getCustomerDisplay(customer)} · 第${duplicateNameIndexes[customer.id]}个`
            : getCustomerDisplay(customer),
          duplicateSuspect: duplicateNameCounts[normalizeCustomerName(customer.name)] > 1 && !customer.duplicateReviewed
        }))
      });
      return;
    }
    const customer = activeCustomers.find((item) => item.id === this.data.id);
    const duplicateCandidates = customer
      ? activeCustomers
        .filter((item) => item.id !== customer.id && normalizeCustomerName(item.name) === normalizeCustomerName(customer.name))
        .map((item, index) => ({
          ...item,
          display: `${getCustomerDisplay(item)} · 候选${index + 1}`
        }))
      : [];
    this.setData({
      customer,
      duplicateCandidates,
      quotations: decorateRecords(state, state.quotations.filter((item) => item.customerId === this.data.id))
        .map((item) => Object.assign({}, item, { itemsSummary: getItemsSummary(item) })),
      orders: decorateRecords(state, state.orders.filter((item) => item.customerId === this.data.id))
        .map((item) => Object.assign({}, item, { itemsSummary: getItemsSummary(item) })),
      receivables: decorateRecords(state, state.receivables.filter((item) => item.customerId === this.data.id))
    });
  },

  openCustomer(event) {
    wx.navigateTo({ url: `/pages/customer/customer?id=${event.currentTarget.dataset.id}` });
  },

  mergeDuplicate(event) {
    const mergeId = event.currentTarget.dataset.id;
    const state = getState();
    const merged = mergeCustomer(state, this.data.id, mergeId);
    saveState(state);
    wx.showToast({ title: merged ? '已合并客户' : '合并失败', icon: merged ? 'success' : 'none' });
    this.load();
  },

  keepSeparate(event) {
    const candidateId = event.currentTarget.dataset.id;
    const state = getState();
    markDuplicateCustomerReviewed(state, this.data.id);
    markDuplicateCustomerReviewed(state, candidateId);
    saveState(state);
    wx.showToast({ title: '已标记为不同客户', icon: 'success' });
    this.load();
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  }
});
