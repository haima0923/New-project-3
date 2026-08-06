function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, label, limit = 120) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return true;
    await tick();
  }
  const error = new Error(`Timed out while waiting for ${label}`);
  error.code = 'CONTRACT_WAIT_TIMEOUT';
  throw error;
}

function inputEvent(value) {
  return { detail: { value: String(value) } };
}

function fieldEvent(field, value) {
  return {
    currentTarget: { dataset: { field } },
    detail: { value: String(value) }
  };
}

async function submitOriginalText(page, text) {
  page.onTextInput(inputEvent(text));
  page.runParse();
  await waitForParseIdle(page);
}

async function startOriginalText(page, text) {
  page.onTextInput(inputEvent(text));
  page.runParse();
  await tick();
}

async function waitForParseIdle(page) {
  await waitUntil(() => page.data.parsing !== true, 'parse idle');
  await tick();
}

async function waitForAiRequests(network, expected) {
  await waitUntil(() => network.aiEvents().length >= expected, `${expected} AI request(s)`);
}

function questionState(page) {
  const question = page.data.activeQuestion || page.data.assistantQuestion || null;
  return {
    question,
    prompt: String(question && (question.prompt || question.text || question.message) || ''),
    status: String(page.data.assistantQuestionState
      || page.data.questionState
      || page.data.assistantState
      || (page.data.questionFlow && page.data.questionFlow.state)
      || ''),
    queueLength: Array.isArray(page.data.assistantQuestions) ? page.data.assistantQuestions.length : 0
  };
}

async function answerQuestion(page, value) {
  const state = questionState(page);
  const handler = page.answerAssistantQuestion
    || page.submitAssistantAnswer
    || page.onAssistantAnswer
    || page.handleAssistantAnswer;
  if (!state.question || typeof handler !== 'function') {
    return { supported: false, question: state.question };
  }
  const target = state.question.target || {};
  const dataset = {
    field: target.field || state.question.field || '',
    fieldPath: target.fieldPath || state.question.fieldPath || '',
    itemKey: target.itemKey || state.question.itemKey || '',
    questionId: state.question.questionId || state.question.id || '',
    revision: state.question.revision || state.question.draftRevision || '',
    originalTextFingerprint: state.question.originalTextFingerprint
      || state.question.original_text_fingerprint
      || state.question.fingerprint
      || ''
  };
  await Promise.resolve(handler.call(page, {
    currentTarget: { dataset },
    detail: {
      draftRevision: dataset.revision,
      originalTextFingerprint: dataset.originalTextFingerprint,
      questionId: dataset.questionId,
      target: {
        field: dataset.field,
        fieldPath: dataset.fieldPath,
        itemKey: dataset.itemKey
      },
      value: String(value)
    }
  }));
  await tick();
  return { supported: true, question: state.question };
}

function editField(page, field, value) {
  page.updateField(fieldEvent(field, value));
}

function visibleUserText(page) {
  const question = questionState(page);
  return [
    page.data.parseAssistText,
    page.data.warningMissingText,
    page.data.warningLowText,
    page.data.noRecordMessage,
    question.prompt,
    ...(page.data.domainBlockingLines || []),
    ...(page.data.fieldConflictLines || [])
  ].filter(Boolean).join('\n');
}

module.exports = {
  answerQuestion,
  editField,
  inputEvent,
  questionState,
  startOriginalText,
  submitOriginalText,
  tick,
  visibleUserText,
  waitForAiRequests,
  waitForParseIdle,
  waitUntil
};
