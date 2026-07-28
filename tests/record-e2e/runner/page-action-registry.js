const { safeClone } = require('../../../utils/record-state-diff');

const PAGE_ACTION_REGISTRY = Object.freeze({
  'FULL_PAGE|CREATE|SAVE_FORMAL': Object.freeze({
    methodName: 'saveFormal',
    semanticAction: 'SAVE_FORMAL'
  }),
  'FULL_PAGE|CREATE|SAVE_PENDING': Object.freeze({
    methodName: 'savePending',
    semanticAction: 'SAVE_PENDING'
  }),
  'FULL_PAGE|HISTORY_EDIT|UPDATE': Object.freeze({
    methodName: 'saveFormal',
    semanticAction: 'UPDATE'
  }),
  'FULL_PAGE|PENDING_EDIT|SAVE_FORMAL': Object.freeze({
    methodName: 'saveFormal',
    semanticAction: 'SAVE_FORMAL'
  }),
  'FULL_PAGE|PENDING_EDIT|SAVE_PENDING': Object.freeze({
    methodName: 'savePending',
    semanticAction: 'SAVE_PENDING'
  }),
  'HOME_QUICK|CREATE|SAVE_FORMAL': Object.freeze({
    methodName: 'confirmQuickSave',
    semanticAction: 'SAVE_FORMAL'
  }),
  'HOME_QUICK|CREATE|SAVE_PENDING': Object.freeze({
    methodName: 'savePendingFromConfirm',
    semanticAction: 'SAVE_PENDING'
  })
});

function actionError(failureCode, message, evidence = {}) {
  return Object.assign(new Error(message), {
    code: 'AUTOMATION_DRIVER_ERROR',
    failureCode,
    actionResolutionEvidence: evidence
  });
}

function deriveEditMode(inputChannel, explicitEditMode) {
  if (explicitEditMode) return explicitEditMode;
  if (inputChannel === 'PENDING_EDIT') return 'PENDING_EDIT';
  if (inputChannel === 'HISTORY_EDIT') return 'HISTORY_EDIT';
  return 'CREATE';
}

function normalizeRequestedAction(requestedAction, editMode) {
  if (editMode === 'HISTORY_EDIT' && requestedAction === 'SAVE_FORMAL') return 'UPDATE';
  return requestedAction;
}

function registryKey(entrySurface, editMode, requestedAction) {
  return `${entrySurface}|${editMode}|${requestedAction}`;
}

function lookupPageAction(options = {}) {
  const editMode = deriveEditMode(options.inputChannel, options.editMode);
  const requestedAction = normalizeRequestedAction(options.requestedAction, editMode);
  const key = registryKey(options.entrySurface, editMode, requestedAction);
  const entry = PAGE_ACTION_REGISTRY[key];
  const baseEvidence = {
    editMode,
    entrySurface: options.entrySurface || '',
    registryKey: key,
    requestedAction,
    requestedActionBeforeNormalization: options.requestedAction || ''
  };
  if (!entry) {
    throw actionError(
      'PAGE_ACTION_MAPPING_MISSING',
      `No registered page action for ${key}`,
      Object.assign(baseEvidence, {
        capabilityPresent: false,
        resolvedMethodName: ''
      })
    );
  }
  return {
    editMode,
    entry,
    key,
    requestedAction,
    resolutionEvidence: Object.assign(baseEvidence, {
      resolvedMethodName: entry.methodName,
      semanticAction: entry.semanticAction,
      source: 'CENTRAL_PAGE_ACTION_REGISTRY'
    })
  };
}

function resolvePageAction(options = {}) {
  const registered = lookupPageAction(options);
  const { entry } = registered;
  const page = options.availablePageMethods || {};
  const methodType = typeof page[entry.methodName];
  const resolutionEvidence = Object.assign({}, registered.resolutionEvidence, {
    capabilityPresent: methodType === 'function',
    methodType,
  });
  if (methodType !== 'function') {
    throw actionError(
      'PAGE_ACTION_METHOD_MISSING',
      `Registered production Page method is missing: ${entry.methodName}`,
      resolutionEvidence
    );
  }
  return {
    capabilityPresent: true,
    method: page[entry.methodName],
    resolvedMethodName: entry.methodName,
    resolutionEvidence
  };
}

function assertActionInvocation(resolution, invocationEvidence) {
  const valid = Boolean(
    resolution
    && invocationEvidence
    && invocationEvidence.attempted === true
    && invocationEvidence.completed === true
    && invocationEvidence.actualMethodName === resolution.resolvedMethodName
    && invocationEvidence.resolvedMethodName === resolution.resolvedMethodName
  );
  if (!valid) {
    throw actionError(
      'PAGE_ACTION_INVOCATION_MISMATCH',
      'Resolved page action was not the method that actually completed',
      {
        invocationEvidence: safeClone(invocationEvidence || {}),
        resolutionEvidence: safeClone(resolution && resolution.resolutionEvidence || {})
      }
    );
  }
  return true;
}

function invokeResolvedPageAction(page, resolution, options = {}) {
  if (!resolution || !resolution.resolvedMethodName) {
    throw actionError('PAGE_ACTION_MAPPING_MISSING', 'Page action resolution is missing');
  }
  if (!page || typeof page[resolution.resolvedMethodName] !== 'function') {
    throw actionError(
      'PAGE_ACTION_METHOD_MISSING',
      `Resolved Page method disappeared before invocation: ${resolution.resolvedMethodName}`,
      safeClone(resolution.resolutionEvidence)
    );
  }
  const invocationEvidence = {
    actualMethodName: resolution.resolvedMethodName,
    attempted: true,
    completed: false,
    resolvedMethodName: resolution.resolvedMethodName
  };
  if (typeof options.readMethodCount === 'function') {
    invocationEvidence.methodInvocationCountBefore = Number(options.readMethodCount() || 0);
  }
  const returnValue = page[resolution.resolvedMethodName]();
  invocationEvidence.completed = true;
  if (typeof options.readMethodCount === 'function') {
    invocationEvidence.methodInvocationCountAfter = Number(options.readMethodCount() || 0);
    invocationEvidence.methodInvocationDelta = (
      invocationEvidence.methodInvocationCountAfter
      - invocationEvidence.methodInvocationCountBefore
    );
    if (invocationEvidence.methodInvocationDelta !== 1) {
      throw actionError(
        'PAGE_ACTION_INVOCATION_MISMATCH',
        `Resolved Page method invocation count was ${invocationEvidence.methodInvocationDelta}, expected 1`,
        {
          invocationEvidence: safeClone(invocationEvidence),
          resolutionEvidence: safeClone(resolution.resolutionEvidence)
        }
      );
    }
  }
  assertActionInvocation(resolution, invocationEvidence);
  return {
    invocationEvidence,
    returnValue
  };
}

module.exports = {
  PAGE_ACTION_REGISTRY,
  actionError,
  assertActionInvocation,
  deriveEditMode,
  invokeResolvedPageAction,
  lookupPageAction,
  normalizeRequestedAction,
  registryKey,
  resolvePageAction
};
