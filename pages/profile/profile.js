const { getState } = require('../../utils/storage');
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
    voiceStatusClass: 'status-pill status-muted'
  },

  onShow() {
    refreshTabBarSelected(this);
    const state = getState();
    const app = typeof getApp === 'function' ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      stats: {
        customers: countActive(state.customers, (item) => !item.mergedInto),
        orders: countActive(state.orders, (item) => !['已完成', '已取消'].includes(item.status)),
        receivables: countActive(state.receivables, (item) => !['已结清', '坏账'].includes(item.status)),
        todos: countActive(state.todos, (item) => item.status !== '已完成')
      },
      parseStatus: globalData.aiParseEndpoint ? (globalData.aiAuthEnabled ? '需微信登录' : '已配置') : '本地规则',
      voiceStatus: isVoiceRecognitionAvailable() ? '微信语音已接入' : '未配置',
      voiceStatusClass: isVoiceRecognitionAvailable() ? 'status-pill' : 'status-pill status-muted'
    });
  }
});
