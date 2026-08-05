#!/usr/bin/env node

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const PROJECT_PATH = path.resolve(__dirname, '../../..');
const CLI_PATH = process.env.WECHAT_CLI_PATH
  || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PORT = Number(process.env.WECHAT_AUTOMATION_PORT || 9461);
const TEXT = '王总订水杯10个，3元一个，8月15日交货';
const EXPECTED_BRANCH = process.env.WECHAT_EXPECTED_BRANCH
  || 'fix/multi-item-order-save-admission-v1';
const EXPECTED_HEAD = String(process.env.WECHAT_EXPECTED_HEAD || '').trim();
const ALLOWED_WORKTREE_FILES = new Set([
  'pages/input/input.js',
  'pages/input/input.wxml',
  'utils/ai-parser.js',
  'utils/business.js',
  'utils/parse-safety.js',
  'utils/parser.js',
  'utils/record-domain-preflight.js'
]);
const SOURCE_FILES = [
  'pages/input/input.js',
  'pages/input/input.wxml',
  'utils/ai-parser.js',
  'utils/parse-safety.js',
  'utils/record-domain-preflight.js'
];

function git(...args) {
  return childProcess.execFileSync('/usr/bin/git', args, {
    cwd: PROJECT_PATH,
    encoding: 'utf8'
  }).trim();
}

function sha256(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(PROJECT_PATH, relativePath)))
    .digest('hex');
}

function getCandidateIdentity() {
  assert(EXPECTED_HEAD, 'WECHAT_EXPECTED_HEAD 必须显式指定当前候选完整 HEAD');
  const branch = git('branch', '--show-current');
  const head = git('rev-parse', 'HEAD');
  const worktreeStatus = git('status', '--short').split('\n').filter(Boolean);
  const stagedFiles = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const worktreeFiles = worktreeStatus.map((line) => line.slice(3).trim());
  assert.strictEqual(branch, EXPECTED_BRANCH, '微信 runner 分支身份不一致');
  assert.strictEqual(head, EXPECTED_HEAD, '微信 runner HEAD 身份不一致');
  assert.deepStrictEqual(stagedFiles, [], '微信 runner 执行前暂存区必须为空');
  assert(worktreeStatus.every((line) => line.startsWith(' M ')), '微信 runner 只允许未暂存生产 diff');
  assert(worktreeFiles.every((file) => ALLOWED_WORKTREE_FILES.has(file)), '微信 runner 工作树超出白名单');
  return {
    branch,
    head,
    tags: git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean),
    worktreeStatus,
    sourceHashes: Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(file)]))
  };
}

async function assertVisible(element, label) {
  const size = await element.size();
  const display = await element.style('display');
  const visibility = await element.style('visibility');
  assert(Number(size.width) > 0 && Number(size.height) > 0, `${label} 必须有真实渲染尺寸`);
  assert.notStrictEqual(display, 'none', `${label} 不能 display:none`);
  assert.notStrictEqual(visibility, 'hidden', `${label} 不能 visibility:hidden`);
  return { size, display, visibility };
}

async function waitFor(page, selector, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const node = await page.$(selector);
    if (node) return node;
    await page.waitFor(200);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForParse(page, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await page.data();
    if (data.parseResult && data.parsing !== true) return data;
    await page.waitFor(200);
  }
  throw new Error('Timed out waiting for confirmation data');
}

