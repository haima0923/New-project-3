const { getState } = require('../utils/storage');
const { today } = require('../utils/date');

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
  { key: 'finance', pagePath: '/pages/finance/finance', route: 'pages/finance/finance', text: '财务', icon: '¥' },
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

Component({
  data: {
    selected: 0,
    list: buildList()
  },

  lifetimes: {
    attached() {
      this.updateSelected();
    }
  },

  pageLifetimes: {
    show() {
      this.updateSelected();
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
      this.centerPressing = true;
      const current = this.getCurrentPage();
      if (current && current.route === 'pages/dashboard/dashboard' && typeof current.startVoice === 'function') {
        current.startVoice(event);
        return;
      }
      wx.switchTab({
        url: '/pages/dashboard/dashboard',
        success: () => {
          setTimeout(() => {
            if (!this.centerPressing) return;
            const page = this.getCurrentPage();
            if (page && typeof page.startVoice === 'function') page.startVoice();
          }, 120);
        }
      });
    },

    moveCenterVoice(event) {
      const current = this.getCurrentPage();
      if (current && typeof current.moveVoice === 'function') {
        current.moveVoice(event);
      }
    },

    stopCenterVoice() {
      this.centerPressing = false;
      const current = this.getCurrentPage();
      if (current && typeof current.stopVoice === 'function') {
        current.stopVoice();
      }
    },

    cancelCenterVoice() {
      this.centerPressing = false;
      const current = this.getCurrentPage();
      if (current && typeof current.cancelVoice === 'function') {
        current.cancelVoice();
      }
    },

    noop() {
      return false;
    }
  }
});
