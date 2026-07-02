const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    args[item.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split('|').map((item) => item.trim()).filter(Boolean);
  return [];
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function sameNumber(actual, expected) {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.0001;
}

function findProviderOutput(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"intent"') && trimmed.includes('"fields"')) return trimmed;
    return '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  for (const key of ['output', 'content', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findProviderOutput(value[key], seen, depth + 1);
      if (found) return found;
    }
  }

  for (const child of Object.values(value)) {
    const found = findProviderOutput(child, seen, depth + 1);
    if (found) return found;
  }
  return '';
}

function parseOutput(raw) {
  if (!raw) return { payload: null, error: '没有找到接口返回' };
  try {
    return { payload: JSON.parse(raw), error: '' };
  } catch (error) {
    return { payload: null, error: `接口返回不是 JSON: ${error.message}` };
  }
}

function getGradingReason(result) {
  const grading = result && result.gradingResult;
  if (!grading) return '';
  if (typeof grading.reason === 'string' && grading.reason.trim()) return grading.reason.trim();
  return ensureArray(grading.componentResults)
    .map((item) => item && item.reason)
    .filter(Boolean)
    .join('；');
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0];
}

function fieldIncludes(fields, key, expected) {
  if (!hasValue(expected)) return true;
  return String(fields[key] || '').includes(String(expected));
}

function checkCase(vars, payload) {
  const errors = [];
  const fields = payload && payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const expectedIntents = list(vars.expectedIntent);
  if (expectedIntents.length && !expectedIntents.includes(payload.intent)) {
    errors.push(`意图应为 ${expectedIntents.join('/')}，实际为 ${payload.intent || '空'}`);
  }
  if (hasValue(vars.expectedOperation) && payload.operation !== vars.expectedOperation) {
    errors.push(`操作应为 ${vars.expectedOperation}，实际为 ${payload.operation || '空'}`);
  }

  [
    ['customerName', 'expectedCustomer', '客户'],
    ['productName', 'expectedProduct', '商品'],
    ['todoTitle', 'expectedTodoTitle', '待办标题'],
  ].forEach(([field, expectedKey, label]) => {
    if (!fieldIncludes(fields, field, vars[expectedKey])) {
      errors.push(`${label}应包含 ${vars[expectedKey]}，实际为 ${fields[field] || '空'}`);
    }
  });

  [
    ['quantity', 'expectedQuantity', '数量'],
    ['unitPrice', 'expectedUnitPrice', '单价'],
    ['amount', 'expectedAmount', '金额'],
    ['paymentAmount', 'expectedPaymentAmount', '本次收款'],
    ['remainingAmount', 'expectedRemainingAmount', '剩余金额'],
  ].forEach(([field, expectedKey, label]) => {
    if (hasValue(vars[expectedKey]) && !sameNumber(fields[field], vars[expectedKey])) {
      errors.push(`${label}应为 ${vars[expectedKey]}，实际为 ${fields[field] || '空'}`);
    }
  });

  if (vars.requireDueDate === true && !hasValue(fields.dueDate)) {
    errors.push('应识别日期/交期/提醒日期，但 dueDate 为空');
  }
  if (hasValue(vars.expectedDueDate) && fields.dueDate !== vars.expectedDueDate) {
    errors.push(`日期应为 ${vars.expectedDueDate}，实际为 ${fields.dueDate || '空'}`);
  }

  const missingFields = ensureArray(payload.missing_fields);
  const lowFields = ensureArray(payload.low_confidence_fields);
  list(vars.expectedMissingIncludes).forEach((field) => {
    if (!missingFields.includes(field)) errors.push(`missing_fields 应包含 ${field}`);
  });
  list(vars.expectedLowIncludes).forEach((field) => {
    if (!lowFields.includes(field)) errors.push(`low_confidence_fields 应包含 ${field}`);
  });

  return errors;
}

function expectedSummary(vars) {
  const parts = [];
  if (vars.expectedIntent) parts.push(`意图=${vars.expectedIntent}`);
  if (vars.expectedOperation) parts.push(`操作=${vars.expectedOperation}`);
  if (vars.expectedCustomer) parts.push(`客户=${vars.expectedCustomer}`);
  if (vars.expectedProduct) parts.push(`商品=${vars.expectedProduct}`);
  if (vars.expectedQuantity) parts.push(`数量=${vars.expectedQuantity}`);
  if (vars.expectedUnitPrice) parts.push(`单价=${vars.expectedUnitPrice}`);
  if (vars.expectedAmount) parts.push(`金额=${vars.expectedAmount}`);
  if (vars.expectedPaymentAmount) parts.push(`收款=${vars.expectedPaymentAmount}`);
  if (vars.expectedRemainingAmount) parts.push(`剩余=${vars.expectedRemainingAmount}`);
  if (vars.requireDueDate) parts.push('需要日期');
  if (vars.expectedMissingIncludes) parts.push(`应缺字段=${vars.expectedMissingIncludes}`);
  if (vars.expectedLowIncludes) parts.push(`低置信=${vars.expectedLowIncludes}`);
  return parts.join('；');
}

