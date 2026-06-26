const { decorateRecords, generateReceivableFromOrder, updateOrderStatus } = require('../../utils/business');
const { ORDER_STATUS } = require('../../utils/constants');
const { diffDays, today } = require('../../utils/date');
const {
  clearNextOrderFilter,
  consumeNextOrderFilter,
  consumeOrderFilterReset,
  peekNextOrderFilter
} = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

function textIncludes(value, keyword) {
  if (!keyword) return true;
  return String(value || '').includes(String(keyword || '').trim());
}

function sameDate(value, date) {
  if (!date) return true;
  return value === date;
}

function isDeliverySoonOrder(item) {
  if (!item || !item.requiredDeliveryDate || ['已完成', '已取消'].includes(item.status)) return false;
  return diffDays(item.requiredDeliveryDate, today()) <= 3;
}

function hasOrderFilters(filters) {
  return Boolean(filters.preset || filters.keyword || filters.customer || filters.product || filters.orderDate || filters.dueDate);
}

function hasAdvancedOrderFilters(filters) {
  return Boolean(filters.preset || filters.customer || filters.product || filters.orderDate || filters.dueDate);
}

function filterOrders(orders, filters) {
  const nextFilters = filters || {};
  return (orders || []).filter((item) => {
    if (nextFilters.preset === 'deliverySoon' && !isDeliverySoonOrder(item)) return false;
    const customerText = [item.customerDisplay, item.customer && item.customer.name].filter(Boolean).join(' ');
    const productText = [item.productName, item.spec].filter(Boolean).join(' ');
    const searchableText = `${customerText} ${productText}`;
    return textIncludes(searchableText, nextFilters.keyword)
      && textIncludes(customerText, nextFilters.customer)
      && textIncludes(productText, nextFilters.product)
      && sameDate(item.orderDate, nextFilters.orderDate)
      && sameDate(item.requiredDeliveryDate, nextFilters.dueDate);
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
    filterOrderDate: '',
    filterDueDate: '',
    filterPreset: '',
    presetFilterLabel: '',
    hasActiveFilters: false,
    hasAdvancedFilters: false,
    showFilters: false
  },

  onShow() {
    const routeFilter = this.consumeRouteFilter();
    if (routeFilter && routeFilter.preset) {
      this.shouldResetFiltersOnNextShow = false;
      this.setData({
        filterKeyword: '',
        filterCustomer: '',
        filterProduct: '',
        filterOrderDate: '',
        filterDueDate: '',
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
    const allOrders = decorateRecords(state, state.orders).map((item) => ({
      ...item,
      statusIndex: ORDER_STATUS.indexOf(item.status),
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
      orderDate: this.data.filterOrderDate,
      dueDate: this.data.filterDueDate
    };
  },

  applyFilters(source) {
    const filters = this.getFilters();
    const orders = filterOrders(source || this.data.allOrders, filters);
    this.setData({
      orders,
      hasActiveFilters: hasOrderFilters(filters),
      hasAdvancedFilters: hasAdvancedOrderFilters(filters)
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
      filterOrderDate: '',
      filterDueDate: '',
      filterPreset: '',
      presetFilterLabel: '',
      showFilters: false
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

  changeStatus(event) {
    const id = event.currentTarget.dataset.id;
    const status = ORDER_STATUS[Number(event.detail.value)];
    const state = getState();
    updateOrderStatus(state, id, status);
    saveState(state);
    wx.showToast({ title: '进度已更新', icon: 'success' });
    this.load();
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
