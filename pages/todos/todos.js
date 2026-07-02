const { completeTodo, decorateRecords } = require('../../utils/business');
const { diffDays, today } = require('../../utils/date');
const { getState, saveState } = require('../../utils/storage');

function getTodoBucket(todo, current) {
  if (!todo.remindDate) return 'later';
  const days = diffDays(todo.remindDate, current);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return 'later';
}

function formatTodoMeta(todo, bucket) {
  const dateText = todo.remindDate || '未设置日期';
  const customer = todo.customerDisplay && todo.customerDisplay !== '未关联客户' ? ` · ${todo.customerDisplay}` : '';
  const bucketText = {
    overdue: '已逾期',
    today: '今天',
    tomorrow: '明天',
    later: '以后'
  }[bucket] || '待办';
  return `${bucketText} · ${dateText}${customer}`;
}

function groupTodos(state) {
  const current = today();
  const decorated = decorateRecords(state, (state.todos || [])
    .filter((item) => item.status !== '已完成'))
    .map((item) => {
      const bucket = getTodoBucket(item, current);
      return Object.assign({}, item, {
        bucket,
        metaText: formatTodoMeta(item, bucket)
      });
    })
    .sort((left, right) => String(left.remindDate || '9999-12-31').localeCompare(String(right.remindDate || '9999-12-31')));

  return {
    overdueTodos: decorated.filter((item) => item.bucket === 'overdue'),
    todayTodos: decorated.filter((item) => item.bucket === 'today'),
    tomorrowTodos: decorated.filter((item) => item.bucket === 'tomorrow'),
    laterTodos: decorated.filter((item) => item.bucket === 'later')
  };
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
    total: 0,
    overdueTodos: [],
    todayTodos: [],
    tomorrowTodos: [],
    laterTodos: []
  },

  onShow() {
    refreshTabBarSelected(this);
    this.load();
  },

  load() {
    const state = getState();
    const groups = groupTodos(state);
    const total = groups.overdueTodos.length + groups.todayTodos.length + groups.tomorrowTodos.length + groups.laterTodos.length;
    this.setData(Object.assign({ total }, groups));
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  completeTodo(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const todo = completeTodo(state, id);
    if (!todo) {
      wx.showToast({ title: '待办不存在', icon: 'none' });
      return;
    }
    saveState(state);
    wx.showToast({ title: '已完成', icon: 'success' });
    this.load();
  }
});
