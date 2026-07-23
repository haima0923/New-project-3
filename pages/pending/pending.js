const { getState, saveState } = require('../../utils/storage');
const { getIntentDraftLabel, getMissingText, getPendingReasonText } = require('../../utils/display');

Page({
  data: {
    notes: []
  },

  onShow() {
    this.load();
  },

  load() {
    const state = getState();
    this.setData({
      notes: state.pendingNotes
        .filter((item) => item.status === '待整理')
        .map((item) => ({
          ...item,
          intentLabel: getIntentDraftLabel(item.guessedIntent),
          reasonText: getPendingReasonText(item),
          missingText: getMissingText((item.missingFields || []).concat(item.lowConfidenceFields || []), item.guessedFields || {})
        }))
    });
  },

  editNote(event) {
    const id = event.currentTarget.dataset.id;
    wx.setStorageSync('pending_to_edit', id);
    wx.switchTab({ url: '/pages/input/input' });
  },

  ignoreNote(event) {
    const id = event.currentTarget.dataset.id;
    const state = getState();
    const note = state.pendingNotes.find((item) => item.id === id);
    if (note) {
      note.status = '已忽略';
      note.updatedAt = new Date().toISOString();
      saveState(state, { writerSource: 'PENDING_IGNORE' });
      wx.showToast({ title: '已忽略', icon: 'success' });
      this.load();
    }
  }
});