function stringifyPayload(payload) {
  if (!payload) return '';
  return JSON.stringify(payload, null, 2);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csvCell(value) {
  const text = String(value || '').replace(/\r?\n/g, '\n');
  return `"${text.replace(/"/g, '""')}"`;
}

function buildRows(cases, results) {
  const resultByIndex = new Map();
  results.forEach((result) => {
    if (typeof result.testIdx === 'number') resultByIndex.set(result.testIdx, result);
  });

  return cases.map((testCase, index) => {
    const result = resultByIndex.get(index);
    const vars = Object.assign({}, testCase.vars || {}, result && result.testCase ? result.testCase.vars || {} : {});
    const rawOutput = findProviderOutput(result);
    const parsed = parseOutput(rawOutput);
    const fields = parsed.payload && parsed.payload.fields ? parsed.payload.fields : {};
    const reasons = [];

    let status = '通过';
    if (!result) {
      status = '异常';
      reasons.push('Promptfoo 没有返回这条用例的结果');
    } else if (result.error && !rawOutput) {
      status = '异常';
      reasons.push(firstLine(result.error));
    } else if (parsed.error) {
      status = '异常';
      reasons.push(parsed.error);
    } else {
      const checkErrors = checkCase(vars, parsed.payload);
      if (result.success === false || checkErrors.length) {
        status = '失败';
        reasons.push(...checkErrors);
      }
    }

    if (status !== '通过') {
      const gradingReason = getGradingReason(result);
      if (gradingReason && !reasons.includes(gradingReason)) reasons.push(gradingReason);
    }

    return {
      index: index + 1,
      category: vars.category || testCase.metadata?.category || '',
      question: vars.question || '',
      status,
      reason: reasons.join('；') || '通过',
      expected: expectedSummary(vars),
      actualIntent: parsed.payload ? parsed.payload.intent || '' : '',
      actualOperation: parsed.payload ? parsed.payload.operation || '' : '',
      customerName: fields.customerName || '',
      productName: fields.productName || '',
      quantity: fields.quantity || '',
      unitPrice: fields.unitPrice || '',
      amount: fields.amount || '',
      paymentAmount: fields.paymentAmount || '',
      remainingAmount: fields.remainingAmount || '',
      dueDate: fields.dueDate || '',
      missingFields: ensureArray(parsed.payload && parsed.payload.missing_fields).join('、'),
      lowConfidenceFields: ensureArray(parsed.payload && parsed.payload.low_confidence_fields).join('、'),
      notes: vars.notes || '',
      raw: stringifyPayload(parsed.payload),
    };
  });
}

function writeCsv(rows, outputFile) {
  const headers = [
    '序号',
    '分类',
    '老板原话',
    '测试结果',
    '失败原因',
    '期望识别重点',
    '实际意图',
    '实际操作',
    '识别客户',
    '识别商品',
    '数量',
    '单价',
    '金额',
    '本次收款',
    '剩余金额',
    '日期',
    '缺失字段',
    '低置信字段',
    '备注',
    '接口原始回答',
  ];
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => [
      row.index,
      row.category,
      row.question,
      row.status,
      row.reason,
      row.expected,
      row.actualIntent,
      row.actualOperation,
      row.customerName,
      row.productName,
      row.quantity,
      row.unitPrice,
      row.amount,
      row.paymentAmount,
      row.remainingAmount,
      row.dueDate,
      row.missingFields,
      row.lowConfidenceFields,
      row.notes,
      row.raw,
    ].map(csvCell).join(',')),
  ];
  fs.writeFileSync(outputFile, `\uFEFF${lines.join('\r\n')}`, 'utf8');
}

