const {
  NODES,
  WXML_PATH,
  classTokens,
  contains,
  descendants,
  isEnabled,
  isVisible,
  lowestCommonAncestor,
  nearestConditionalAncestor,
  nodeSource,
  stripMustache
} = require('./wxml-tree');

function byClass(name) {
  return NODES.find((node) => classTokens(node).includes(name)) || null;
}

function byRole(role) {
  return NODES.find((node) => node.attributes['data-surface-role'] === role) || null;
}

function button(handler) {
  return NODES.find((node) => node.name === 'button' && node.attributes.bindtap === handler) || null;
}

function datasetFromAttributes(attributes = {}) {
  return Object.keys(attributes).filter((name) => name.startsWith('data-')).reduce((output, name) => {
    const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    output[key] = attributes[name];
    return output;
  }, {});
}

function businessTypeField() {
  return NODES.filter((node) => classTokens(node).includes('field'))
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
    .find((node) => />\s*业务类型\s*</.test(nodeSource(node))) || null;
}

function branchExpression(node) {
  if (!node) return '';
  return stripMustache(
    node.attributes['wx:if']
      ?? node.attributes['wx:elif']
      ?? ''
  );
}

function explicitConfirmingGuard(node) {
  let current = node;
  while (current) {
    if (current.attributes['wx:else'] !== undefined || current.attributes['wx:elif'] !== undefined) {
      return current;
    }
    const expression = branchExpression(current);
    if (/(?:conversation|confirm).*(?:phase|mode)|(?:phase|mode).*(?:confirm)/i.test(expression)) {
      return current;
    }
    if (/activeQuestion/.test(expression)
      && /(?:SAFE_BLOCKED|safeBlocked|assistantQuestionState)/.test(expression)
      && /(?:parsing|showParseProgress|AUTO_REVIEW|pendingReview)/.test(expression)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function siblingModeChain(nodes) {
  const branches = nodes.map(nearestConditionalAncestor);
  if (branches.some((node) => !node)) return { branches, valid: false };
  const parent = branches[0].parent;
  if (!parent || branches.some((node) => node.parent !== parent)) return { branches, valid: false };
  if (new Set(branches).size !== branches.length) return { branches, valid: false };
  const indices = branches.map((node) => parent.children.indexOf(node)).sort((a, b) => a - b);
  const consecutive = indices.every((value, index) => index === 0 || value === indices[index - 1] + 1);
  const ordered = indices.map((index) => parent.children[index]);
  const shape = ordered.length === branches.length
    && ordered[0].attributes['wx:if'] !== undefined
    && ordered.slice(1).every((node) => (
      node.attributes['wx:elif'] !== undefined || node.attributes['wx:else'] !== undefined
    ));
  return { branches, valid: consecutive && shape };
}

function questionUiContract() {
  const question = byRole('active-question') || byClass('assistant-question-card');
  const children = descendants(question);
  const input = children.find((node) => ['input', 'textarea'].includes(node.name)
    && Boolean(node.attributes.bindinput) && Boolean(node.attributes.value));
  const action = children.find((node) => node.name === 'button' && Boolean(node.attributes.bindtap));
  return {
    actionDataset: datasetFromAttributes(action && action.attributes),
    actionHandler: String(action && action.attributes.bindtap || ''),
    answerInputHandler: String(input && input.attributes.bindinput || ''),
    answerValueBinding: String(input && input.attributes.value || ''),
    condition: String(question && question.attributes['wx:if'] || ''),
    ready: Boolean(question && input && action && /activeQuestion\.prompt/.test(nodeSource(question)))
  };
}

function conversationWxmlContract() {
  const inputSurface = byClass('input-entry-card');
  const question = byRole('active-question') || byClass('assistant-question-card');
  const safeBlocked = byRole('safe-blocked') || byClass('safe-blocked-surface');
  const autoReview = byClass('parse-progress-card');
  const core = businessTypeField();
  const formalSave = button('saveFormal');
  const pendingSave = button('savePending');
  const confirmingCommonRoot = lowestCommonAncestor([core, formalSave].filter(Boolean));
  const confirmingRoot = explicitConfirmingGuard(confirmingCommonRoot);
  const questionChildren = descendants(question);
  const questionInput = questionChildren.find((node) => ['input', 'textarea'].includes(node.name)
    && Boolean(node.attributes.bindinput));
  const questionAction = questionChildren.find((node) => node.name === 'button'
    && Boolean(node.attributes.bindtap));
  const confirmingIsSeparate = Boolean(confirmingRoot)
    && !contains(confirmingRoot, question)
    && !contains(confirmingRoot, safeBlocked)
    && !contains(confirmingRoot, autoReview);
  const chain = siblingModeChain([inputSurface, autoReview, question, safeBlocked, confirmingRoot]);
  return {
    autoReview: Boolean(autoReview),
    confirmingCommonRootClass: String(confirmingCommonRoot && confirmingCommonRoot.attributes.class || ''),
    confirmingGuard: Boolean(confirmingRoot),
    confirmingIsSeparate,
    formalInsideConfirming: Boolean(confirmingRoot && contains(confirmingRoot, formalSave)),
    pendingInsideConfirming: !pendingSave || Boolean(confirmingRoot && contains(confirmingRoot, pendingSave)),
    questionAction: Boolean(questionAction),
    questionCondition: branchExpression(question),
    questionInput: Boolean(questionInput),
    questionPrompt: /activeQuestion\.prompt/.test(nodeSource(question)),
    safeBlocked: Boolean(safeBlocked),
    safeBlockedCondition: branchExpression(safeBlocked),
    topLevelMutualExclusion: Boolean(inputSurface && question && safeBlocked && autoReview && confirmingRoot
      && confirmingIsSeparate && chain.valid),
    wxmlPath: WXML_PATH
  };
}

function renderConversationSnapshot(data = {}) {
  const inputSurface = byClass('input-entry-card');
  const confirmModal = byClass('input-confirm-modal');
  const question = byRole('active-question') || byClass('assistant-question-card');
  const safeBlocked = byRole('safe-blocked') || byClass('safe-blocked-surface');
  const autoReview = byClass('parse-progress-card');
  const parseAction = button('runParse');
  const core = businessTypeField();
  const itemList = byClass('item-list-field');
  const amount = byRole('amount-field') || byClass('amount-field');
  const formalSave = button('saveFormal');
  const pendingSave = button('savePending');
  const questionChildren = descendants(question);
  const answerInput = questionChildren.find((node) => ['input', 'textarea'].includes(node.name)
    && Boolean(node.attributes.bindinput));
  const answerAction = questionChildren.find((node) => node.name === 'button'
    && Boolean(node.attributes.bindtap));
  const recoveryAction = safeBlocked && descendants(safeBlocked).find((node) => (
    node.name === 'button' && Boolean(node.attributes.bindtap)
  ));
  const coreNodes = [core, itemList, amount].filter(Boolean);
  const autoReviewVisible = isVisible(autoReview, data) || Boolean(
    isVisible(parseAction, data)
    && parseAction.attributes.loading !== undefined
    && !isEnabled(parseAction, data)
  );
  const modalVisible = isVisible(confirmModal, data);
  return {
    answerActionVisible: isVisible(answerAction, data),
    answerInputVisible: isVisible(answerInput, data),
    autoReviewVisible,
    clarifyingSurfaceVisible: isVisible(question, data),
    confirmingCoreVisible: coreNodes.some((node) => isVisible(node, data)),
    formalSaveEnabled: isEnabled(formalSave, data),
    formalSaveVisible: isVisible(formalSave, data),
    inputModeVisible: isVisible(inputSurface, data) && !modalVisible
      && isEnabled(parseAction, data) && !autoReviewVisible,
    pendingSaveVisible: isVisible(pendingSave, data),
    recoveryActionHandler: String(recoveryAction && recoveryAction.attributes.bindtap || ''),
    recoveryActionVisible: isVisible(recoveryAction, data),
    safeBlockedSurfaceVisible: isVisible(safeBlocked, data)
  };
}

module.exports = {
  conversationWxmlContract,
  questionUiContract,
  renderConversationSnapshot
};
