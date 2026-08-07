const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const WXML_PATH = path.join(ROOT, 'pages/input/input.wxml');
const WXML = fs.readFileSync(WXML_PATH, 'utf8').replace(/<!--[^]*?-->/g, '');
const SELF_CLOSING = new Set(['input', 'textarea', 'image', 'icon']);

function normalizeText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAttributes(source) {
  const attributes = {};
  String(source || '').replace(/([:\w-]+)\s*=\s*"([^"]*)"/g, (_all, name, value) => {
    attributes[name] = value;
    return _all;
  });
  return attributes;
}

function parseTree() {
  const root = { attributes: {}, children: [], end: WXML.length, name: 'root', parent: null, start: 0 };
  const stack = [root];
  const pattern = /<\/?([A-Za-z][\w-]*)\b([^>]*)>/g;
  let match;
  while ((match = pattern.exec(WXML))) {
    const closing = match[0].startsWith('</');
    const name = match[1];
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        const candidate = stack[index];
        if (candidate.name !== name) continue;
        candidate.end = pattern.lastIndex;
        stack.length = index;
        break;
      }
      continue;
    }
    const parent = stack[stack.length - 1];
    const node = {
      attributes: parseAttributes(match[2]),
      children: [],
      end: pattern.lastIndex,
      name,
      openEnd: pattern.lastIndex,
      parent,
      start: match.index
    };
    parent.children.push(node);
    const selfClosing = /\/\s*>$/.test(match[0]) || SELF_CLOSING.has(name);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const TREE = parseTree();

function flatten(node = TREE, output = []) {
  node.children.forEach((child) => {
    output.push(child);
    flatten(child, output);
  });
  return output;
}

const TREE_NODES = flatten();

function nodeSource(node) {
  return WXML.slice(node.start, node.end);
}

function ancestor(node, predicate) {
  let current = node && node.parent;
  while (current && current !== TREE) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

function classTokens(node) {
  return String(node && node.attributes.class || '').split(/\s+/).filter(Boolean);
}

function expressionsIn(source) {
  const output = [];
  String(source || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, expression) => {
    output.push(String(expression).trim());
    return _all;
  });
  return output;
}

