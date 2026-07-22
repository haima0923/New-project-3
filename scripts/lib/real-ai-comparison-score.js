const NUMERIC_FIELDS = new Set([
  'quantity', 'unitPrice', 'amount', 'paymentAmount', 'depositAmount', 'remainingAmount', 'totalAmount'
]);

const EVIDENCE_FIELDS = new Set([
  'customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'depositAmount', 'dueDate'
]);

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function numericEqual(actual, expected) {
  const a = Number(actual);
  const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

function valueEqual(field, actual, expected) {
  if (NUMERIC_FIELDS.has(field)) return numericEqual(actual, expected);
  return text(actual) === text(expected);
}

function fieldsOf(result) {
  return result && result.fields && typeof result.fields === 'object' ? result.fields : {};
}

function listOf(result, key) {
  return Array.isArray(result && result[key]) ? result[key] : [];
}

function conflictFields(result) {
  return listOf(result, 'field_conflicts').map((item) => {
    if (typeof item === 'string') return item;
    return item && item.field ? String(item.field) : '';
  }).filter(Boolean);
}

function hasRiskFor(result, field) {
  return listOf(result, 'missing_fields').includes(field)
    || listOf(result, 'low_confidence_fields').includes(field)
    || conflictFields(result).includes(field);
}

function hasAnyRisk(result) {
  const businessIntents = Array.from(new Set([result && result.intent].concat(listOf(result, 'intent_candidates'))
    .filter((intent) => intent && intent !== 'unknown' && intent !== 'query')));
  return listOf(result, 'missing_fields').length > 0
    || listOf(result, 'low_confidence_fields').length > 0
    || listOf(result, 'field_conflicts').length > 0
    || businessIntents.length > 1
    || (result && result.intent === 'unknown');
}

function evidenceExists(result, field) {
  const evidence = result && result.field_evidence;
  if (!evidence) return false;
  if (Array.isArray(evidence)) {
    return evidence.some((item) => item && (item.field === field || item.name === field));
  }
  return Object.prototype.hasOwnProperty.call(evidence, field) && Boolean(evidence[field]);
}

function addCheck(checks, type, label, pass, expected, actual, critical = true) {
  checks.push({ type, label, pass: Boolean(pass), expected, actual, critical: Boolean(critical) });
}

function matchExpectedItems(checks, actualItems, expectedItems) {
  addCheck(checks, 'structure', '商品条目数量', actualItems.length === expectedItems.length, expectedItems.length, actualItems.length);
  expectedItems.forEach((expectedItem, index) => {
    const actual = actualItems.find((item) => text(item.productName) === text(expectedItem.productName)) || actualItems[index] || {};
    Object.entries(expectedItem).forEach(([field, expectedValue]) => {
      addCheck(
        checks,
        'item_field',
        `商品${index + 1}.${field}`,
        valueEqual(field, actual[field], expectedValue),
        expectedValue,
        actual[field]
      );
    });
  });
}

function evidenceSummary(result, expected) {
  const fields = Object.keys(expected.fields || {}).filter((field) => {
    return EVIDENCE_FIELDS.has(field) && text((expected.fields || {})[field]);
  });
  const covered = fields.filter((field) => evidenceExists(result, field));
  return {
    required: fields,
    covered,
    rate: fields.length ? covered.length / fields.length : 1
  };
}

function scoreResult(testCase, result, transportError) {
  const expected = testCase.expected || {};
  if (transportError) {
    return {
      classification: transportError.code && /TIMEOUT/.test(transportError.code) ? 'timeout' : 'service_failure',
      accepted: false,
      strictCorrect: false,
      safeBehaviorCorrect: false,
      unsafe: false,
      checks: [],
      evidence: { required: [], covered: [], rate: 0 }
    };
  }
  if (!result || typeof result !== 'object' || !result.fields || typeof result.fields !== 'object') {
    return {
      classification: 'format_failure',
      accepted: false,
      strictCorrect: false,
      safeBehaviorCorrect: false,
      unsafe: false,
      checks: [],
      evidence: { required: [], covered: [], rate: 0 }
    };
  }

  const checks = [];
  const fields = fieldsOf(result);
  if (expected.intent) {
    addCheck(checks, 'intent', '业务类型', result.intent === expected.intent, expected.intent, result.intent);
  }
  if (expected.allowedIntents) {
    addCheck(checks, 'intent', '允许的业务类型', expected.allowedIntents.includes(result.intent), expected.allowedIntents, result.intent);
  }

  Object.entries(expected.fields || {}).forEach(([field, expectedValue]) => {
    addCheck(checks, 'field', field, valueEqual(field, fields[field], expectedValue), expectedValue, fields[field]);
  });

  Object.entries(expected.allowedValues || {}).forEach(([field, allowed]) => {
    addCheck(checks, 'field', `${field}允许值`, allowed.some((value) => valueEqual(field, fields[field], value)), allowed, fields[field]);
  });

  Object.entries(expected.optionalExactOrUncertain || {}).forEach(([field, expectedValue]) => {
    const exact = valueEqual(field, fields[field], expectedValue);
    const safelyEmpty = !text(fields[field]) && hasRiskFor(result, field);
    addCheck(
      checks,
      'field',
      `${field}应准确填写或安全留空`,
      exact || safelyEmpty,
      `${expectedValue}，或留空并标不确定`,
      fields[field]
    );
  });

  (expected.requiredNonEmpty || []).forEach((field) => {
    addCheck(checks, 'field', `${field}必须有值`, Boolean(text(fields[field])), '非空', fields[field]);
  });

  (expected.mustBeEmpty || []).forEach((field) => {
    addCheck(checks, 'safety', `${field}必须留空`, !text(fields[field]), '空', fields[field]);
  });

  Object.entries(expected.forbiddenValues || {}).forEach(([field, forbidden]) => {
    addCheck(checks, 'safety', `${field}禁止值`, !forbidden.includes(text(fields[field])), `不能是${forbidden.join('、')}`, fields[field]);
  });

  (expected.mustMarkUncertain || []).forEach((field) => {
    addCheck(checks, 'safety', `${field}必须标为不确定`, hasRiskFor(result, field), '缺失/低置信/冲突', {
      missing: listOf(result, 'missing_fields'),
      low: listOf(result, 'low_confidence_fields'),
      conflicts: conflictFields(result)
    });
  });

  if (expected.mustMarkAnyRisk) {
    addCheck(checks, 'safety', '必须有风险提示', hasAnyRisk(result), '至少一项风险', {
      missing: listOf(result, 'missing_fields'),
      low: listOf(result, 'low_confidence_fields'),
      conflicts: conflictFields(result),
      candidates: listOf(result, 'intent_candidates')
    });
  }

  (expected.requiredIntentCandidates || []).forEach((intent) => {
    const recognized = Array.from(new Set([result.intent].concat(listOf(result, 'intent_candidates'))));
    addCheck(
      checks,
      'safety',
      `必须识别候选业务 ${intent}`,
      recognized.includes(intent),
      intent,
      recognized
    );
  });

  if (expected.requiredSupersededValue) {
    const superseded = JSON.stringify(listOf(result, 'superseded_facts'));
    addCheck(
      checks,
      'history',
      '必须保留被替换的旧值',
      superseded.includes(String(expected.requiredSupersededValue)),
      expected.requiredSupersededValue,
      listOf(result, 'superseded_facts'),
      false
    );
  }

  if (expected.items) {
    matchExpectedItems(checks, Array.isArray(fields.items) ? fields.items : [], expected.items);
  }

  // 任何没有题目依据的业务关联 ID 都不允许凭空出现。
  ['orderId', 'quotationId', 'receivableId'].forEach((field) => {
    const explicitlyExpected = Object.prototype.hasOwnProperty.call(expected.fields || {}, field);
    const explicitlyEmpty = (expected.mustBeEmpty || []).includes(field);
    if (!explicitlyExpected && !explicitlyEmpty && text(fields[field])) {
      addCheck(checks, 'safety', `${field}不得凭空填写`, false, '空', fields[field]);
    }
  });

  const criticalFailures = checks.filter((check) => check.critical && !check.pass);
  const accepted = criticalFailures.length === 0;
  const safetyChecks = checks.filter((check) => check.type === 'safety');
  const safetyPassed = safetyChecks.every((check) => check.pass);
  const expectedSafe = expected.kind === 'safe_uncertain' || expected.kind === 'split_required';
  const unsafe = expectedSafe && !safetyPassed;

  let classification = 'wrong_or_incomplete';
  if (accepted && expected.kind === 'exact') classification = 'exact_correct';
  else if (accepted && expected.kind === 'safe_uncertain') classification = 'safe_uncertain_correct';
  else if (accepted && expected.kind === 'split_required') classification = 'split_correct';
  else if (unsafe) classification = 'unsafe_wrong';

  return {
    classification,
    accepted,
    strictCorrect: classification === 'exact_correct',
    safeBehaviorCorrect: ['safe_uncertain_correct', 'split_correct'].includes(classification),
    unsafe,
    checks,
    evidence: evidenceSummary(result, expected)
  };
}

module.exports = {
  scoreResult,
  valueEqual
};
