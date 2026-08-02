const {
  QUOTATION_TO_ORDER_ACTIONS,
  assessQuotationToOrder,
  convertQuotationToOrder,
  decorateRecords,
  getItemsSummary,
  getRecordItems
} = require('../../utils/business');
const { addDays, diffDays, today } = require('../../utils/date');
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

function withDisplayItems(state, item) {
  const displayItems = getRecordItems(item).map((lineItem, index) => Object.assign({}, lineItem, {
    itemKey: `${item.id || 'quotation'}-${index}`
  }));
  const conversionAssessment = assessQuotationToOrder(state, item.id);
  const isConverted = conversionAssessment.action === QUOTATION_TO_ORDER_ACTIONS.RETURN_EXISTING;
  const hasConversionConflict = conversionAssessment.action === QUOTATION_TO_ORDER_ACTIONS.DATA_CONFLICT;
  return Object.assign({}, item, {
    displayItems,
    hasMultipleItems: displayItems.length > 1,
    itemsSummary: getItemsSummary(item),
    isConverted,
    statusLabel: hasConversionConflict ? '数据冲突' : (isConverted ? '已转订单' : item.status),
    convertedText: isConverted ? '已转订单' : '转订单',
    conversionAction: conversionAssessment.action,
    conversionMessage: conversionAssessment.message
  });
}

function showConversionIssue(assessment = {}) {
  const title = assessment.action === QUOTATION_TO_ORDER_ACTIONS.DATA_CONFLICT
    ? '数据冲突'
    : '不能转订单';
  if (assessment.action === QUOTATION_TO_ORDER_ACTIONS.DATA_CONFLICT) {
    wx.showModal({
      title,
      content: assessment.message || '报价与订单关系存在数据冲突，请先核对。',
      showCancel: false
    });
    return;
  }
  wx.showToast({
    title: assessment.message || '当前报价不能转订单',
    icon: 'none'
  });
}

function getItemsSearchText(item) {
  return (item.displayItems || getRecordItems(item))
    .map((lineItem) => [
      lineItem.productName,
      lineItem.spec,
      lineItem.quantity,
      lineItem.unit,
      lineItem.unitPrice,
      lineItem.totalAmount
    ].filter(Boolean).join(' '))
    .join(' ');
}

