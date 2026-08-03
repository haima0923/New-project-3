const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const automator = require('miniprogram-automator');

function loadAutomatorImageLibrary() {
  try {
    return require('jimp');
  } catch (error) {
    const automatorRoot = path.dirname(require.resolve('miniprogram-automator/package.json'));
    return require(path.resolve(automatorRoot, '../jimp'));
  }
}

const Jimp = loadAutomatorImageLibrary();

const PROJECT_PATH = path.resolve(__dirname, '../../../');
const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const ARTIFACT_DIR = path.join(
  PROJECT_PATH,
  'output',
  'wechat-runtime',
  'order-delivery-date-wxml-v1'
);
const AUTOMATION_BASE_PORT = Number(process.env.WECHAT_AUTOMATION_PORT || 9447);
const REQUESTED_CASE_IDS = String(process.env.WECHAT_CASE_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const EXPECTED_HEAD = String(
  process.env.WECHAT_EXPECTED_HEAD || '28860c27daa416cd8d57f11d0c6a509ad7801922'
).trim();
const EXPECTED_BRANCH = String(
  process.env.WECHAT_EXPECTED_BRANCH || 'test/single-item-order-complete-save-contract-v1'
).trim();
const SOURCE_FILES = [
  'pages/dashboard/dashboard.js',
  'pages/dashboard/dashboard.wxml',
  'pages/input/input.js',
  'pages/input/input.wxml',
  'utils/parser.js',
  'utils/date.js'
];

function progress(message) {
  process.stderr.write(`[wechat-wxml] ${new Date().toISOString()} ${message}\n`);
}

const CASES = [
  {
    caseId: 'CASE-A',
    pageName: 'home',
    path: '/pages/dashboard/dashboard',
    navigationMethod: 'switchTab',
    inputSelector: '.composer-input',
    confirmSelector: '.confirm-modal',
    scrollSelector: '.confirm-modal-body',
    dateContentSelector: '.confirm-date-input',
    expectedDate: '2026-08-10',
    text: '林老板订100个水杯，每个8元，8月10日交',
    surface: 'HOME_QUICK'
  },
  {
    caseId: 'CASE-B',
    pageName: 'full-input',
    path: '/pages/input/input',
    navigationMethod: 'reLaunch',
    inputSelector: '.textarea',
    parseButtonSelector: '.parse-button',
    confirmSelector: '.input-confirm-modal',
    scrollSelector: '.input-confirm-body',
    dateContentSelector: '.date-picker-input',
    expectedDate: '2026-08-15',
    text: '赵老板订300个杯垫，每个2元，8月15日交',
    surface: 'FULL_PAGE'
  },
  {
    caseId: 'CASE-C',
    pageName: 'home-control',
    path: '/pages/dashboard/dashboard',
    navigationMethod: 'switchTab',
    inputSelector: '.composer-input',
    confirmSelector: '.confirm-modal',
    scrollSelector: '.confirm-modal-body',
    dateContentSelector: '.confirm-date-input',
    expectedDate: '2026-08-15',
    text: '赵老板订300个杯垫，每个2元，8月15日交',
    surface: 'HOME_QUICK'
  },
  {
    caseId: 'CASE-D',
    pageName: 'home-spaced-date',
    path: '/pages/dashboard/dashboard',
    navigationMethod: 'switchTab',
    inputSelector: '.composer-input',
    confirmSelector: '.confirm-modal',
    scrollSelector: '.confirm-modal-body',
    dateContentSelector: '.confirm-date-input',
    expectedDate: '2026-08-15',
    text: '赵老板定了 300 个杯垫，每个 2 元，8 月 15 日交',
    surface: 'HOME_QUICK'
  },
  {
    caseId: 'CASE-E',
    pageName: 'full-input-spaced-date',
    path: '/pages/input/input',
    navigationMethod: 'reLaunch',
    inputSelector: '.textarea',
    parseButtonSelector: '.parse-button',
    confirmSelector: '.input-confirm-modal',
    scrollSelector: '.input-confirm-body',
    dateContentSelector: '.date-picker-input',
    expectedDate: '2026-08-15',
    text: '赵老板定了 300 个杯垫，每个 2 元，8 月 15 日交',
    surface: 'FULL_PAGE'
  }
];

function execFile(file, args) {
  return childProcess.execFileSync(file, args, {
    cwd: PROJECT_PATH,
    encoding: 'utf8'
  }).trim();
}

function git(...args) {
  return execFile('/usr/bin/git', args);
}

function sha256(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(PROJECT_PATH, relativePath)))
    .digest('hex');
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function numberValue(value) {
  const parsed = Number.parseFloat(String(value == null ? '' : value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function withinViewport(offset, size, viewport) {
  if (!offset || !size || !viewport) return false;
  const left = numberValue(offset.left);
  const top = numberValue(offset.top);
  const width = numberValue(size.width);
  const height = numberValue(size.height);
  return width > 0 && height > 0
    && left + width > 0
    && top + height > 0
    && left < numberValue(viewport.width)
    && top < numberValue(viewport.height);
}

async function elementEvidence(element, contentElement, viewport) {
  if (!element) return { exists: false };
  const size = await element.size();
  const offset = await element.offset();
  const hidden = await element.attribute('hidden');
  const display = await element.style('display');
  const visibility = await element.style('visibility');
  const opacity = await element.style('opacity');
  const text = await element.text();
  const attributeValue = await element.attribute('value');
  const runtimeValue = await element.value();
  const className = await element.attribute('class');
  const outerWxml = await element.outerWxml();
  const content = contentElement ? {
    className: await contentElement.attribute('class'),
    display: await contentElement.style('display'),
    offset: await contentElement.offset(),
    opacity: await contentElement.style('opacity'),
    size: await contentElement.size(),
    text: await contentElement.text(),
    visibility: await contentElement.style('visibility')
  } : null;
  const renderedInViewport = withinViewport(offset, size, viewport);
  const visuallyEligible = renderedInViewport
    && display !== 'none'
    && visibility !== 'hidden'
    && opacity !== '0';
  return {
    exists: true,
    tagName: element.tagName,
    text,
    attributeValue,
    runtimeValue,
    className,
    hidden,
    display,
    visibility,
    opacity,
    size,
    offset,
    renderedInViewport,
    visuallyEligible,
    occlusionAssessment: visuallyEligible
      ? '元素位于当前视口且自身样式可见；结合局部截图核验是否有遮挡。'
      : '元素未处于当前视口或自身样式不可见。',
    content,
    outerWxml
  };
}

async function cropElementScreenshot(fullPath, cropPath, evidence, viewport) {
  if (!evidence || !evidence.exists || !evidence.offset || !evidence.size) return false;
  const image = await Jimp.read(fullPath);
  const scale = image.bitmap.width / numberValue(viewport.width);
  const screenshotHeightInCssPixels = image.bitmap.height / scale;
  const topSystemChrome = Math.max(
    0,
    screenshotHeightInCssPixels - numberValue(viewport.height)
  );
  const padding = 20;
  const left = Math.max(0, Math.floor(numberValue(evidence.offset.left) * scale) - padding);
  const top = Math.max(
    0,
    Math.floor((numberValue(evidence.offset.top) + topSystemChrome) * scale) - padding
  );
  const right = Math.min(
    image.bitmap.width,
    Math.ceil((numberValue(evidence.offset.left) + numberValue(evidence.size.width)) * scale) + padding
  );
  const bottom = Math.min(
    image.bitmap.height,
    Math.ceil(
      (numberValue(evidence.offset.top) + topSystemChrome + numberValue(evidence.size.height)) * scale
    ) + padding
  );
  if (right <= left || bottom <= top) return false;
  await image.crop(left, top, right - left, bottom - top).writeAsync(cropPath);
  return true;
}

async function waitForSelector(page, selector, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const element = await page.$(selector);
    if (element) return element;
    await page.waitFor(200);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function captureScreenshot(miniProgram, page, screenshotPath, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await miniProgram.screenshot({ path: screenshotPath });
      return;
    } catch (error) {
      lastError = error;
      progress(`${label} screenshot attempt ${attempt} failed: ${error.message}`);
      await page.waitFor(1200);
    }
  }
  throw lastError;
}

async function moveDateIntoViewport(page, testCase, dateElement, viewport) {
  let evidence = await elementEvidence(
    dateElement,
    await dateElement.$(testCase.dateContentSelector),
    viewport
  );
  if (evidence.renderedInViewport) return evidence;
  const scrollView = await page.$(testCase.scrollSelector);
  if (!scrollView || typeof scrollView.scrollTo !== 'function') return evidence;
  const targetTop = Math.max(0, numberValue(evidence.offset && evidence.offset.top) - 260);
  await scrollView.scrollTo(0, targetTop);
  await page.waitFor(500);
  evidence = await elementEvidence(
    dateElement,
    await dateElement.$(testCase.dateContentSelector),
    viewport
  );
  return evidence;
}

function classify(parserDate, pageDate, renderedEvidence, expectedDate) {
  if (!parserDate) return 'R4';
  if (!pageDate) return 'R3';
  const renderedText = String(renderedEvidence && renderedEvidence.text || '');
  const renderedValue = String(
    renderedEvidence && (renderedEvidence.attributeValue || renderedEvidence.runtimeValue) || ''
  );
  const correctRender = renderedEvidence && renderedEvidence.exists
    && renderedEvidence.visuallyEligible
    && renderedText.includes(expectedDate)
    && renderedValue === expectedDate;
  return correctRender ? 'R1' : 'R2';
}

async function runCase(miniProgram, testCase, identity, runtimeArtifactDir) {
  progress(`${testCase.caseId} ${testCase.navigationMethod} ${testCase.path}`);
  const expectedPath = testCase.path.replace(/^\//, '');
  let page = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let launchedPage;
    try {
      launchedPage = await miniProgram[testCase.navigationMethod](testCase.path);
    } catch (error) {
      if (!/timeout waiting for automator response/i.test(String(error && error.message))) {
        throw error;
      }
      // The current DevTools build can complete a first-time tab compilation
      // but omit the navigation response within automator 0.12.1's request
      // timeout. Always verify the live route; a retained __dev__ route never
      // counts as success.
      progress(`${testCase.caseId} navigation attempt ${attempt} timed out; verify live route`);
    }
    if (launchedPage) await launchedPage.waitFor(1000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // automator 0.12.1 caches Page objects by runtime page id. DevTools can
    // reuse an id that belonged to its initial __dev__ page when switching tabs.
    if (miniProgram.pageMap && typeof miniProgram.pageMap.clear === 'function') {
      miniProgram.pageMap.clear();
    }
    page = await miniProgram.currentPage() || launchedPage;
    progress(`${testCase.caseId} current page attempt ${attempt}: ${page && page.path || 'none'}`);
    if (page && page.path === expectedPath) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  if (!page || page.path !== expectedPath) {
    throw new Error(
      `${testCase.caseId} navigation did not reach ${expectedPath}; current=${page && page.path || 'none'}`
    );
  }
  progress(`${testCase.caseId} input`);
  const input = await waitForSelector(page, testCase.inputSelector);
  await input.input(testCase.text);
  // automator writes the native control value; dispatch the same bound input
  // event a real user edit produces so the page model receives the text.
  await input.trigger('input', { value: testCase.text });
  // Dismiss the focused native text control before asking DevTools for a
  // screenshot. This is a real blur event and does not touch any date field.
  await input.trigger('blur', { value: testCase.text });
  await page.waitFor(300);

  const stem = [
    testCase.pageName,
    testCase.caseId.toLowerCase(),
    testCase.expectedDate,
    identity.head.slice(0, 7)
  ].map(safeFileName).join('-');
  const inputScreenshotName = `${stem}-input.png`;
  const confirmationScreenshotName = `${stem}-confirmation.png`;
  const dateViewportScreenshotName = `${stem}-date-viewport.png`;
  const dateRegionScreenshotName = `${stem}-date-region.png`;
  const inputScreenshot = path.join(runtimeArtifactDir, inputScreenshotName);
  const confirmationScreenshot = path.join(runtimeArtifactDir, confirmationScreenshotName);
  const dateViewportScreenshot = path.join(runtimeArtifactDir, dateViewportScreenshotName);
  const dateRegionScreenshot = path.join(runtimeArtifactDir, dateRegionScreenshotName);
  await captureScreenshot(miniProgram, page, inputScreenshot, `${testCase.caseId} input`);

  progress(`${testCase.caseId} submit parse`);
  if (testCase.surface === 'HOME_QUICK') {
    await input.trigger('confirm', { value: testCase.text });
  } else {
    const parseButton = await waitForSelector(page, testCase.parseButtonSelector);
    await parseButton.tap();
  }

  await waitForSelector(page, testCase.confirmSelector);
  await page.waitFor(1000);
  progress(`${testCase.caseId} confirmation visible`);
  await captureScreenshot(
    miniProgram,
    page,
    confirmationScreenshot,
    `${testCase.caseId} confirmation`
  );

  progress(`${testCase.caseId} collect page data and WXML`);
  const pageData = await page.data();
  const parseResult = pageData.parseResult || {};
  const parseFields = parseResult.fields || {};
  const viewport = await page.size();
  const dateSelector = 'picker[data-field="dueDate"]';
  const dateElements = await page.$$(dateSelector);
  const dateElement = dateElements.length === 1 ? dateElements[0] : null;
  const beforeScrollEvidence = await elementEvidence(
    dateElement,
    dateElement ? await dateElement.$(testCase.dateContentSelector) : null,
    viewport
  );
  const renderedEvidence = dateElement
    ? await moveDateIntoViewport(page, testCase, dateElement, viewport)
    : beforeScrollEvidence;
  progress(`${testCase.caseId} date element collected`);
  await captureScreenshot(
    miniProgram,
    page,
    dateViewportScreenshot,
    `${testCase.caseId} date viewport`
  );
  const cropSaved = await cropElementScreenshot(
    dateViewportScreenshot,
    dateRegionScreenshot,
    renderedEvidence,
    viewport
  );

  const homeDateIndex = testCase.surface === 'HOME_QUICK'
    ? (pageData.confirmFields || []).findIndex((item) => item.field === 'dueDate')
    : -1;
  const homeDateItem = homeDateIndex >= 0 ? pageData.confirmFields[homeDateIndex] : null;
  const pageDate = testCase.surface === 'HOME_QUICK'
    ? String(homeDateItem && homeDateItem.value || '')
    : String(pageData.fields && pageData.fields.dueDate || '');
  const parserDate = String(parseFields.dueDate || '');
  const classification = classify(parserDate, pageDate, renderedEvidence, testCase.expectedDate);
  const text = String(renderedEvidence && renderedEvidence.text || '');

  return {
    caseId: testCase.caseId,
    surface: testCase.surface,
    originalText: testCase.text,
    expectedDate: testCase.expectedDate,
    currentPagePath: page.path,
    parser: {
      dueDate: parserDate,
      dateDetail: parseResult.date_detail || null,
      matchedText: parseResult.date_detail && parseResult.date_detail.matchedText || '',
      source: parseResult.field_sources && parseResult.field_sources.dueDate || '',
      confidence: parseResult.confidence,
      dateConfidence: parseResult.date_detail && parseResult.date_detail.confidence,
      lowConfidenceFields: parseResult.low_confidence_fields || [],
      missingFields: parseResult.missing_fields || [],
      blockingCodes: pageData.preflightBlockingReasons || [],
      route: parseResult.parse_route && parseResult.parse_route.decision || '',
      aiAttempted: parseResult.ai_fallback && parseResult.ai_fallback.attempted === true,
      aiCallCount: parseResult.ai_fallback && parseResult.ai_fallback.attempted === true ? 1 : 0
    },
    pageData: testCase.surface === 'HOME_QUICK' ? {
      confirmFields: pageData.confirmFields || [],
      dateItemIndex: homeDateIndex,
      dateItem: homeDateItem
    } : {
      fieldsDueDate: pageDate,
      showDueDateField: pageData.showDueDateField === true,
      dueDateLabel: pageData.dueDateLabel || '',
      preflightBlockingReasons: pageData.preflightBlockingReasons || []
    },
    rendered: {
      selector: dateSelector,
      matchCount: dateElements.length,
      pageViewport: viewport,
      beforeScroll: beforeScrollEvidence,
      afterScroll: renderedEvidence,
      displaysExpectedDate: text.includes(testCase.expectedDate),
      displaysEmptyPrompt: /请选择交期|点击选择日期/.test(text),
      classification
    },
    screenshots: {
      input: path.relative(PROJECT_PATH, path.join(ARTIFACT_DIR, inputScreenshotName)),
      confirmation: path.relative(PROJECT_PATH, path.join(ARTIFACT_DIR, confirmationScreenshotName)),
      dateViewport: path.relative(PROJECT_PATH, path.join(ARTIFACT_DIR, dateViewportScreenshotName)),
      dateRegion: cropSaved
        ? path.relative(PROJECT_PATH, path.join(ARTIFACT_DIR, dateRegionScreenshotName))
        : ''
    }
  };
}

async function main() {
  const realProjectPath = fs.realpathSync(PROJECT_PATH);
  const branch = git('branch', '--show-current');
  const head = git('rev-parse', 'HEAD');
  const tags = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
  const worktreeStatus = git('status', '--short').split('\n').filter(Boolean);
  const productionDiff = git(
    'diff', '--name-only', '--', 'pages', 'utils', 'server', 'app.js', 'app.json', 'project.config.json'
  ).split('\n').filter(Boolean);
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(file)]));
  const identity = {
    projectPath: realProjectPath,
    branch,
    head,
    tags,
    worktreeStatus,
    productionDiff,
    sourceHashes
  };
  const productionDiffAllowed = productionDiff.every((file) => file === 'utils/date.js');
  identity.productionDiffAllowed = productionDiffAllowed;
  const identityOk = realProjectPath === PROJECT_PATH
    && branch === EXPECTED_BRANCH
    && head === EXPECTED_HEAD
    && productionDiffAllowed;
  if (!identityOk) {
    throw Object.assign(new Error('R5: runtime package identity gate failed'), {
      evidence: identity
    });
  }

  const runtimeArtifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'huoxiaoling-wechat-wxml-')
  );
  let report;
  let classification;
  const cases = [];
  const sessions = [];
  const selectedCases = REQUESTED_CASE_IDS.length > 0
    ? CASES.filter((testCase) => REQUESTED_CASE_IDS.includes(testCase.caseId))
    : CASES;
  if (selectedCases.length === 0) {
    throw new Error(`No matching cases for WECHAT_CASE_IDS=${REQUESTED_CASE_IDS.join(',')}`);
  }
  for (let index = 0; index < selectedCases.length; index += 1) {
    const testCase = selectedCases[index];
    const port = AUTOMATION_BASE_PORT + index;
    const endpoint = `ws://127.0.0.1:${port}`;
    const launchedAt = new Date().toISOString();
    let miniProgram;
    try {
      progress(`launch ${realProjectPath} at ${endpoint} for ${testCase.caseId}`);
      miniProgram = await automator.launch({
        cliPath: CLI_PATH,
        projectPath: realProjectPath,
        port,
        timeout: 60000,
        trustProject: true
      });
    } catch (error) {
      error.message = `R5: failed to launch WeChat automation at ${endpoint}: ${error.message}`;
      throw error;
    }
    try {
      progress(`${testCase.caseId} automation connected`);
      const systemInfo = await miniProgram.systemInfo();
      const runtimeClock = await miniProgram.evaluate(() => ({
        iso: new Date().toISOString(),
        timezoneOffsetMinutes: new Date().getTimezoneOffset()
      }));
      // This DevTools profile retains an internal __dev__ compile condition
      // that can finish asynchronously and reclaim the page stack about ten
      // seconds after connection. Let it settle before entering the real tab.
      const startupPage = await miniProgram.currentPage();
      if (startupPage) await startupPage.waitFor(12000);
      cases.push(await runCase(miniProgram, testCase, identity, runtimeArtifactDir));
      sessions.push({
        caseId: testCase.caseId,
        launchedAt,
        automationEndpoint: endpoint,
        runtimeClock,
        systemInfo
      });
    } finally {
      if (miniProgram) await miniProgram.close();
    }
  }
  const classifications = Array.from(new Set(cases.map((item) => item.rendered.classification)));
  classification = classifications.length === 1 ? classifications[0] : classifications.join('+');
  report = {
    schemaVersion: 'wechat-order-delivery-date-wxml-runtime-v1',
    result: classification,
    environment: {
      miniprogramAutomatorVersion: require('miniprogram-automator/package.json').version,
      developerToolsVersion: '36.6.0',
      cliPath: CLI_PATH,
      captureTempPath: runtimeArtifactDir,
      sessions
    },
    identity,
    cases,
    constraints: {
      dateControlInteractions: 0,
      directSetDataCalls: 0,
      directDueDateWrites: 0,
      fixtureDueDatePrefill: false,
      formalSaveCalls: 0
    }
  };

  // Screenshots are captured outside the project while DevTools is connected.
  // Writing them under projectPath would trigger a recompile and invalidate the
  // live page handle. Copy them into the ignored output directory only after
  // the automation session has closed.
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const fileName of fs.readdirSync(runtimeArtifactDir)) {
    fs.copyFileSync(
      path.join(runtimeArtifactDir, fileName),
      path.join(ARTIFACT_DIR, fileName)
    );
  }
  const reportPath = path.join(
    ARTIFACT_DIR,
    `order-date-wxml-${head.slice(0, 7)}-${cases.map((item) => item.caseId.toLowerCase()).join('-')}-${classification.toLowerCase()}.json`
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    reportPath: path.relative(PROJECT_PATH, reportPath),
    result: classification,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      page: item.currentPagePath,
      parserDate: item.parser.dueDate,
      pageDate: item.surface === 'HOME_QUICK'
        ? item.pageData.dateItem && item.pageData.dateItem.value || ''
        : item.pageData.fieldsDueDate,
      renderedText: item.rendered.afterScroll.text || '',
      pickerValue: item.rendered.afterScroll.attributeValue
        || item.rendered.afterScroll.runtimeValue || '',
      visible: item.rendered.afterScroll.visuallyEligible,
      classification: item.rendered.classification,
      screenshots: item.screenshots
    }))
  }, null, 2)}\n`);
  if (cases.some((item) => item.rendered.classification !== 'R1')) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const output = {
    result: String(error.message || '').startsWith('R5:') ? 'R5' : 'BLOCKED',
    error: error.stack || String(error),
    evidence: error.evidence || null
  };
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = 1;
});
