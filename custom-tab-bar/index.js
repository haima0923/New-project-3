const { getState } = require('../utils/storage');
const { today } = require('../utils/date');
const {
  beginHold,
  cancelHold,
  endHold,
  invalidateHoldToTalk,
  moveHold,
  registerHoldToTalkOwner,
  releaseHoldToTalkOwner
} = require('../utils/hold-to-talk-controller');

const routeMap = {
  'pages/dashboard/dashboard': 0,
  'pages/records/records': 1,
  'pages/input/input': 2,
  'pages/finance/finance': 3,
  'pages/profile/profile': 4
};

function normalizeRoute(route) {
  return String(route || '').replace(/^\//, '');
}

const baseList = [
  { key: 'home', pagePath: '/pages/dashboard/dashboard', route: 'pages/dashboard/dashboard', text: '首页', icon: '⌂' },
  { key: 'records', pagePath: '/pages/records/records', route: 'pages/records/records', text: '记录', icon: '▤' },
  { key: 'input', pagePath: '/pages/input/input', route: 'pages/input/input', text: '话筒', icon: '', center: true },
  { key: 'finance', pagePath: '/pages/finance/finance', route: 'pages/finance/finance', text: '收款', icon: '¥' },
  { key: 'profile', pagePath: '/pages/profile/profile', route: 'pages/profile/profile', text: '我的', icon: '人' }
];

function getFinanceBadge() {
  try {
    const state = getState();
    const todayText = today();
    const count = (state.receivables || []).filter((item) => (
      !['已结清', '坏账'].includes(item.status)
        && item.dueDate
        && item.dueDate <= todayText
    )).length;
    if (!count) return '';
    return count > 99 ? '99+' : String(count);
  } catch (error) {
    return '';
  }
}

function buildList() {
  const financeBadge = getFinanceBadge();
  return baseList.map((item) => Object.assign({}, item, {
    badge: item.key === 'finance' ? financeBadge : ''
  }));
}

function projectCenterVoiceState(component, state = {}) {
  component.setData({
    centerVoicePhase: String(state.phase || 'IDLE'),
    centerVoiceGesture: state.gesture === 'cancel' ? 'cancel' : 'send',
    centerVoiceOverlayMode: String(state.overlayMode || 'listening'),
    centerVoiceOverlaySubtitle: String(state.overlaySubtitle || ''),
    centerVoiceOverlayTitle: String(state.overlayTitle || ''),
    centerVoiceOverlayVisible: state.overlayVisible === true,
    centerVoiceRecording: state.recording === true
  });
}

function ensureCenterVoiceOwner(component) {
  if (component.centerVoiceOwnerToken) return component.centerVoiceOwnerToken;
  component.centerVoiceOwnerToken = registerHoldToTalkOwner({
    surface: 'CUSTOM_TAB_CENTER',
    project: (state) => projectCenterVoiceState(component, state),
    message: (message) => component.setData({ centerVoiceMessage: String(message || '') }),
    audioReady: () => component.setData({ centerVoiceMessage: '录音已完成' }),
    transcript: () => component.setData({ centerVoiceMessage: '正在打开记一笔' })
  });
  return component.centerVoiceOwnerToken;
}

Component({
  data: {
    selected: 0,
    list: buildList(),
    centerVoicePhase: 'IDLE',
    centerVoiceGesture: 'send',
    centerVoiceMessage: '',
    centerVoiceOverlayMode: 'listening',
    centerVoiceOverlaySubtitle: '',
    centerVoiceOverlayTitle: '',
    centerVoiceOverlayVisible: false,
    centerVoiceRecording: false
  },

  lifetimes: {
    attached() {
      ensureCenterVoiceOwner(this);
      this.updateSelected();
    },
    detached() {
      if (!this.centerVoiceOwnerToken) return;
      releaseHoldToTalkOwner(this.centerVoiceOwnerToken, 'CUSTOM_TAB_DETACHED');
      this.centerVoiceOwnerToken = null;
    }
  },

  pageLifetimes: {
    show() {
      this.updateSelected();
    },
    hide() {
      if (!this.centerVoiceOwnerToken) return;
      invalidateHoldToTalk(this.centerVoiceOwnerToken, 'CUSTOM_TAB_PAGE_HIDDEN');
    }
  },

  methods: {
    getCurrentPage() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      return pages[pages.length - 1] || null;
    },

    updateSelected() {
      const current = this.getCurrentPage();
      const route = normalizeRoute(current && current.route);
      const selected = routeMap[route] !== undefined ? routeMap[route] : 0;
      this.setData({
        selected,
        list: buildList()
      });
    },

    switchTab(event) {
      const path = event.currentTarget.dataset.path;
      const index = Number(event.currentTarget.dataset.index);
      if (!path) return;
      if (Number.isFinite(index)) {
        this.setData({
          selected: index,
          list: buildList()
        });
      }
      wx.switchTab({
        url: path,
        success: () => this.updateSelected()
      });
    },

    startCenterVoice(event) {
      return beginHold(ensureCenterVoiceOwner(this), event);
    },

    moveCenterVoice(event) {
      return moveHold(ensureCenterVoiceOwner(this), event);
    },

    stopCenterVoice(event) {
      return endHold(ensureCenterVoiceOwner(this), event);
    },

    cancelCenterVoice(event) {
      return cancelHold(ensureCenterVoiceOwner(this), event, 'CUSTOM_TAB_TOUCH_CANCELLED');
    },

    noop() {
      return false;
    }
  }
});
