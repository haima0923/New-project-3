const BUSINESS_COLLECTIONS = Object.freeze({
  customers: 'customers',
  quotations: 'quotations',
  orders: 'orders',
  receivables: 'receivables',
  payments: 'paymentRecords',
  todos: 'todos',
  pendingNotes: 'pendingNotes'
});

const FULL_COLLECTIONS = Object.freeze(Object.assign({}, BUSINESS_COLLECTIONS, {
  orderProgress: 'orderProgress',
  aiParseLogs: 'aiParseLogs',
  operationLogs: 'operationLogs',
  productCatalog: 'productCatalog',
  dunningRecords: 'dunningRecords',
  deletedRecords: 'deletedRecords'
}));

const DEFAULT_DUNNING_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'polite', name: '客气提醒', content: '{customer}好，之前那笔{amount}的款这两天方便安排一下不？' }),
  Object.freeze({ id: 'direct', name: '直接催促', content: '{customer}，那笔{amount}的款已经到期了，麻烦尽快安排一下。' })
]);

function safeClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function stableSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function stableHash(value, prefix = 'rs1') {
  const text = stableSerialize(value);
  let fnv = 2166136261;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv ^= code;
    fnv = Math.imul(fnv, 16777619) >>> 0;
    djb = (((djb << 5) + djb) ^ code) >>> 0;
  }
  return `${prefix}_${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

function normalizeDomainState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? safeClone(input) : {};
  const state = Object.assign({}, source);
  state.meta = Object.assign({
    onboarded: false,
    industry: '',
    userId: 'local-user',
    createdAt: ''
  }, source.meta || {});
  Object.values(FULL_COLLECTIONS).forEach((collection) => {
    state[collection] = Array.isArray(source[collection]) ? source[collection] : [];
  });
  state.dunningTemplates = Array.isArray(source.dunningTemplates)
    ? source.dunningTemplates
    : safeClone(DEFAULT_DUNNING_TEMPLATES);
  return state;
}

function getStateFingerprint(state) {
  return stableHash(normalizeDomainState(state), 'state1');
}

function getRecordId(record, index) {
  if (record && record.id !== undefined && record.id !== null && String(record.id)) return String(record.id);
  return `__index__${index}`;
}

function collectChangedPaths(before, after, basePath = '') {
  if (stableSerialize(before) === stableSerialize(after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    const length = Math.max(left.length, right.length);
    const paths = [];
    for (let index = 0; index < length; index += 1) {
      const path = `${basePath}[${index}]`;
      if (index >= left.length || index >= right.length) paths.push(path);
      else paths.push(...collectChangedPaths(left[index], right[index], path));
    }
    return paths.length ? paths : [basePath || '$'];
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after)))).sort();
    const paths = [];
    keys.forEach((key) => {
      const path = basePath ? `${basePath}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(before, key)
        || !Object.prototype.hasOwnProperty.call(after, key)) paths.push(path);
      else paths.push(...collectChangedPaths(before[key], after[key], path));
    });
    return paths.length ? paths : [basePath || '$'];
  }
  return [basePath || '$'];
}

function diffCollection(beforeList = [], afterList = []) {
  const beforeMap = new Map(beforeList.map((item, index) => [getRecordId(item, index), item]));
  const afterMap = new Map(afterList.map((item, index) => [getRecordId(item, index), item]));
  const created = [];
  const updated = [];
  const deleted = [];

  Array.from(afterMap.keys()).sort().forEach((id) => {
    const after = afterMap.get(id);
    if (!beforeMap.has(id)) {
      created.push(safeClone(after));
      return;
    }
    const before = beforeMap.get(id);
    if (stableSerialize(before) !== stableSerialize(after)) {
      updated.push({
        id,
        before: safeClone(before),
        after: safeClone(after),
        changedFields: collectChangedPaths(before, after).sort()
      });
    }
  });
  Array.from(beforeMap.keys()).sort().forEach((id) => {
    if (!afterMap.has(id)) deleted.push(safeClone(beforeMap.get(id)));
  });

  const beforeOrder = beforeList.map(getRecordId);
  const afterOrder = afterList.map(getRecordId);
  return {
    created,
    updated,
    deleted,
    orderChanged: stableSerialize(beforeOrder) !== stableSerialize(afterOrder),
    beforeOrder,
    afterOrder
  };
}

function buildDiff(stateBefore, stateAfter, collections) {
  const before = normalizeDomainState(stateBefore);
  const after = normalizeDomainState(stateAfter);
  return Object.keys(collections).reduce((result, publicName) => {
    const stateName = collections[publicName];
    result[publicName] = diffCollection(before[stateName], after[stateName]);
    return result;
  }, {});
}

function buildSingletonDiff(id, beforeValue, afterValue) {
  return diffCollection(
    [{ id, value: safeClone(beforeValue) }],
    [{ id, value: safeClone(afterValue) }]
  );
}

function getExtraState(state) {
  const known = new Set(['meta', 'dunningTemplates'].concat(Object.values(FULL_COLLECTIONS)));
  return Object.keys(state).sort().reduce((result, key) => {
    if (!known.has(key)) result[key] = safeClone(state[key]);
    return result;
  }, {});
}

function createStateDiff(stateBefore, stateAfter) {
  const before = normalizeDomainState(stateBefore);
  const after = normalizeDomainState(stateAfter);
  const fullDiff = buildDiff(before, after, FULL_COLLECTIONS);
  fullDiff.meta = buildSingletonDiff('__meta__', before.meta, after.meta);
  fullDiff.dunningTemplates = diffCollection(before.dunningTemplates, after.dunningTemplates);
  fullDiff.extraState = buildSingletonDiff('__extra_state__', getExtraState(before), getExtraState(after));
  return {
    schemaVersion: 'record-state-diff-v1',
    businessDiff: buildDiff(before, after, BUSINESS_COLLECTIONS),
    fullDiff,
    stateChanged: !isCollectionDiffEmpty(fullDiff)
  };
}

function isCollectionDiffEmpty(diff = {}) {
  return Object.keys(diff).every((key) => {
    const entry = diff[key] || {};
    return !(entry.created || []).length
      && !(entry.updated || []).length
      && !(entry.deleted || []).length
      && entry.orderChanged !== true;
  });
}

function createEmptyStateDiff(state) {
  const snapshot = normalizeDomainState(state);
  return createStateDiff(snapshot, snapshot);
}

module.exports = {
  BUSINESS_COLLECTIONS,
  DEFAULT_DUNNING_TEMPLATES,
  FULL_COLLECTIONS,
  canonicalize,
  collectChangedPaths,
  createEmptyStateDiff,
  createStateDiff,
  getStateFingerprint,
  isCollectionDiffEmpty,
  normalizeDomainState,
  safeClone,
  stableHash,
  stableSerialize
};
