const { getState, updateState } = require('../../utils/storage');

const SCENE_DURATION = 5250;
const TYPE_INTERVAL = 48;

const SCENES = [
  {
    accent: '#FF7A59',
    speech: '这个客户刚报完价，后天提醒我跟一下。',
    type: '报价跟进',
    time: '后天',
    content: '跟进这次报价',
    speechWidth: 51,
    resultWidth: 47,
    resultLeft: 33
  },
  {
    accent: '#1677FF',
    speech: '这笔尾款，周五提醒我再跟一下。',
    type: '待收款提醒',
    time: '周五',
    content: '跟进这笔尾款',
    speechWidth: 47,
    resultWidth: 44,
    resultLeft: 35
  },
  {
    accent: '#52C7A5',
    speech: '这批货下周三要交，提前一天提醒我。',
    type: '订单交货',
    time: '下周二提醒',
    content: '下周三交货',
    speechWidth: 54,
    resultWidth: 52,
    resultLeft: 29
  },
  {
    accent: '#F2A93B',
    speech: '刚给这个客户报完价，帮我把报价记下来。',
    type: '报价',
    time: '今天',
    content: '保留这次报价',
    speechWidth: 56,
    resultWidth: 46,
    resultLeft: 34
  }
];

const FINAL_SCENE = {
  accent: '#1677FF',
  speechLabel: '店里、厂里、路上',
  speech: '想到什么就说一句。',
  kicker: '小玲帮你整理好',
  type: '等你确认',
  time: '确认后',
  content: '小玲再帮你盯着',
  confirmNote: '每一笔，都由你决定',
  speechWidth: 46,
  resultWidth: 49,
  resultLeft: 31
};

function getStatusBarHeight() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      return wx.getWindowInfo().statusBarHeight || 0;
    }
    return wx.getSystemInfoSync().statusBarHeight || 0;
  } catch (error) {
    return 0;
  }
}

Page({
  data: {
    showPage: false,
    pageTop: 12,
    phase: 'idle',
    speechLabel: '老板说',
    speechText: '',
    isTyping: false,
    sceneAccent: '#FF7A59',
    speechWidth: 51,
    resultWidth: 47,
    resultLeft: 33,
    resultKicker: '小玲整理好了',
    resultType: '报价跟进',
    cardTime: '后天',
    cardContent: '跟进这次报价',
    confirmNote: '等你确认',
    motionComplete: false,
    isStarting: false
  },

  onLoad() {
    const state = getState();
    if (state.meta && state.meta.onboarded) {
      this._navigating = true;
      wx.switchTab({ url: '/pages/dashboard/dashboard' });
      return;
    }

    this._isNewUser = true;
    this._timers = [];
    this._runId = 0;
    this._sceneIndex = 0;
    this.setData({
      showPage: true,
      pageTop: getStatusBarHeight() + 12
    });
  },

  onReady() {
    this._ready = true;
    if (this._isNewUser) {
      this.startMotion();
    }
  },

  onShow() {
    if (this._ready && this._isNewUser && this._paused && !this._navigating) {
      this.startMotion();
    }
  },

  onHide() {
    this._paused = true;
    this.clearMotionTimers();
  },

  onUnload() {
    this._runId += 1;
    this.clearMotionTimers();
  },

  clearMotionTimers() {
    (this._timers || []).forEach((timer) => clearTimeout(timer));
    this._timers = [];
  },

  schedule(callback, delay, activeRun) {
    const timer = setTimeout(() => {
      if (this._runId === activeRun && !this._navigating) {
        callback();
      }
    }, delay);
    this._timers.push(timer);
  },

  setPhase(phase, activeRun) {
    if (this._runId !== activeRun || this._navigating) return;
    this.setData({ phase });
  },

  typeSpeech(text, activeRun) {
    let position = 0;
    const typeNext = () => {
      if (this._runId !== activeRun || this._navigating) return;
      position += 1;
      this.setData({ speechText: text.slice(0, position) });
      if (position < text.length) {
        this.schedule(typeNext, TYPE_INTERVAL, activeRun);
      } else {
        this.setData({ isTyping: false });
        this.setPhase('speech-hold', activeRun);
      }
    };

    this.schedule(typeNext, 180, activeRun);
  },

  applyScene(scene) {
    this.setData({
      phase: 'idle',
      speechLabel: '老板说',
      speechText: '',
      isTyping: true,
      sceneAccent: scene.accent,
      speechWidth: scene.speechWidth,
      resultWidth: scene.resultWidth,
      resultLeft: scene.resultLeft,
      resultKicker: '小玲整理好了',
      resultType: scene.type,
      cardTime: scene.time,
      cardContent: scene.content,
      confirmNote: '等你确认',
      motionComplete: false
    });
  },

  playScene(activeRun) {
    if (this._runId !== activeRun || this._navigating) return;
    const scene = SCENES[this._sceneIndex];
    this.applyScene(scene);

    this.schedule(() => {
      this.setPhase('typing', activeRun);
      this.typeSpeech(scene.speech, activeRun);
    }, 30, activeRun);
    this.schedule(() => this.setPhase('organizing', activeRun), 1800, activeRun);
    this.schedule(() => this.setPhase('card-title', activeRun), 2450, activeRun);
    this.schedule(() => this.setPhase('card-fields', activeRun), 2900, activeRun);
    this.schedule(() => this.setPhase('hold', activeRun), 4050, activeRun);
    this.schedule(() => this.setPhase('exit', activeRun), 4800, activeRun);
    this.schedule(() => {
      this._sceneIndex += 1;
      if (this._sceneIndex < SCENES.length) {
        this.playScene(activeRun);
      } else {
        this.showFinal(activeRun);
      }
    }, SCENE_DURATION, activeRun);
  },

  showFinal(activeRun) {
    if (this._runId !== activeRun || this._navigating) return;
    this.setData({
      phase: 'final',
      speechLabel: FINAL_SCENE.speechLabel,
      speechText: FINAL_SCENE.speech,
      isTyping: false,
      sceneAccent: FINAL_SCENE.accent,
      speechWidth: FINAL_SCENE.speechWidth,
      resultWidth: FINAL_SCENE.resultWidth,
      resultLeft: FINAL_SCENE.resultLeft,
      resultKicker: FINAL_SCENE.kicker,
      resultType: FINAL_SCENE.type,
      cardTime: FINAL_SCENE.time,
      cardContent: FINAL_SCENE.content,
      confirmNote: FINAL_SCENE.confirmNote,
      motionComplete: true
    });
  },

  startMotion() {
    if (!this._isNewUser || this._navigating) return;
    this.clearMotionTimers();
    this._runId += 1;
    this._sceneIndex = 0;
    this._paused = false;
    this.playScene(this._runId);
  },

  replayMotion() {
    this.startMotion();
  },

  start() {
    if (this.data.isStarting || this._navigating) return;
    this.setData({ isStarting: true });
    this._navigating = true;
    this._runId += 1;
    this.clearMotionTimers();

    try {
      updateState((state) => {
        state.meta = state.meta || {};
        state.meta.onboarded = true;
        return state;
      }, { writerSource: 'ONBOARDING_META' });
      wx.switchTab({
        url: '/pages/input/input',
        fail: () => {
          this._navigating = false;
          this.setData({ isStarting: false });
          wx.showToast({ title: '暂时没打开，请再试一次', icon: 'none' });
        }
      });
    } catch (error) {
      this._navigating = false;
      this.setData({ isStarting: false });
      wx.showToast({ title: '暂时没保存，请再试一次', icon: 'none' });
    }
  }
});
