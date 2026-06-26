const { INDUSTRIES } = require('../../utils/constants');
const { getState, updateState } = require('../../utils/storage');

Page({
  data: {
    industries: INDUSTRIES,
    selectedIndustry: ''
  },

  onLoad() {
    const state = getState();
    if (state.meta.onboarded) {
      wx.switchTab({ url: '/pages/dashboard/dashboard' });
    }
  },

  chooseIndustry(event) {
    this.setData({
      selectedIndustry: this.data.industries[Number(event.detail.value)]
    });
  },

  start() {
    updateState((state) => {
      state.meta.onboarded = true;
      state.meta.industry = this.data.selectedIndustry;
      return state;
    });
    wx.switchTab({ url: '/pages/dashboard/dashboard' });
  },

  skip() {
    updateState((state) => {
      state.meta.onboarded = true;
      state.meta.industry = '';
      return state;
    });
    wx.switchTab({ url: '/pages/dashboard/dashboard' });
  }
});
