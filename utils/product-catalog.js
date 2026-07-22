const { generateId } = require('./storage');
const { normalizeUnit } = require('./units');

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function cleanText(value) {
  return String(value || '').trim();
}

function uniqueTexts(values) {
  return (values || []).map(cleanText).filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);
}

function getCatalogList(state) {
  return Array.isArray(state.productCatalog) ? state.productCatalog : [];
}

function findCatalogItem(catalog, productName) {
  const key = normalizeName(productName);
  if (!key) return null;
  return (catalog || []).find((item) => item.normalizedName === key || normalizeName(item.productName) === key) || null;
}

function getRecordItems(record = {}) {
  const items = Array.isArray(record.items) ? record.items.filter((item) => item && typeof item === 'object') : [];
  if (items.length) return items;
  if (!record.productName && !record.spec && !record.quantity && !record.unitPrice) return [];
  return [{
    productName: record.productName || '',
    spec: record.spec || '',
    quantity: record.quantity || '',
    unit: record.unit || '',
    unitPrice: record.unitPrice || '',
    priceUnit: record.priceUnit || ''
  }];
}

function normalizeSpecEntries(specs) {
  return (specs || []).map((spec) => {
    if (typeof spec === 'string') return { name: cleanText(spec), useCount: 0, lastUsedAt: '' };
    return {
      name: cleanText(spec.name || spec.spec),
      useCount: Number(spec.useCount || 0),
      lastUsedAt: spec.lastUsedAt || ''
    };
  }).filter((item) => item.name);
}

function mergeSpec(item, specName, usedAt, incrementUse) {
  const name = cleanText(specName);
  if (!name) return;
  item.specs = normalizeSpecEntries(item.specs);
  let spec = item.specs.find((entry) => normalizeName(entry.name) === normalizeName(name));
  if (!spec) {
    spec = { name, useCount: 0, lastUsedAt: '' };
    item.specs.push(spec);
  }
  if (incrementUse) spec.useCount += 1;
  if (usedAt) spec.lastUsedAt = usedAt;
  item.specs.sort((left, right) => right.useCount - left.useCount || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)));
}

function upsertCatalogItem(state, data = {}, options = {}) {
  if (!Array.isArray(state.productCatalog)) state.productCatalog = [];
  const productName = cleanText(data.productName);
  if (!productName) return null;
  const now = data.lastUsedAt || new Date().toISOString();
  let item = findCatalogItem(state.productCatalog, productName);
  if (!item) {
    item = {
      id: generateId('product'),
      userId: (state.meta && state.meta.userId) || 'local-user',
      productName,
      normalizedName: normalizeName(productName),
      specs: [],
      units: [],
      priceUnits: [],
      lastUnitPrice: '',
      useCount: 0,
      sourceTypes: [],
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    };
    state.productCatalog.push(item);
  }
  item.productName = productName;
  item.normalizedName = normalizeName(productName);
  const specs = uniqueTexts([].concat(data.specs || [], data.spec || []));
  specs.forEach((spec) => mergeSpec(item, spec, now, options.incrementUse !== false));
  item.units = uniqueTexts([].concat(item.units || [], normalizeUnit(data.unit || ''), (data.units || []).map(normalizeUnit)));
  item.priceUnits = uniqueTexts([].concat(item.priceUnits || [], normalizeUnit(data.priceUnit || ''), (data.priceUnits || []).map(normalizeUnit)));
  if (data.unitPrice !== undefined && data.unitPrice !== null && data.unitPrice !== '') item.lastUnitPrice = String(data.unitPrice);
  if (data.sourceType) item.sourceTypes = uniqueTexts([].concat(item.sourceTypes || [], data.sourceType));
  if (options.incrementUse !== false) item.useCount = Number(item.useCount || 0) + 1;
  item.lastUsedAt = now;
  item.updatedAt = new Date().toISOString();
  state.productCatalog.sort((left, right) => Number(right.useCount || 0) - Number(left.useCount || 0)
    || String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || '')));
  return item;
}

function learnProductCatalogFromRecord(state, record, sourceType, options = {}) {
  if (!record) return [];
  if (!options.skipEnsure) ensureProductCatalog(state);
  const usedAt = record.updatedAt || record.createdAt || new Date().toISOString();
  return getRecordItems(record).map((item) => upsertCatalogItem(state, {
    productName: item.productName,
    spec: item.spec,
    unit: item.unit,
    priceUnit: item.priceUnit,
    unitPrice: item.unitPrice,
    sourceType,
    lastUsedAt: usedAt
  }, {
    incrementUse: options.incrementUse !== false
  })).filter(Boolean);
}

