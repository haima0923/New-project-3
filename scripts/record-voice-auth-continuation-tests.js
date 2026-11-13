const assert = require('assert');
const { spawnSync } = require('child_process');
const { createHoldHarness, flushAsync } = require('../tests/record-e2e/record-hold-to-talk-v1/runtime');
const { AI_AUTH_STORAGE_KEY, requestJson } = require('../utils/api-client');

const STANDARD = '赵姐礼品盒五百套三块八一套';
const LOCAL = '王总水杯100个5元一个8月15日交';
const DEEP = '王总下单水杯100个，每个5元；纸袋200个，每个2元；8月15日交。';
let total = 0;
let passed = 0;
let executed = 0;
let listOnly = false;
const caseNames = [];
const selectedCase = process.argv[2] === '--case' && /^\d+$/.test(process.argv[3] || '')
  ? Number(process.argv[3]) : null;
if (process.argv.length > 2 && (process.argv.length !== 4 || !selectedCase)) throw new Error('Invalid isolated case argument');

function authControl(harness, options = {}) {
  const wx = harness.fakeWx.wx;
  const originalRequest = wx.request;
  const originalLogin = wx.login;
  const logins = [], exchanges = [], ai = [], pendingAi = [];
  let loginCount = 0;
  if (!options.warm) wx.removeStorageSync(AI_AUTH_STORAGE_KEY);
  wx.login = (callbacks) => { loginCount += 1; logins.push(callbacks); };
  wx.request = (request) => {
    if (request.url.endsWith('/api/auth/wechat-login')) {
      exchanges.push(request);
      return { abort() {} };
    }
    ai.push({ path: request.url.split('/api/')[1], source: request.data.source, requestId: request.data.requestId, businessDate: request.data.businessDate });
    if (options.secondNotReady) {
      const error = Object.assign(new Error('controlled auth not ready'), { code: 'AUTH_SESSION_NOT_READY' });
      request.fail(error);
      return { abort() {} };
    }
    if (options.ai401) {
      request.success({ statusCode: 401, data: { error: 'AUTH_REQUIRED' } });
      return { abort() {} };
    }
    if (options.aiPending) { pendingAi.push(request); return { abort() {} }; }
    // Existing controlled transport uses an empty non-real model response.
    // This suite proves timing and request count, never model/save validity.
    return originalRequest(request);
  };
  return {
    ai,
    loginCount: () => loginCount,
    async login(ok = true) {
      const callbacks = logins.shift();
      if (!callbacks) return false;
      if (ok) callbacks.success({ code: 'controlled-code-not-a-real-credential' });
      else callbacks.fail({ code: 'CONTROLLED_LOGIN_FAILED' });
      await flushAsync();
      return true;
    },
    async exchange(ok = true) {
      const request = exchanges.shift();
      if (!request) return false;
      if (ok) request.success({ statusCode: 200, data: { token: 'CONTROLLED_TOKEN', expiresAt: '2027-08-05T12:00:00Z' } });
      else request.fail(Object.assign(new Error('controlled auth failure'), { code: 'CONTROLLED_AUTH_FAILED' }));
      await flushAsync();
      return true;
    },
    async ready() { await this.login(); await this.exchange(); },
    async releaseAi() {
      const request = pendingAi.shift();
      if (!request) return false;
      request.success({ statusCode: 200, data: {} });
      await flushAsync();
      return true;
    },
    async cleanup() {
      // Settle module-level pendingLogin even in the never-callback tests.
      while (logins.length || exchanges.length) { await this.login(); await this.exchange(); }
      await flushAsync();
      wx.request = originalRequest;
      wx.login = originalLogin;
    }
  };
}

async function utter(h, text = STANDARD, surface = 'tab') {
  const dispatch = surface === 'hero' ? h.dispatchHero : h.dispatchTab;
  dispatch('start', h.touch.touchStart());
  h.voice.emitStart();
  h.scheduler.advanceBy(700);
  dispatch('end', h.touch.touchEnd());
  h.voice.emitFinal(undefined, text);
  await h.followInput({ settle: false });
  await flushAsync(10);
}

function noWrites(h) {
  const audit = h.audit();
  assert.strictEqual(audit.businessMutation, false);
  assert(Object.values(audit.input.writerCalls).every(value => value === 0));
  assert(Object.values(audit.dashboardAuthority).every(value => value === 0));
}