function elements(tagName) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([^]*?)<\\/${tagName}>`, 'g');
  const output = [];
  let match;
  while ((match = pattern.exec(WXML))) {
    output.push({
      attributes: parseAttributes(match[1]),
      body: match[2],
      end: pattern.lastIndex,
      start: match.index,
      text: normalizeText(match[2])
    });
  }
  return output;
}

function bindings() {
  const output = [];
  WXML.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, expression, offset) => {
    output.push({ expression: String(expression).trim(), offset });
    return _all;
  });
  return output;
}

function buttonForHandler(handler) {
  return elements('button').find((node) => node.attributes.bindtap === handler) || null;
}

function hasBinding(pattern) {
  return bindings().some((entry) => pattern.test(entry.expression));
}

function hasQuestionPromptBinding() {
  return hasBinding(/(?:activeQuestion|surfaceQuestion|assistantQuestion)\.(?:prompt|text|message)|assistantQuestionPrompt/i);
}

function hasAnswerInput() {
  return /<(?:input|textarea)\b[^>]*(?:assistant|question)[^>]*(?:bindinput|value)=/i.test(WXML)
    || /<(?:input|textarea)\b[^>]*(?:bindinput|value)="[^"]*(?:assistant|question|answer)[^"]*"/i.test(WXML);
}

function hasQuestionAnswerAction() {
  return Boolean(buttonForHandler('answerAssistantQuestion'))
    || elements('button').some((node) => /(?:Assistant|Question|Answer)/.test(node.attributes.bindtap || ''));
}

function descendants(node, output = []) {
  (node && node.children || []).forEach((child) => {
    output.push(child);
    descendants(child, output);
  });
  return output;
}

function datasetFromAttributes(attributes = {}) {
  return Object.keys(attributes).filter((name) => name.startsWith('data-')).reduce((output, name) => {
    const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    output[key] = attributes[name];
    return output;
  }, {});
}

function questionUiContract() {
  const candidates = TREE_NODES.filter((node) => {
    if (!['view', 'form'].includes(node.name)) return false;
    const identity = `${node.attributes.class || ''} ${node.attributes['data-surface-role'] || ''}`;
    const condition = String(node.attributes['wx:if'] || '');
    return /assistant|question|clarification/i.test(identity)
      && /activeQuestion|surfaceQuestion|assistantQuestion/.test(condition);
  }).sort((left, right) => (left.end - left.start) - (right.end - right.start));
  for (const container of candidates) {
    const children = descendants(container);
    const input = children.find((node) => ['input', 'textarea'].includes(node.name)
      && Boolean(node.attributes.bindinput)
      && Boolean(node.attributes.value));
    const action = children.find((node) => node.name === 'button' && Boolean(node.attributes.bindtap));
    const prompt = expressionsIn(nodeSource(container)).some((expression) => (
      /(?:activeQuestion|surfaceQuestion|assistantQuestion)\.(?:prompt|text|message)|assistantQuestionPrompt/i.test(expression)
    ));
    if (!input || !action || !prompt) continue;
    return {
      actionDataset: datasetFromAttributes(action.attributes),
      actionHandler: action.attributes.bindtap,
      answerInputHandler: input.attributes.bindinput,
      answerValueBinding: input.attributes.value,
      containerClass: container.attributes.class || '',
      condition: container.attributes['wx:if'] || '',
      prompt,
      ready: true
    };
  }
  return {
    actionDataset: {},
    actionHandler: '',
    answerInputHandler: '',
    answerValueBinding: '',
    containerClass: '',
    condition: '',
    prompt: false,
    ready: false
  };
}

function questionSurfaceStructure() {
  const contract = questionUiContract();
  return {
    actionHandler: Boolean(contract.actionHandler),
    answerInputHandler: Boolean(contract.answerInputHandler),
    answerValueBinding: Boolean(contract.answerValueBinding),
    dedicatedContainer: Boolean(contract.containerClass),
    prompt: contract.prompt,
    ready: contract.ready
  };
}

function riskExpressionFor(field, itemScoped) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return itemScoped
    ? new RegExp(`(?:riskByItem|item\\.(?:riskByField|risks|issues|errors))[^}]*${escaped}|${escaped}(?:Risk|Issue|Error)`, 'i')
    : new RegExp(`(?:riskByField|fieldRisks|fieldRiskMap)(?:\\.|\\[['"]?)${escaped}|${escaped}(?:Risk|Issue|Error)`, 'i');
}

function controlNodes(field) {
  return TREE_NODES.filter((node) => (
    ['input', 'textarea', 'picker'].includes(node.name)
      && node.attributes['data-field'] === field
  ));
}

function localFieldContainer(node) {
  return ancestor(node, (candidate) => classTokens(candidate).some((token) => (
    token === 'field' || token === 'item-field' || token.includes('field')
  )));
}

function hasLocalRiskBinding(field, itemScoped = false) {
  const pattern = riskExpressionFor(field, itemScoped);
  return controlNodes(field).some((control) => {
    const container = localFieldContainer(control);
    if (!container) return false;
    if (itemScoped && !ancestor(container, (candidate) => classTokens(candidate).includes('confirm-item-card'))) {
      return false;
    }
    return expressionsIn(nodeSource(container)).some((expression) => pattern.test(expression));
  });
}

function hasAmountErrorState() {
  return controlNodes('amount').some((control) => {
    const container = localFieldContainer(control);
    const source = nodeSource(container || control);
    return /(?:class|aria-invalid)="[^"]*(?:risk|error|invalid|issue)/i.test(source)
      || expressionsIn(source).some((expression) => /risk|error|invalid|issue/i.test(expression));
  });
}

function hasCanonicalTotalNearAmount() {
  return controlNodes('amount').some((control) => {
    const container = localFieldContainer(control);
    const source = nodeSource(container || control);
    return /明细合计/.test(source)
      || expressionsIn(source).some((expression) => /calculatedAmount|canonical(?:Item)?Total|detail(?:s)?Total|amount(?:Risk|Issue|Error)/i.test(expression));
  });
}

function hasOriginalTextToggle() {
  return elements('button').some((node) => (
    /(?:toggle|show|expand).*(?:Original|Raw)/i.test(node.attributes.bindtap || '')
      && (node.text.includes('查看原话') || /original|raw/i.test(node.body))
  )) || /bindtap="[^"]*(?:toggle|show|expand)[^"]*(?:Original|Raw)[^"]*"/i.test(WXML);
}

function hasCollapsedOriginalTextGuard() {
  return /wx:if="\{\{[^"}]*(?:showOriginal|originalTextExpanded|isOriginalTextExpanded|showRawText)[^"}]*\}\}"/i.test(WXML);
}

function diagnosticBindings() {
  const patterns = [
    /^parseEvidence(?:\.|$)/,
    /^parseResult\.confirm_message$/,
    /^operationTitle$/,
    /^intentCandidatesText$/
  ];
  return bindings().filter((entry) => patterns.some((pattern) => pattern.test(entry.expression)));
}

