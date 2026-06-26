const { askHybridQuery } = require('../../utils/ai-query');
const { getState } = require('../../utils/storage');

Page({
  data: {
    question: '',
    answer: null,
    asking: false,
    askButtonText: '查一下',
    assistText: ''
  },

  onQuestionInput(event) {
    this.setData({ question: event.detail.value });
  },

  ask() {
    const state = getState();
    this.setData({
      asking: true,
      askButtonText: '正在查询',
      assistText: '正在理解你的问题。'
    });
    askHybridQuery(this.data.question, state)
      .then((answer) => {
        const statusText = {
          used: '已通过后端 AI 查询。',
          mock_used: '已通过测试后端 mock 查询。',
          failed: '后端暂不可用，已使用本地查询兜底。',
          skipped_no_endpoint: '还未配置后端地址，已使用本地查询兜底。'
        }[answer.aiStatus || 'used'];
        this.setData({
          answer,
          asking: false,
          askButtonText: '查一下',
          assistText: statusText
        });
      })
      .catch(() => {
        this.setData({
          asking: false,
          askButtonText: '查一下',
          assistText: '查询失败，请稍后再试。'
        });
      });
  },

  fillExample(event) {
    this.setData({
      question: event.currentTarget.dataset.text
    });
  }
});
