const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function includes(source, expected, message) {
  assert(source.includes(expected), message || `缺少：${expected}`);
}

const dashboardJs = read('pages/dashboard/dashboard.js');
const dashboardCss = read('pages/dashboard/dashboard.wxss');
const inputJs = read('pages/input/input.js');
const inputWxml = read('pages/input/input.wxml');
const inputCss = read('pages/input/input.wxss');

includes(dashboardJs, 'function startParseProgress', '首页必须有真实等待阶段管理');
includes(dashboardJs, 'setTimeout(show, 180)', '首页应避免本地快速识别时闪出等待遮罩');
includes(dashboardJs, '正在核对前后说法', '首页等待时应说明聊天复核阶段');
includes(dashboardJs, '确认前不会自动保存', '首页等待时必须明确不会自动保存');
includes(dashboardJs, 'composerText: text', '首页语音识别文字应保留，网络失败后可重试');
includes(dashboardJs, 'finishParseProgress(this)', '首页完成或失败时必须关闭等待状态');
includes(dashboardCss, 'animation: voiceProgressSweep', '首页等待遮罩应有轻量动效');

includes(inputJs, 'function startParseProgress', '完整记一笔页必须有真实等待阶段管理');
includes(inputJs, 'showParseProgress: true', '完整记一笔页应在慢请求时展示等待状态');
includes(inputJs, 'finishParseProgress(this)', '完整记一笔完成或失败时必须关闭等待状态');
includes(inputWxml, 'wx:if="{{showParseProgress}}"', '完整记一笔页必须渲染等待提示');
includes(inputWxml, '{{parseProgressTitle}}', '完整记一笔页必须展示当前等待阶段');
includes(inputCss, '@keyframes parseProgressOrbit', '完整记一笔页等待提示应有轻量动效');

console.log('AI 等待体验测试通过：慢请求提示、失败可重试和动效结构均已覆盖。');