function safeBlockedSurfaceStructure() {
  const container = TREE_NODES.filter((node) => {
    if (!['view', 'form'].includes(node.name)) return false;
    const identity = `${node.attributes.class || ''} ${node.attributes['data-surface-role'] || ''}`;
    const condition = String(node.attributes['wx:if'] || '');
    return /safe-blocked|safeBlocked|assistant-fallback|clarification-fallback/i.test(identity)
      && /SAFE_BLOCKED|safeBlocked|showSafeBlocked/.test(condition);
  }).sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  if (!container) {
    return {
      action: false,
      actionDataset: {},
      actionHandler: '',
      container: false,
      message: false
    };
  }
  const children = descendants(container);
  const action = children.find((node) => node.name === 'button'
    && ['returnToInput', 'savePending', 'runParse', 'retryParse'].includes(node.attributes.bindtap));
  const message = expressionsIn(nodeSource(container)).some((expression) => (
    /safeBlocked(?:Message|Text)|assistantFallback(?:Message|Text)|parseAssistText/i.test(expression)
  )) || /没听明白|请重新输入|可以先存待整理|暂时无法整理/.test(nodeSource(container));
  return {
    action: Boolean(action),
    actionDataset: datasetFromAttributes(action && action.attributes),
    actionHandler: action && action.attributes.bindtap || '',
    container: true,
    message
  };
}

function globalRiskBlocks() {
  const riskBindings = /localParseSafetyLines|fieldConflictLines|domainBlockingLines|warningMissingText|warningLowText/;
  return TREE_NODES.filter((node) => {
    if (node.name !== 'view') return false;
    if (!classTokens(node).includes('warning-box')) return false;
    return expressionsIn(nodeSource(node)).some((expression) => riskBindings.test(expression));
  }).map((node) => ({
    condition: String(node.attributes['wx:if'] || ''),
    expressions: expressionsIn(nodeSource(node)).filter((expression) => riskBindings.test(expression)),
    start: node.start
  }));
}

function visibleGlobalRiskBlocks(pageData = {}) {
  return globalRiskBlocks().filter((block) => {
    const condition = block.condition.trim();
    if (/!\s*(?:activeQuestion|surfaceQuestion|assistantQuestion)/.test(condition)) return false;
    const simpleFlag = condition.match(/^\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}$/);
    if (simpleFlag) return Boolean(pageData[simpleFlag[1]]);
    if (!condition) return true;
    return true;
  });
}

function primaryStructure() {
  const confirmBody = TREE_NODES.find((node) => classTokens(node).includes('input-confirm-body'));
  if (!confirmBody) return { body: false, coreIndex: -1, diagnosticIndex: -1, questionIndex: -1 };
  const children = confirmBody.children || [];
  const sourceOf = (node) => nodeSource(node);
  const questionIndex = children.findIndex((node) => /activeQuestion|surfaceQuestion|assistantQuestion/.test(sourceOf(node)));
  const coreIndex = children.findIndex((node) => /客户称呼|商品明细|交期|\{\{amountLabel\}\}/.test(sourceOf(node)));
  const diagnosticIndex = children.findIndex((node) => /parseEvidence|confirm_message|parseAssistText|operationTitle|intentCandidatesText/.test(sourceOf(node)));
  return { body: true, coreIndex, diagnosticIndex, questionIndex };
}