function ensureProductCatalog(state) {
  if (Array.isArray(state.productCatalog)) return state.productCatalog;
  state.productCatalog = [];
  const history = []
    .concat((state.quotations || []).map((record) => ({ record, sourceType: 'quotation' })))
    .concat((state.orders || []).map((record) => ({ record, sourceType: 'order' })))
    .sort((left, right) => String(left.record.createdAt || left.record.updatedAt || '').localeCompare(String(right.record.createdAt || right.record.updatedAt || '')));
  history.forEach((entry) => learnProductCatalogFromRecord(state, entry.record, entry.sourceType, { skipEnsure: true }));
  return state.productCatalog;
}

function getProductCatalog(state) {
  if (Array.isArray(state.productCatalog)) return state.productCatalog;
  const temporaryState = Object.assign({}, state, { productCatalog: [] });
  const history = []
    .concat((state.quotations || []).map((record) => ({ record, sourceType: 'quotation' })))
    .concat((state.orders || []).map((record) => ({ record, sourceType: 'order' })));
  history.forEach((entry) => learnProductCatalogFromRecord(temporaryState, entry.record, entry.sourceType, { skipEnsure: true }));
  return temporaryState.productCatalog;
}

function getProductSuggestions(state, keyword = '', limit = 6) {
  const source = normalizeName(keyword);
  return getProductCatalog(state)
    .filter((item) => !source || item.normalizedName.includes(source) || source.includes(item.normalizedName))
    .slice(0, limit)
    .map((item) => item.productName);
}

function getSpecSuggestions(state, productName, keyword = '', limit = 8) {
  const item = findCatalogItem(getProductCatalog(state), productName);
  if (!item) return [];
  const source = normalizeName(keyword);
  const specs = normalizeSpecEntries(item.specs);
  const matched = source ? specs.filter((spec) => normalizeName(spec.name).includes(source)) : specs;
  return matched.slice(0, limit).map((spec) => spec.name);
}

function getCatalogCheck(state, productName, specName) {
  const item = findCatalogItem(getProductCatalog(state), productName);
  if (!cleanText(productName)) {
    return { status: 'empty', hint: '可从商品规格库选择常用商品。', item: null };
  }
  if (!item) {
    return { status: 'new_product', hint: '商品库里还没有这个商品；确认保存后会自动记住。', item: null };
  }
  const spec = cleanText(specName);
  if (!spec) {
    return {
      status: 'known_product',
      hint: item.specs && item.specs.length ? `商品库里有 ${item.specs.length} 个常用规格，请核对或直接输入。` : '已在商品库找到这个商品。',
      item
    };
  }
  const knownSpec = normalizeSpecEntries(item.specs).some((entry) => normalizeName(entry.name) === normalizeName(spec));
  return {
    status: knownSpec ? 'known_spec' : 'new_spec',
    hint: knownSpec ? '商品和规格已在本地商品库核对。' : '这是商品库里未记录的新规格；确认保存后会自动记住。',
    item
  };
}

function saveManualCatalogItem(state, data = {}) {
  ensureProductCatalog(state);
  const existing = data.id ? state.productCatalog.find((item) => item.id === data.id) : null;
  if (existing && normalizeName(existing.productName) !== normalizeName(data.productName)) {
    existing.productName = cleanText(data.productName);
    existing.normalizedName = normalizeName(data.productName);
  }
  const item = existing || upsertCatalogItem(state, data, { incrementUse: false });
  if (!item) return null;
  const specs = uniqueTexts(data.specs || []);
  item.specs = specs.map((name) => {
    const previous = normalizeSpecEntries(item.specs).find((entry) => normalizeName(entry.name) === normalizeName(name));
    return previous || { name, useCount: 0, lastUsedAt: '' };
  });
  item.units = uniqueTexts(data.units || []);
  item.priceUnits = uniqueTexts(data.priceUnits || []);
  item.updatedAt = new Date().toISOString();
  return item;
}

function removeCatalogItem(state, id) {
  ensureProductCatalog(state);
  const index = state.productCatalog.findIndex((item) => item.id === id);
  if (index < 0) return null;
  return state.productCatalog.splice(index, 1)[0];
}

module.exports = {
  ensureProductCatalog,
  findCatalogItem,
  getCatalogCheck,
  getProductCatalog,
  getProductSuggestions,
  getSpecSuggestions,
  learnProductCatalogFromRecord,
  normalizeName,
  removeCatalogItem,
  saveManualCatalogItem,
  upsertCatalogItem
};
