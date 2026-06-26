const { convertQuotationToOrder, decorateRecords } = require('../../utils/business');
const { diffDays, today } = require('../../utils/date');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { getState, saveState } = require('../../utils/storage');

function textIncludes(value, keyword) {
  if (!keyword) return true;
  return String(value || '').includes(String(keyword || '').trim());
}

function sameDate(value, date) {
  if (!date) return true;
  return value === date;
}

function hasQuotationFilters(filters) {
  return Boolean(filters.keyword || filters.customer || filters.product || filters.quoteDate || filters.dueDate);
}

function hasAdvancedQuotationFilters(filters) {
  return Boolean(filters.customer || filters.product || filters.quoteDate || filters.dueDate);
}

function filterQuotations(quotations, filters) {
  const nextFilters = filters || {};
  return (quotations || []).filter((item) => {
    const customerText = [item.customerDisplay, item.customer && item.customer.name].filter(Boolean).join(' ');
    const productText = [item.productName, item.spec].filter(Boolean).join(' ');
    const searchableText = `${customerText} ${productText}`;
    return textIncludes(searchableText, nextFilters.keyword)
      && textIncludes(customerText, nextFilters.customer)
      && textIncludes(productText, nextFilters.product)
      && sameDate(item.quoteDate, nextFilters.quoteDate)
      && sameDate(item.deliveryDate, nextFilters.dueDate);
  });
}

function isQuotationDueForFollowup(item) {
  if (!item || item.status !== '待确认') return false;
  if (item.deliveryDate) return diffDays(item.deliveryDate, today()) <= 0;
  return diffDays(today(), item.quoteDate) >= 3;
}

Page({
  data: {
    allQuotations: [],
    quotations: [],
    filterKeyword: '',
    filterCustomer: '',
    filterProduct: '',
    filterQuoteDate: '',
    filterDueDate: '',
    hasActiveFilters: false,
    hasAdvancedFilters: false,
    showFilters: false
  },

  onShow() {
    requestOrderFilterReset();
    this.load();
  },

  load() {
    const state = getState();
    const allQuotations = decorateRecords(state, state.quotations).map((item) => ({
      ...item,
      followupDate: item.deliveryDate || '',
      needFollowup: isQuotationDueForFollowup(item)
    }));
    this.setData({ allQuotations });
    this.applyFilters(allQuotations);
  },

  getFilters() {
    return {
      keyword: this.data.filterKeyword.trim(),
      customer: this.data.filterCustomer.trim(),
      product: this.data.filterProduct.trim(),
      quoteDate: this.data.filterQuoteDate,
      dueDate: this.data.filterDueDate
    };
  },

  applyFilters(source) {
    const filters = this.getFilters();
    const quotations = filterQuotations(source || this.data.allQuotations, filters);
    this.setData({
      quotations,
      hasActiveFilters: hasQuotationFilters(filters),
      hasAdvancedFilters: hasAdvancedQuotationFilters(filters)
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
    this.setData({
      filterKeyword: '',
      filterCustomer: '',
      filterProduct: '',
      filterQuoteDate: '',
      filterDueDate: '',
      showFilters: false
    }, () => this.applyFilters());
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  copyFollowup(event) {
    const id = event.currentTarget.dataset.id;
    const quotation = this.data.quotations.find((item) => item.id === id);
    if (!quotation) return;
    const customerName = quotation.customer ? quotation.customer.name : '老板';
    const message = `${customerName}好，上次${quotation.productName || '那个产品'}的报价您这边考虑得怎么样？要做的话我这边帮您安排。`;
    wx.setClipboardData({
      data: message,
      success: () => wx.showToast({ title: '跟进话术已复制', icon: 'success' })
    });
  },

  convert(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const order = convertQuotationToOrder(state, id);
    saveState(state);
    wx.showToast({
      title: order ? '已转订单' : '转换失败',
      icon: order ? 'success' : 'none'
    });
    this.load();
  }
});
