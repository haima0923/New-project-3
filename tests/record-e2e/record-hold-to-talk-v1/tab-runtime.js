const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { safeClone } = require('../../../utils/record-state-diff');
const { ROOT } = require('../runner/constants');

const TAB_JS = path.join(ROOT, 'custom-tab-bar/index.js');
const TAB_WXML = path.join(ROOT, 'custom-tab-bar/index.wxml');
const DASHBOARD_WXML = path.join(ROOT, 'pages/dashboard/dashboard.wxml');

function attributesOfTag(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = source.lastIndexOf('<', markerIndex);
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== '\\') {
      quote = quote === character ? '' : (quote || character);
    }
    if (character === '>' && !quote) return source.slice(start, index + 1);
  }
  return '';
}

function binding(tag, attribute) {
  const match = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`));
  return match ? match[1] : '';
}

function extractVoiceBindings() {
  const dashboardSource = fs.readFileSync(DASHBOARD_WXML, 'utf8');
  const tabSource = fs.readFileSync(TAB_WXML, 'utf8');
  const heroTag = attributesOfTag(dashboardSource, 'class="hero-wave ');
  const centerTag = attributesOfTag(tabSource, 'class="tab-item tab-item-center');
  return {
    dashboard: {
      cancel: binding(heroTag, 'bindtouchcancel'),
      end: binding(heroTag, 'bindtouchend'),
      move: binding(heroTag, 'bindtouchmove'),
      start: binding(heroTag, 'bindtouchstart'),
      tap: binding(heroTag, 'bindtap')
    },
    dashboardTipProjected: /wx:if="\{\{voiceTip\}\}"[^>]*>\{\{voiceTip\}\}/.test(dashboardSource),
    tab: {
      cancel: binding(centerTag, 'bindtouchcancel'),
      end: binding(centerTag, 'bindtouchend'),
      move: binding(centerTag, 'bindtouchmove'),
      start: binding(centerTag, 'bindtouchstart'),
      tap: binding(centerTag, 'bindtap')
    }
  };
}

function applyDataPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => { target[key] = patch[key]; });
}

function loadCustomTabComponent(fakeWx) {
  const code = fs.readFileSync(TAB_JS, 'utf8');
  const componentRequire = createRequire(TAB_JS);
  let definition = null;
  const sandbox = {
    Array,
    Boolean,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    clearInterval,
    clearTimeout,
    console,
    Component(value) { definition = value; },
    getCurrentPages: global.getCurrentPages,
    require: componentRequire,
    setInterval,
    setTimeout,
    wx: fakeWx.wx
  };
  vm.runInNewContext(code, sandbox, { filename: TAB_JS });
  if (!definition) {
    const error = new Error('Custom tab Component definition was not captured');
    error.code = 'AUTOMATION_DRIVER_ERROR';
    throw error;
  }
  const calls = {};
  const component = {
    data: safeClone(definition.data || {}),
    setData(patch, callback) {
      applyDataPatch(this.data, patch || {});
      if (typeof callback === 'function') callback.call(this);
    }
  };
  Object.keys(definition.methods || {}).forEach((key) => {
    component[key] = (...args) => {
      calls[key] = (calls[key] || 0) + 1;
      return definition.methods[key].apply(component, args);
    };
  });
  component.__attach = () => {
    const attached = definition.lifetimes && definition.lifetimes.attached;
    if (typeof attached === 'function') attached.call(component);
  };
  component.__detach = () => {
    const detached = definition.lifetimes && definition.lifetimes.detached;
    if (typeof detached === 'function') detached.call(component);
  };
  component.__audit = () => ({ calls: Object.assign({}, calls) });
  component.__attach();
  return component;
}

module.exports = {
  extractVoiceBindings,
  loadCustomTabComponent
};