function writeHtml(rows, outputFile, sourceJson) {
  const total = rows.length;
  const passed = rows.filter((row) => row.status === '通过').length;
  const failed = rows.filter((row) => row.status === '失败').length;
  const errors = rows.filter((row) => row.status === '异常').length;
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const body = rows.map((row) => {
    const className = row.status === '通过' ? 'pass' : row.status === '失败' ? 'fail' : 'error';
    return `<tr class="${className}">
      <td>${row.index}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.question)}</td>
      <td><span class="badge ${className}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.reason)}</td>
      <td>${escapeHtml(row.expected)}</td>
      <td>${escapeHtml(row.actualIntent)}</td>
      <td>${escapeHtml(row.actualOperation)}</td>
      <td>${escapeHtml(row.customerName)}</td>
      <td>${escapeHtml(row.productName)}</td>
      <td>${escapeHtml(row.quantity)}</td>
      <td>${escapeHtml(row.unitPrice)}</td>
      <td>${escapeHtml(row.amount)}</td>
      <td>${escapeHtml(row.paymentAmount)}</td>
      <td>${escapeHtml(row.remainingAmount)}</td>
      <td>${escapeHtml(row.dueDate)}</td>
      <td>${escapeHtml(row.missingFields)}</td>
      <td>${escapeHtml(row.lowConfidenceFields)}</td>
      <td>${escapeHtml(row.notes)}</td>
      <td><pre>${escapeHtml(row.raw)}</pre></td>
    </tr>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>记一笔 Promptfoo 100 问测试报告</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; color: #172033; background: #f7f8fb; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0; }
    .card { background: #fff; border: 1px solid #dde3ee; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
    .card strong { display: block; font-size: 24px; margin-bottom: 2px; }
    .pass-text { color: #067a46; }
    .fail-text, .error-text { color: #b42318; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde3ee; }
    th, td { border-bottom: 1px solid #e6eaf1; padding: 10px; text-align: left; vertical-align: top; font-size: 13px; }
    th { position: sticky; top: 0; background: #eef3fb; z-index: 1; }
    tr.fail, tr.error { background: #fff1f0; }
    tr.pass { background: #fbfffd; }
    .badge { display: inline-block; border-radius: 999px; padding: 3px 9px; font-weight: 700; white-space: nowrap; }
    .badge.pass { color: #067a46; background: #e8f7ef; }
    .badge.fail, .badge.error { color: #b42318; background: #fee4e2; }
    pre { margin: 0; white-space: pre-wrap; font-family: Consolas, "Microsoft YaHei", monospace; max-width: 520px; }
    .meta { color: #667085; font-size: 13px; }
  </style>
</head>
<body>
  <h1>记一笔 Promptfoo 100 问测试报告</h1>
  <div class="meta">生成时间：${escapeHtml(generatedAt)}。原始结果：${escapeHtml(path.basename(sourceJson))}</div>
  <div class="summary">
    <div class="card"><strong>${total}</strong>总题数</div>
    <div class="card pass-text"><strong>${passed}</strong>通过</div>
    <div class="card fail-text"><strong>${failed}</strong>失败</div>
    <div class="card error-text"><strong>${errors}</strong>异常</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>序号</th>
        <th>分类</th>
        <th>老板原话</th>
        <th>测试结果</th>
        <th>失败原因</th>
        <th>期望识别重点</th>
        <th>实际意图</th>
        <th>实际操作</th>
        <th>识别客户</th>
        <th>识别商品</th>
        <th>数量</th>
        <th>单价</th>
        <th>金额</th>
        <th>本次收款</th>
        <th>剩余金额</th>
        <th>日期</th>
        <th>缺失字段</th>
        <th>低置信字段</th>
        <th>备注</th>
        <th>接口原始回答</th>
      </tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>
</body>
</html>`;
  fs.writeFileSync(outputFile, html, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const casesPath = args.cases;
  const outDir = args['out-dir'];
  if (!input || !casesPath || !outDir) {
    throw new Error('Usage: node scripts/build-promptfoo-record-report.js --input <record-results.json> --cases <record-cases.json> --out-dir <reports-dir>');
  }

  const raw = readJson(input);
  const cases = readJson(casesPath);
  const results = ensureArray(raw.results && raw.results.results);
  const rows = buildRows(cases, results);

  fs.mkdirSync(outDir, { recursive: true });
  const csvFile = path.join(outDir, 'record-report.csv');
  let actualCsvFile = csvFile;
  try {
    writeCsv(rows, csvFile);
  } catch (error) {
    if (error && error.code !== 'EBUSY') throw error;
    actualCsvFile = path.join(outDir, `record-report-${Date.now()}.csv`);
    writeCsv(rows, actualCsvFile);
  }
  writeHtml(rows, path.join(outDir, 'record-report.html'), input);

  const failed = rows.filter((row) => row.status !== '通过').length;
  console.log(`中文报告已生成：${path.join(outDir, 'record-report.html')}`);
  console.log(`CSV 明细已生成：${actualCsvFile}`);
  console.log(`共 ${rows.length} 条，${rows.length - failed} 条通过，${failed} 条需要检查。`);
}

main();