async function main() {
  assert(fs.existsSync(CLI_PATH), `WeChat DevTools CLI not found: ${CLI_PATH}`);
  const identity = getCandidateIdentity();
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT_PATH,
      port: PORT,
      timeout: 60000,
      trustProject: true
    });
    const startupPage = await miniProgram.currentPage();
    if (startupPage) await startupPage.waitFor(12000);
    const page = await miniProgram.reLaunch('/pages/input/input');
    await page.waitFor(1500);
    assert.strictEqual(page.path, 'pages/input/input', '真实 WXML 必须停留在输入页而不是 __dev__ 页面');
    const input = await waitFor(page, '.textarea');
    await input.input(TEXT);
    await input.trigger('input', { value: TEXT });
    await input.trigger('blur', { value: TEXT });
    const parseButton = await waitFor(page, '.parse-button');
    await parseButton.tap();
    let data = await waitForParse(page);
    assert.strictEqual((data.confirmItems || []).length, 1);

    const addButton = await waitFor(page, '.confirm-item-add');
    await addButton.tap();
    await page.waitFor(400);
    data = await page.data();
    assert.strictEqual((data.confirmItems || []).length, 2);
    const firstKeys = data.confirmItems.map((entry) => entry.itemKey);
    assert.strictEqual(firstKeys.every(Boolean), true);
    assert.strictEqual(new Set(firstKeys).size, 2);
    assert((data.preflightBlockingReasons || []).includes('ORDER_ITEM_QUANTITY_REQUIRED'));
    assert.strictEqual(data.disableFormalSave, true);

    const warning = await page.$('.domain-blocking-box');
    assert(warning, '真实 WXML 必须渲染 domain 阻断原因');
    const warningVisibility = await assertVisible(warning, 'domain 阻断原因');
    const warningText = await warning.text();
    assert(/商品2/.test(warningText) && /数量/.test(warningText));
    const saveButton = await waitFor(page, '.formal-save-button');
    const saveButtonVisibility = await assertVisible(saveButton, '正式保存按钮');
    assert.strictEqual(String(await saveButton.attribute('disabled')), 'true');

    const quantityInputs = await page.$$('input[data-field="quantity"]');
    assert(quantityInputs.length >= 2);
    await quantityInputs[1].input('20');
    await quantityInputs[1].trigger('input', { value: '20' });
    await quantityInputs[1].trigger('blur', { value: '20' });
    await page.waitFor(400);
    data = await page.data();
    assert.deepStrictEqual(data.confirmItems.map((entry) => entry.itemKey), firstKeys);
    assert(!(data.preflightBlockingReasons || []).includes('ORDER_ITEM_QUANTITY_REQUIRED'));
    assert.strictEqual(data.disableFormalSave, false);
    assert.strictEqual(await page.$('.domain-blocking-box'), null);

    const specs = await page.$$('input[data-field="spec"]');
    await specs[0].input('大号');
    await specs[0].trigger('input', { value: '大号' });
    await specs[1].input('小号');
    await specs[1].trigger('input', { value: '小号' });
    await page.waitFor(300);
    data = await page.data();
    assert.deepStrictEqual(data.confirmItems.map((entry) => entry.itemKey), firstKeys);
    assert.strictEqual(data.confirmItems[0].spec, '大号');
    assert.strictEqual(data.confirmItems[1].spec, '小号');

    const removeButtons = await page.$$('.confirm-item-remove');
    await removeButtons[0].tap();
    await page.waitFor(300);
    data = await page.data();
    assert.deepStrictEqual(data.confirmItems.map((entry) => entry.itemKey), [firstKeys[1]]);
    assert.strictEqual(data.confirmItems[0].spec, '小号');

    const renderedCards = await page.$$('.confirm-item-card');
    assert.strictEqual(renderedCards.length, 1);
    assert.strictEqual(await renderedCards[0].attribute('data-item-key'), firstKeys[1]);
    assert.strictEqual(page.path, 'pages/input/input', '运行结束时页面路由必须仍是输入页');

    process.stdout.write(`${JSON.stringify({
      evidenceLevel: 'WECHAT_DEVTOOLS_REAL_WXML',
      page: page.path,
      identity,
      stableKeys: firstKeys,
      survivingKey: firstKeys[1],
      warningVisibleBeforeEdit: true,
      warningGoneAfterEdit: true,
      buttonRecovered: true,
      warningVisibility,
      saveButtonVisibility
    }, null, 2)}\n`);
  } finally {
    if (miniProgram) await miniProgram.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    evidenceLevel: 'WECHAT_DEVTOOLS_REAL_WXML',
    result: 'BLOCKED_OR_FAIL',
    error: error.stack || String(error)
  }, null, 2)}\n`);
  process.exitCode = 1;
});
