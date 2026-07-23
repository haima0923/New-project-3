const {
  ensureProductCatalog,
  removeCatalogItem,
  saveManualCatalogItem
} = require('../../utils/product-catalog');
const { getState, saveState } = require('../../utils/storage');
const { isVoiceRecognitionAvailable } = require('../../utils/voice-recognition');

function countActive(list, predicate) {
  return (list || []).filter(predicate || (() => true)).length;
}

function refreshTabBarSelected(page) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.updateSelected === 'function') {
    tabBar.updateSelected();
  }
}

function formatCatalogItems(items) {
  return (items || []).map((item) => ({
    ...item,
    specText: (item.specs || []).map((spec) => typeof spec === 'string' ? spec : spec.name).filter(Boolean).join('、'),
    unitText: (item.units || []).join('、'),
    priceUnitText: (item.priceUnits || []).join('、')
  }));
}

function splitCatalogText(value) {
  return String(value || '').split(/[，,、；;\n]+/).map((item) => item.trim()).filter(Boolean);
}

Page({
  data: {
    stats: {
      customers: 0,
      orders: 0,
      receivables: 0,
      todos: 0
    },
    parseStatus: '已配置',
    voiceStatus: '未配置',
    voiceStatusClass: 'status-pill status-muted',
    catalogProducts: [],
    showCatalogEditor: false,
    catalogEditId: '',
    catalogName: '',
    catalogSpecsText: '',
    catalogUnitsText: '',
    catalogPriceUnitsText: ''
  },

  onShow() {
    refreshTabBarSelected(this);
    const state = getState();
    const needsCatalogMigration = !Array.isArray(state.productCatalog);
    const productCatalog = ensureProductCatalog(state);
    if (needsCatalogMigration) saveState(state, { writerSource: 'CATALOG_AUTO_MIGRATION' });
    const app = typeof getApp === 'function' ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      stats: {
        customers: countActive(state.customers, (item) => !item.mergedInto),
        orders: countActive(state.orders, (item) => !['已完成', '已取消'].includes(item.status)),
        receivables: countActive(state.receivables, (item) => !['已结清', '坏账'].includes(item.status)),
        todos: countActive(state.todos, (item) => item.status !== '已完成')
      },
      parseStatus: globalData.aiParseEndpoint ? '已开启' : '本地整理',
      voiceStatus: isVoiceRecognitionAvailable() ? '可使用' : '准备中',
      voiceStatusClass: isVoiceRecognitionAvailable() ? 'status-pill' : 'status-pill status-muted',
      catalogProducts: formatCatalogItems(productCatalog)
    });
  },

  startAddCatalog() {
    this.setData({
      showCatalogEditor: true,
      catalogEditId: '',
      catalogName: '',
      catalogSpecsText: '',
      catalogUnitsText: '',
      catalogPriceUnitsText: ''
    });
  },

  editCatalog(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.catalogProducts.find((entry) => entry.id === id);
    if (!item) return;
    this.setData({
      showCatalogEditor: true,
      catalogEditId: item.id,
      catalogName: item.productName,
      catalogSpecsText: item.specText,
      catalogUnitsText: item.unitText,
      catalogPriceUnitsText: item.priceUnitText
    });
  },

  updateCatalogField(event) {
    const field = event.currentTarget.dataset.field;
    if (field) this.setData({ [field]: event.detail.value });
  },

  cancelCatalogEdit() {
    this.setData({ showCatalogEditor: false, catalogEditId: '' });
  },

  saveCatalog() {
    const productName = String(this.data.catalogName || '').trim();
    if (!productName) {
      wx.showToast({ title: '请先填写商品名称', icon: 'none' });
      return;
    }
    const state = getState();
    const saved = saveManualCatalogItem(state, {
      id: this.data.catalogEditId,
      productName,
      specs: splitCatalogText(this.data.catalogSpecsText),
      units: splitCatalogText(this.data.catalogUnitsText),
      priceUnits: splitCatalogText(this.data.catalogPriceUnitsText),
      sourceType: 'manual'
    });
    if (!saved) {
      wx.showToast({ title: '商品没有保存，请重试', icon: 'none' });
      return;
    }
    saveState(state, { writerSource: 'CATALOG_MANUAL_SAVE' });
    wx.showToast({ title: '商品规格库已更新', icon: 'success' });
    this.setData({ showCatalogEditor: false, catalogEditId: '' });
    this.onShow();
  },

  deleteCatalog(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '从商品规格库移除？',
      content: '只会移除核对用的商品资料，不会删除以前的订单和报价。',
      confirmText: '移除',
      confirmColor: '#D92D20',
      success: (result) => {
        if (!result.confirm) return;
        const state = getState();
        const removed = removeCatalogItem(state, id);
        if (!removed) {
          wx.showToast({ title: '没有找到这个商品', icon: 'none' });
          return;
        }
        saveState(state, { writerSource: 'CATALOG_MANUAL_DELETE' });
        wx.showToast({ title: '已从商品库移除', icon: 'success' });
        this.onShow();
      }
    });
  }
});