async function check(name, action, options = {}) {
  total += 1;
  if (listOnly) { caseNames.push(name); return; }
  if (selectedCase !== total) return;
  executed += 1;
  const h = createHoldHarness({ caseId: `VOICE-AUTH-${total}`, origin: 'records' });
  const auth = authControl(h, options);
  try {
    await action(h, auth);
    noWrites(h);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    if (h.input.page.onHide) h.input.page.onHide();
    await auth.cleanup();
    h.dispose();
    await flushAsync();
  }
}

async function main() {
  await check('暖会话标准核对仍只请求一次', async (h, auth) => {
    await utter(h);
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.loginCount(), 0);
  }, { warm: true });
  await check('Tab获准开始录音时预热，无需等终稿', async (h, auth) => {
    h.dispatchTab('start', h.touch.touchStart());
    await flushAsync();
    assert.strictEqual(auth.loginCount(), 1);
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('冷会话终稿后等待，登录完成自动继续一次', async (h, auth) => {
    await utter(h);
    assert.strictEqual(h.input.page.data.parsing, true);
    assert.strictEqual(auth.ai.length, 0);
    h.input.page.saveFormal();
    h.input.page.savePending();
    noWrites(h);
    const operation = h.input.page.inFlightParseOperation.promise;
    const originalBusinessDate = h.input.page.activeParseIdentity.businessDate;
    assert.strictEqual(h.input.page.runParse(), operation, '重复点击应共用操作');
    const evidence = h.input.page.voiceCompletionEvidence;
    assert(require('../utils/voice-recognition').validateVoiceCompletionEvidence(evidence, STANDARD, { inputChannel: 'VOICE_TRANSCRIPT' }).valid);
    await auth.ready();
    await operation;
    assert.strictEqual(auth.loginCount(), 1);
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.ai[0].businessDate, originalBusinessDate);
    assert.strictEqual(h.input.page.data.parsing, false);
    assert.strictEqual(h.audit().input.runParseCount, 2, '只多出手动重复点击，不递归调用handler');
    assert.notStrictEqual((h.input.page.data.parseResult.ai_fallback || {}).code, 'AUTH_SESSION_NOT_READY');
  });
  await check('录音期间登录完成，终稿正常处理', async (h, auth) => {
    h.dispatchTab('start', h.touch.touchStart());
    await flushAsync();
    assert.strictEqual(auth.loginCount(), 1);
    await auth.ready();
    h.voice.emitStart(); h.scheduler.advanceBy(700);
    h.dispatchTab('end', h.touch.touchEnd()); h.voice.emitFinal(undefined, STANDARD);
    await h.followInput({ settle: false }); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
  });
  await check('首页同类转交也可等待原登录', async (h, auth) => {
    await utter(h, STANDARD, 'hero');
    assert.strictEqual(h.input.page.data.parsing, true);
    await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
  });
  await check('本地明确订单不等待冷登录', async (h, auth) => {
    await utter(h, LOCAL);
    assert.strictEqual(h.input.page.data.parsing, false);
    assert.strictEqual(h.audit().input.route, 'FAST_LOCAL');
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('缺事实补问不等待冷登录', async (h, auth) => {
    await utter(h, '王总周三交500个5元');
    assert.strictEqual(h.input.page.data.parsing, false);
    assert.strictEqual(h.audit().input.route, 'ASK_USER');
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('Deep保留原等待策略', async (h, auth) => {
    await utter(h, DEEP);
    assert.strictEqual(h.input.page.data.parsing, true);
    await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.ai[0].path, 'ai/parse/deep');
  });
  for (const [name, action] of [
    ['改文字', page => page.onTextInput({ detail: { value: '新的文字' } })],
    ['手工输入同样文字', page => page.onTextInput({ detail: { value: STANDARD } })],
    ['换来源', page => page.setSource({ currentTarget: { dataset: { source: 'typed' } } })],
    ['取消', page => page.cancelVoice()],
    ['返回输入', page => page.returnToInput()],
    ['关闭确认卡', page => page.closeConfirmCard()],
    ['隐藏', page => page.onHide()],
    ['卸载', page => page.onUnload()],
    ['重新录音', page => page.startVoice()]
  ]) await check(`等待期间${name}会结算并撤销旧请求`, async (h, auth) => {
    await utter(h);
    assert.strictEqual(h.input.page.data.parsing, true);
    const operation = h.input.page.inFlightParseOperation;
    const timerIds = h.scheduler.pendingTasks().filter(task => task.delay === 5000).map(task => task.id);
    assert(timerIds.length > 0, '必须实际进入认证等待');
    let settled = false;
    operation.promise.then(() => { settled = true; });
    action(h.input.page);
    await flushAsync();
    assert.strictEqual(settled, true);
    assert(!h.scheduler.pendingTasks().some(task => timerIds.includes(task.id)), '旧认证timer必须清理');
    const text = h.input.page.data.text;
    await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 0);
    assert.strictEqual(h.input.page.data.text, text);
    if (name === '隐藏' || name === '卸载') assert.strictEqual(h.input.page.confirmationSessionId, '');
  });
  await check('底部再次开始录音立即撤销旧等待', async (h, auth) => {
    await utter(h);
    const operation = h.input.page.inFlightParseOperation;
    assert(operation);
    let settled = false; operation.promise.then(() => { settled = true; });
    h.dispatchTab('start', h.touch.touchStart(2));
    await flushAsync();
    assert.strictEqual(settled, true);
    await auth.ready();
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('5000ms上限包含永不返回的wx.login，迟到成功不续跑', async (h, auth) => {
    await utter(h);
    assert.strictEqual(h.input.page.data.parsing, true);
    h.scheduler.advanceBy(4999); await flushAsync();
    assert.strictEqual(h.input.page.data.parsing, true);
    h.scheduler.advanceBy(1); await flushAsync();
    assert.strictEqual(h.input.page.data.parsing, false);
    assert.strictEqual(h.input.page.data.text, STANDARD);
    await auth.ready();
    assert.strictEqual(auth.ai.length, 0);
  });
  for (const phase of ['login', 'exchange']) await check(`${phase}失败不循环登录或请求AI`, async (h, auth) => {
    await utter(h);
    if (phase === 'login') await auth.login(false);
    else { await auth.login(); await auth.exchange(false); }
    await flushAsync();
    assert.strictEqual(h.input.page.data.parsing, false);
    assert.strictEqual(auth.ai.length, 0);
    assert.strictEqual(auth.loginCount(), 1);
  });
  for (const options of [{ secondNotReady: true }, { ai401: true }]) await check(`继续后的${Object.keys(options)[0]}不再次循环`, async (h, auth) => {
    await utter(h); await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.loginCount(), 1);
    assert.strictEqual(h.input.page.data.parsing, false);
  }, options);
  await check('换token一直不返回也在页面5秒内结束', async (h, auth) => {
    await utter(h); await auth.login();
    assert.strictEqual(h.input.page.data.parsing, true);
    h.scheduler.advanceBy(5000); await flushAsync();
    assert.strictEqual(h.input.page.data.parsing, false);
    await auth.exchange();
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('跨过业务日期时停止自动继续并保留原话', async (h, auth) => {
    await utter(h);
    const CurrentDate = global.Date;
    const nextMs = CurrentDate.now() + 86400000;
    class TomorrowDate extends CurrentDate {
      constructor(...args) { super(...(args.length ? args : [nextMs])); }
      static now() { return nextMs; }
    }
    global.Date = TomorrowDate;
    try {
      assert.notStrictEqual(require('../utils/date').today(), h.input.page.confirmationBusinessDate);
      await auth.ready(); await flushAsync();
      assert.strictEqual(auth.ai.length, 0);
      assert.strictEqual(h.input.page.data.parsing, false);
      assert.strictEqual(h.input.page.data.text, STANDARD);
      assert.strictEqual(h.input.page.confirmationBusinessDate, '');
    } finally { global.Date = CurrentDate; }
  });
  await check('新的语音转交替换旧等待，只处理新会话一次', async (h, auth) => {
    await utter(h);
    const oldOperation = h.input.page.inFlightParseOperation;
    let oldSettled = false; oldOperation.promise.then(() => { oldSettled = true; });
    await utter(h);
    assert.strictEqual(oldSettled, true);
    const identity = h.input.page.activeParseIdentity;
    const newOperation = h.input.page.inFlightParseOperation;
    assert(identity && identity !== oldOperation.identity);
    await oldOperation.promise;
    assert.strictEqual(h.input.page.inFlightParseOperation, newOperation);
    assert.strictEqual(newOperation.settled, false);
    assert.strictEqual(h.input.page.runParse(), newOperation.promise);
    await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.ai[0].requestId, identity.requestId);
    assert.strictEqual(h.input.page.data.text, STANDARD);
  });
  await check('重复onShow与终稿不复制等待或请求', async (h, auth) => {
    await utter(h);
    h.input.page.onShow(); h.voice.emitFinal(undefined, STANDARD);
    await flushAsync(); await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.loginCount(), 1);
    assert.strictEqual(h.audit().handoff.publishCount, 1);
  });
  await check('来源字符串和有效Evidence不能伪造自动转交资格', async (h, auth) => {
    h.dispatchTab('start', h.touch.touchStart()); h.voice.emitStart(); h.scheduler.advanceBy(700);
    h.dispatchTab('end', h.touch.touchEnd()); h.voice.emitFinal(undefined, STANDARD);
    const payload = require('../utils/record-entry-handoff').consumeRecordEntryHandoff();
    h.input.page.onShow();
    h.input.page.setData({ text: STANDARD, source: 'voice' });
    h.input.page.voiceCompletionEvidence = payload.voiceCompletionEvidence;
    await h.input.page.runParse('standard', { inputChannel: 'VOICE_TRANSCRIPT', originSurface: 'CUSTOM_TAB_CENTER', voiceCompletionEvidence: payload.voiceCompletionEvidence });
    assert.strictEqual(h.input.page.data.parsing, false);
    await auth.ready();
    assert.strictEqual(auth.ai.length, 0);
  });
  await check('连接就绪后的请求仍受取消保护，迟到模型不覆盖输入', async (h, auth) => {
    await utter(h); await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    const operation = h.input.page.inFlightParseOperation;
    let settled = false; operation.promise.then(() => { settled = true; });
    h.input.page.onTextInput({ detail: { value: STANDARD } });
    await flushAsync();
    assert.strictEqual(settled, true);
    assert.strictEqual(h.input.page.data.source, 'typed');
    assert.strictEqual(await auth.releaseAi(), true, '实际送回迟到的受控HTTP成功回调');
    h.scheduler.advanceBy(8000); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(h.input.page.data.source, 'typed');
    assert.strictEqual(h.input.page.data.parseResult, null);
  }, { aiPending: true });
  await check('首次认证失败结果返回前，同字手工输入也不能被旧语音覆盖', async (h, auth) => {
    h.dispatchTab('start', h.touch.touchStart()); h.voice.emitStart(); h.scheduler.advanceBy(700);
    h.dispatchTab('end', h.touch.touchEnd()); h.voice.emitFinal(undefined, STANDARD);
    const entering = h.followInput({ settle: false });
    h.input.page.onTextInput({ detail: { value: STANDARD } });
    await entering; await flushAsync(); await auth.ready(); await flushAsync();
    assert.strictEqual(auth.ai.length, 0);
    assert.strictEqual(h.input.page.data.source, 'typed');
    assert.strictEqual(h.input.page.data.parseResult, null);
    assert.strictEqual(h.input.page.data.parsing, false);
  });
  await check('继续后的模型等待超时不进入认证循环', async (h, auth) => {
    await utter(h); await auth.ready(); await flushAsync();
    h.scheduler.advanceBy(8000); await flushAsync();
    assert.strictEqual(auth.ai.length, 1);
    assert.strictEqual(auth.loginCount(), 1);
    assert.strictEqual(h.input.page.data.parsing, false);
  }, { aiPending: true });
  await check('普通快速API即使登录pending仍立即拒绝，不偷等', async (h, auth) => {
    h.input.page.onShow(); await flushAsync();
    const count = auth.loginCount();
    await assert.rejects(requestJson('/api/ai/parse', { text: STANDARD }, 6700, { requireReadyAuth: true, retryAuth: false }), error => error.code === 'AUTH_SESSION_NOT_READY');
    assert.strictEqual(auth.ai.length, 0); assert.strictEqual(auth.loginCount(), count);
  });
  if (!listOnly && executed !== 1) throw new Error('Isolated case was not executed exactly once');
}
async function run() {
  if (selectedCase !== null) { await main(); return; }
  // Production voice/parser modules keep session identity in module scope.
  // Each case needs its own process, rather than rebinding a cached validator.
  listOnly = true;
  await main();
  let successful = 0;
  for (let index = 0; index < caseNames.length; index += 1) {
    const child = spawnSync(process.execPath, [__filename, '--case', String(index + 1)], {
      env: process.env,
      stdio: 'inherit'
    });
    if (child.status === 0 && !child.error) successful += 1;
    else process.exitCode = 1;
  }
  console.log(`Voice auth continuation: ${successful}/${caseNames.length} passed; isolated workers; real network 0; business writes 0`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