function sourceChecks(id, check) {
  const checks = [];
  const push = (code, pass, expected, actual) => checks.push(check(code, pass, expected, actual, 'STATIC_SOURCE'));
  const returnButton = buttonForHandler('returnToInput');
  const saveButton = buttonForHandler('saveFormal');
  const deepButton = buttonForHandler('requestDeepReview');
  const questionStructure = questionSurfaceStructure();

  if (id === 'SURFACE-001') {
    push('SURFACE001.CONFIRM_TITLE', /确认(?:订单|报价|收款|待收|待办)|\{\{[^}]*confirm[^}]*title[^}]*\}\}/i.test(WXML),
      '业务确认标题', WXML.match(/<view class="card-title">[^<]+<\/view>/)?.[0] || '');
    push('SURFACE001.NO_INTERNAL_DIAGNOSTIC_BINDINGS', diagnosticBindings().length === 0, [], diagnosticBindings());
    push('SURFACE001.CORE_FIELD_STRUCTURE', /客户/.test(WXML) && /商品/.test(WXML)
      && /交期/.test(WXML) && /金额|总价/.test(WXML) && Boolean(saveButton), true,
    { hasSave: Boolean(saveButton) });
  }

  if (['SURFACE-002', 'SURFACE-003', 'SURFACE-010'].includes(id)) {
    push(`${id.replace('-', '')}.QUESTION_SURFACE_STRUCTURE`, Object.values(questionStructure).every(Boolean),
      { answerAction: true, answerInput: true, container: true, prompt: true }, questionStructure);
  }

  if (id === 'SURFACE-004') {
    push('SURFACE004.AMOUNT_ERROR_STATE', hasAmountErrorState(), true, hasAmountErrorState());
    push('SURFACE004.AMOUNT_RISK_NEAR_FIELD', hasLocalRiskBinding('amount'), true, hasLocalRiskBinding('amount'));
    push('SURFACE004.CANONICAL_TOTAL_NEAR_AMOUNT', hasCanonicalTotalNearAmount(), true, hasCanonicalTotalNearAmount());
  }

  if (id === 'SURFACE-005') {
    const actual = {
      customerName: hasLocalRiskBinding('customerName'),
      dueDate: hasLocalRiskBinding('dueDate'),
      itemProductName: hasLocalRiskBinding('productName', true),
      itemQuantity: hasLocalRiskBinding('quantity', true)
    };
    push('SURFACE005.FIELD_RISKS_NEAR_TARGETS', Object.values(actual).every(Boolean),
      { customerName: true, dueDate: true, itemProductName: true, itemQuantity: true }, actual);
  }

  if (id === 'SURFACE-006') {
    push('SURFACE006.RETURN_BUTTON_EXISTS', Boolean(returnButton), true, Boolean(returnButton));
    push('SURFACE006.RETURN_BUTTON_TEXT', Boolean(returnButton)
      && ['重新输入原话', '返回重输'].includes(returnButton.text),
    '重新输入原话 或 返回重输', returnButton && returnButton.text || '');
    push('SURFACE006.NO_CONTINUE_EDIT', !elements('button').some((node) => node.text === '继续修改'), true,
      elements('button').filter((node) => node.text === '继续修改').map((node) => node.text));
  }

  if (id === 'SURFACE-007') {
    push('SURFACE007.TOGGLE_EXISTS', hasOriginalTextToggle(), true, hasOriginalTextToggle());
    push('SURFACE007.DEFAULT_COLLAPSE_GUARD', hasCollapsedOriginalTextGuard(), true, hasCollapsedOriginalTextGuard());
    push('SURFACE007.VIEW_ORIGINAL_COPY', /查看原话/.test(WXML), true, /查看原话/.test(WXML));
  }

  if (id === 'SURFACE-008') {
    push('SURFACE008.DEEP_ENTRY_NOT_UNCONDITIONAL', !deepButton
      || deepButton.attributes['wx:if'] === '{{showDeepReviewButton}}',
    'absent or controlled by showDeepReviewButton', deepButton ? {
      condition: deepButton.attributes['wx:if'] || '',
      text: deepButton.text
    } : 'absent');
  }

  if (id === 'SURFACE-009') {
    push('SURFACE009.NO_VISIBLE_DIAGNOSTIC_BINDINGS', diagnosticBindings().length === 0, [], diagnosticBindings());
    push('SURFACE009.NO_TECHNICAL_COPY', !/AI 回答|等待时间|本次核对编号|服务端|本地先整理成/.test(WXML), true,
      WXML.match(/AI 回答|等待时间|本次核对编号|服务端|本地先整理成/g) || []);
  }

  if (id === 'SURFACE-011') {
    push('SURFACE011.SAVE_BUTTON_BINDING', Boolean(saveButton)
      && saveButton.attributes.disabled === '{{disableFormalSave}}'
      && /formalButtonText/.test(saveButton.body), true, saveButton || null);
  }

  if (id === 'SURFACE-012') {
    const structure = primaryStructure();
    const fallback = safeBlockedSurfaceStructure();
    const primaryIndex = structure.questionIndex >= 0 ? structure.questionIndex : structure.coreIndex;
    push('SURFACE012.STATIC_PRIMARY_ORDER_PRECONDITION', structure.body && primaryIndex >= 0
      && (structure.diagnosticIndex < 0 || primaryIndex < structure.diagnosticIndex), true, structure);
    push('SURFACE012.SAFE_BLOCKED_SURFACE_STRUCTURE', fallback.action === true
      && fallback.container === true
      && fallback.message === true
      && Boolean(fallback.actionHandler),
    { action: true, actionHandler: 'callable Page method', container: true, message: true }, fallback);
  }

  return checks;
}

module.exports = {
  WXML_PATH,
  bindings,
  buttonForHandler,
  diagnosticBindings,
  globalRiskBlocks,
  questionUiContract,
  safeBlockedSurfaceStructure,
  sourceChecks,
  visibleGlobalRiskBlocks
};
