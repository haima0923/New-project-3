const {
  decorateRecords,
  generateReceivableFromOrder,
  getItemsSummary,
  getRecordItems,
  setOrderDeliveryDate,
  updateOrderStatus
} = require('../../utils/business');
const { ORDER_STATUS } = require('../../utils/constants');
const { diffDays, today } = require('../../utils/date');
const {
  ORDER_SORT_OPTIONS,
  buildCustomerOrderStats,
  enrichOrdersWithPayments,
  filterOrders,
  hasAdvancedOrderFilters,
  hasOrderFilters,
  sortOrders
} = require('../../utils/order-insights');
const {
  clearNextOrderFilter,
  consumeNextOrderFilter,
  consumeOrderFilterReset,
  peekNextOrderFilter
} = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

function normalizeOriginalText(value) {
  return String(value || '').trim();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function formatMoney(value) {
  if (!hasValue(value)) return '未填写';
  const number = Number(value);
  if (!Number.isFinite(number)) return `¥${value}`;
  return `¥${Number(number.toFixed(2))}`;
}

function buildOrderQuantitySummary(items) {
  const lines = (items || []).filter((item) => hasValue(item.quantity) || hasValue(item.unit));
  if (!lines.length) return '未填写';
  if (lines.length === 1) return `${hasValue(lines[0].quantity) ? lines[0].quantity : '-'}${lines[0].unit || ''}`;

  const units = Array.from(new Set(lines.map((item) => item.unit || '')));
  const quantities = lines.map((item) => Number(item.quantity));
  if (units.length === 1 && units[0] && lines.every((item) => hasValue(item.quantity)) && quantities.every(Number.isFinite)) {
    const total = quantities.reduce((sum, value) => sum + value, 0);
    return `${Number(total.toFixed(2))}${units[0]}（${lines.length}项）`;
  }
  return lines
    .slice(0, 2)
    .map((item) => `${hasValue(item.quantity) ? item.quantity : '-'}${item.unit || '（单位未填）'}`)
    .join('、') + (lines.length > 2 ? `等${lines.length}项` : '');
}

function withDisplayItems(item, expandedOriginalTextMap = {}) {
  const displayItems = getRecordItems(item).map((lineItem, index) => Object.assign({}, lineItem, {
    itemKey: `${item.id || 'order'}-${index}`
  }));
  const originalTextForDisplay = normalizeOriginalText(item.originalText || item.original_text);
  return Object.assign({}, item, {
    displayItems,
    hasMultipleItems: displayItems.length > 1,
    itemsSummary: getItemsSummary(item),
    quantitySummary: buildOrderQuantitySummary(displayItems),
    totalAmountDisplay: formatMoney(item.totalAmount),
    originalTextForDisplay,
    hasOriginalText: Boolean(originalTextForDisplay),
    showOriginalText: Boolean(originalTextForDisplay && expandedOriginalTextMap[item.id])
  });
}

Page({
  data: {
    allOrders: [],
    orders: [],
    orderStatuses: ORDER_STATUS,
    filterKeyword: '',
    filterCustomer: '',
    filterProduct: '',
    filterStatus: '',
    filterMinAmount: '',
    filterMaxAmount: '',
    filterOrderDate: '',
    filterDueDate: '',
    filterShipDate: '',
    filterPaymentDate: '',
    filterPreset: '',
    presetFilterLabel: '',
    hasActiveFilters: false,
    hasAdvancedFilters: false,
    showFilters: false,
    expandedOriginalTextMap: {},
    orderStatusFilterRange: ['全部状态'].concat(ORDER_STATUS),
    selectedStatusIndex: 0,
    orderSortOptions: ORDER_SORT_OPTIONS,
    orderSortRange: ORDER_SORT_OPTIONS.map((item) => item.label),
    selectedSortIndex: 0,
    sortKey: ORDER_SORT_OPTIONS[0].key,
    showCustomerStats: false,
    customerStats: []
  },

  onShow() {
    const routeFilter = this.consumeRouteFilter();
    if (routeFilter && routeFilter.preset) {
      this.shouldResetFiltersOnNextShow = false;
      this.setData({
        filterKeyword: '',
        filterCustomer: '',
        filterProduct: '',
        filterStatus: '',
        filterMinAmount: '',
        filterMaxAmount: '',
        filterOrderDate: '',
        filterDueDate: '',
        filterShipDate: '',
        filterPaymentDate: '',
        filterPreset: routeFilter.preset,
        presetFilterLabel: routeFilter.label || '',
        showFilters: false
      }, () => this.load());
      return;
    }
    if (this.enteredByTabItem) {
      this.enteredByTabItem = false;
      if (this.data.hasActiveFilters) {
        this.clearPendingRouteFilter();
        this.setData(this.getEmptyFilterData(), () => this.load());
        return;
      }
    }
    const shouldResetFromOtherPage = consumeOrderFilterReset();
    if (shouldResetFromOtherPage && this.data.hasActiveFilters) {
      this.shouldResetFiltersOnNextShow = false;
      this.setData(this.getEmptyFilterData(), () => this.load());
      return;
    }
    if (this.shouldResetFiltersOnNextShow && this.data.hasActiveFilters) {
      this.shouldResetFiltersOnNextShow = false;
      this.setData(this.getEmptyFilterData(), () => this.load());
      return;
    }
    this.shouldResetFiltersOnNextShow = false;
    this.load();
  },

  onHide() {
    this.shouldResetFiltersOnNextShow = this.data.hasActiveFilters;
  },

  onTabItemTap() {
    this.enteredByTabItem = true;
    if (this.peekRouteFilter()) return;
    this.clearPendingRouteFilter();
    if (this.data.hasActiveFilters) {
      this.setData(this.getEmptyFilterData(), () => this.load());
    }
  },

  load() {
    const state = getState();
    const expandedOriginalTextMap = this.data.expandedOriginalTextMap || {};
    const decoratedOrders = decorateRecords(state, state.orders).map((item) => withDisplayItems(item, expandedOriginalTextMap));
    const allOrders = enrichOrdersWithPayments(state, decoratedOrders).map((item) => ({
      ...item,
      statusIndex: ORDER_STATUS.indexOf(item.status),
      canGenerateReceivable: item.status !== '已取消',
      urgent: item.requiredDeliveryDate && diffDays(item.requiredDeliveryDate, today()) <= 3 && !['已完成', '已取消'].includes(item.status)
    }));
    this.setData({ allOrders });
    this.applyFilters(allOrders);
  },

  getFilters() {
    return {
      preset: this.data.filterPreset,
      keyword: this.data.filterKeyword.trim(),
      customer: this.data.filterCustomer.trim(),
      product: this.data.filterProduct.trim(),
      status: this.data.filterStatus,
      minAmount: this.data.filterMinAmount,
      maxAmount: this.data.filterMaxAmount,
      orderDate: this.data.filterOrderDate,
      dueDate: this.data.filterDueDate,
      shipDate: this.data.filterShipDate,
      paymentDate: this.data.filterPaymentDate
    };
  },

  applyFilters(source) {
    const filters = this.getFilters();
    const filteredOrders = filterOrders(source || this.data.allOrders, filters);
    const orders = sortOrders(filteredOrders, this.data.sortKey);
    this.setData({
      orders,
      hasActiveFilters: hasOrderFilters(filters),
      hasAdvancedFilters: hasAdvancedOrderFilters(filters),
      customerStats: buildCustomerOrderStats(orders)
    });
  },

  changeTextFilter(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value }, () => this.applyFilters());
  },

  changeDateFilter(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value }, () => this.applyFilters());
  },

  changeStatusFilter(event) {
    const selectedStatusIndex = Number(event.detail.value || 0);
    this.setData({
      selectedStatusIndex,
      filterStatus: selectedStatusIndex > 0 ? ORDER_STATUS[selectedStatusIndex - 1] : ''
    }, () => this.applyFilters());
  },

  changeSort(event) {
    const selectedSortIndex = Number(event.detail.value || 0);
    const option = ORDER_SORT_OPTIONS[selectedSortIndex] || ORDER_SORT_OPTIONS[0];
    this.setData({
      selectedSortIndex,
      sortKey: option.key
    }, () => this.applyFilters());
  },

  toggleCustomerStats() {
    this.setData({ showCustomerStats: !this.data.showCustomerStats });
  },

  filterByCustomerStat(event) {
    const customerName = event.currentTarget.dataset.name || '';
    this.setData({
      filterCustomer: customerName,
      showCustomerStats: false,
      showFilters: false
    }, () => this.applyFilters());
  },

  toggleFilters() {
    this.setData({ showFilters: !this.data.showFilters });
  },

  resetFilters() {
    this.setData(this.getEmptyFilterData(), () => this.applyFilters());
  },

  getEmptyFilterData() {
    return {
      filterKeyword: '',
      filterCustomer: '',
      filterProduct: '',
      filterStatus: '',
      filterMinAmount: '',
      filterMaxAmount: '',
      filterOrderDate: '',
      filterDueDate: '',
      filterShipDate: '',
      filterPaymentDate: '',
      filterPreset: '',
      presetFilterLabel: '',
      showFilters: false,
      selectedStatusIndex: 0
    };
  },

  consumeRouteFilter() {
    return consumeNextOrderFilter();
  },

  peekRouteFilter() {
    return peekNextOrderFilter();
  },

  clearPendingRouteFilter() {
    clearNextOrderFilter();
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  editOrder(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.setStorageSync('record_to_edit', { type: 'order', id });
    wx.switchTab({ url: '/pages/input/input' });
  },

  changeStatus(event) {
    const id = event.currentTarget.dataset.id;
    const status = ORDER_STATUS[Number(event.detail.value)];
    const state = getState();
    const updated = updateOrderStatus(state, id, status);
    if (!updated) {
      wx.showToast({
        title: status === '已取消' ? '已有收款或待收，不能直接取消' : '进度没有更新，请重试',
        icon: 'none'
      });
      return;
    }
    saveState(state);
    wx.showToast({ title: '进度已更新', icon: 'success' });
    this.load();
  },

  changeDeliveryDate(event) {
    const id = event.currentTarget.dataset.id;
    const date = event.detail.value;
    const state = getState();
    const order = setOrderDeliveryDate(state, id, date);
    if (!order) {
      wx.showToast({ title: '交期没有保存，请重试', icon: 'none' });
      return;
    }
    saveState(state);
    wx.showToast({ title: '交期已更新', icon: 'success' });
    this.load();
  },

  toggleOriginalText(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const expandedOriginalTextMap = Object.assign({}, this.data.expandedOriginalTextMap || {});
    expandedOriginalTextMap[id] = !expandedOriginalTextMap[id];
    this.setData({ expandedOriginalTextMap }, () => this.load());
  },

  createReceivable(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const receivable = generateReceivableFromOrder(state, id);
    saveState(state);
    wx.showToast({
      title: receivable ? '已生成应收款' : '生成失败',
      icon: receivable ? 'success' : 'none'
    });
  }
});