function filterQuotations(quotations, filters) {
  const nextFilters = filters || {};
  return (quotations || []).filter((item) => {
    const customerText = [item.customerDisplay, item.customer && item.customer.name].filter(Boolean).join(' ');
    const productText = [item.itemsSummary, item.productName, item.spec, getItemsSearchText(item)].filter(Boolean).join(' ');
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

function buildConversionDateOptions() {
  const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const startDate = today();
  return Array.from({ length: 120 }, (_, index) => {
    const value = addDays(startDate, index);
    const parts = value.split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return {
      dayLabel: `${parts[1]}月${parts[2]}日`,
      key: value,
      value,
      weekdayLabel: weekdayLabels[date.getDay()]
    };
  });
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
    showFilters: false,
    convertingQuotationId: '',
    conversionDeliveryDate: '',
    conversionDateOptions: []
  },

  onLoad(options = {}) {
    this._conversionEntry = {
      action: String(options.action || ''),
      quotationId: String(options.quotationId || '').trim()
    };
    this._conversionEntryHandled = false;
  },

  onShow() {
    requestOrderFilterReset();
    this.load();
    this.openRequestedConversion();
  },

  openRequestedConversion() {
    if (this._conversionEntryHandled) return null;
    this._conversionEntryHandled = true;
    const entry = this._conversionEntry || {};
    if (entry.action !== 'convert' || !entry.quotationId) return null;
    const assessment = this.startConvert({
      currentTarget: { dataset: { id: entry.quotationId } }
    });
    if (assessment && assessment.action === QUOTATION_TO_ORDER_ACTIONS.CREATE) {
      this.focusActiveConversion();
    }
    return assessment;
  },

  focusActiveConversion() {
    const entry = this._conversionEntry || {};
    if (entry.action !== 'convert'
      || !entry.quotationId
      || this.data.convertingQuotationId !== entry.quotationId) return;
    const target = this.data.allQuotations.find((item) => item.id === entry.quotationId);
    if (target) this.setData({ quotations: [target] });
  },

  load() {
    const state = getState();
    this._loadedState = state;
    const allQuotations = decorateRecords(state, state.quotations).map((item) => ({
      ...withDisplayItems(state, item),
      followupDate: item.deliveryDate || '',
      needFollowup: isQuotationDueForFollowup(item)
    }));
    this.setData({ allQuotations });
    this.applyFilters(allQuotations);
    this.focusActiveConversion();
    return state;
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
    const message = `${customerName}好，上次${quotation.itemsSummary || quotation.productName || '那个产品'}的报价您这边考虑得怎么样？要做的话我这边帮您安排。`;
    wx.setClipboardData({
      data: message,
      success: () => wx.showToast({ title: '跟进话术已复制', icon: 'success' })
    });
  },

  startConvert(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const state = this._loadedState || getState();
    const assessment = assessQuotationToOrder(state, id);
    if (assessment.action !== QUOTATION_TO_ORDER_ACTIONS.CREATE) {
      this.cancelConvert();
      showConversionIssue(assessment);
      return assessment;
    }
    this.setData({
      convertingQuotationId: id,
      conversionDeliveryDate: '',
      conversionDateOptions: buildConversionDateOptions()
    });
    return assessment;
  },

  changeConversionDeliveryDate(event) {
    this.setData({ conversionDeliveryDate: event.detail.value });
  },

  selectConversionDeliveryDate(event) {
    const value = String(
      event.currentTarget.dataset.date
      || event.currentTarget.dataset.id
      || ''
    );
    if (!value) return;
    this.setData({ conversionDeliveryDate: value });
  },

  cancelConvert() {
    this.setData({
      convertingQuotationId: '',
      conversionDeliveryDate: '',
      conversionDateOptions: []
    });
  },

  cancelConversionFlow() {
    const entry = this._conversionEntry || {};
    this.cancelConvert();
    if (entry.action === 'convert' && entry.quotationId) {
      wx.navigateBack({ delta: 1 });
    }
  },

  confirmConvert(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const selectedId = String(this.data.convertingQuotationId || '');
    if (!id || !selectedId || id !== selectedId) {
      wx.showToast({ title: '确认报价与当前选择不一致，请重新操作', icon: 'none' });
      return null;
    }
    if (!this.data.conversionDeliveryDate) {
      wx.showToast({ title: '转订单前请先选交期', icon: 'none' });
      return null;
    }
    const state = getState();
    const assessment = assessQuotationToOrder(state, id);
    if (assessment.action === QUOTATION_TO_ORDER_ACTIONS.RETURN_EXISTING) {
      const existingOrder = convertQuotationToOrder(state, id, {
        requiredDeliveryDate: this.data.conversionDeliveryDate
      });
      wx.showToast({ title: '已存在对应订单', icon: 'none' });
      this.cancelConvert();
      this.load();
      return existingOrder;
    }
    if (assessment.action !== QUOTATION_TO_ORDER_ACTIONS.CREATE) {
      showConversionIssue(assessment);
      this.cancelConvert();
      this.load();
      return null;
    }
    const order = convertQuotationToOrder(state, id, {
      requiredDeliveryDate: this.data.conversionDeliveryDate
    });
    if (!order) {
      wx.showToast({ title: '转换失败，请刷新后重试', icon: 'none' });
      this.load();
      return null;
    }
    saveState(state, { writerSource: 'QUOTATION_CONVERT' });
    const persistedState = this.load();
    const persistedQuotation = (persistedState.quotations || []).find((item) => item.id === id);
    const persistedOrder = (persistedState.orders || []).find((item) => item.id === order.id);
    const relationSaved = Boolean(
      persistedQuotation
      && persistedOrder
      && persistedQuotation.convertedOrderId === persistedOrder.id
      && persistedOrder.quotationId === persistedQuotation.id
      && persistedOrder.customerId === persistedQuotation.customerId
    );
    wx.showToast({
      title: relationSaved ? '已转订单' : '保存后核对失败，请重新打开页面检查',
      icon: relationSaved ? 'success' : 'none'
    });
    if (relationSaved) {
      const entry = this._conversionEntry || {};
      this.cancelConvert();
      if (entry.action === 'convert' && entry.quotationId === id) {
        wx.navigateBack({ delta: 1 });
      }
    }
    return relationSaved ? persistedOrder : null;
  }
});
