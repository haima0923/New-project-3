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

function findProviderOutput(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"title"') && trimmed.includes('"lines"')) {
      return trimmed;
    }
    return '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  const preferredKeys = ['output', 'content', 'text'];
  for (const key of preferredKeys) {
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
  const componentReasons = ensureArray(grading.componentResults)
    .map((item) => item && item.reason)
    .filter(Boolean);
  return componentReasons.join('；');
}

function buildAnswerText(payload) {
  if (!payload) return '';
  const lines = ensureArray(payload.lines);
  return [payload.title || '', ...lines].filter(Boolean).join('\n');
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0];
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
    const expectedContains = list(vars.expectedContains);
    const expectedExcludes = list(vars.expectedExcludes);
    const rawOutput = findProviderOutput(result);
    const parsed = parseOutput(rawOutput);
    const answer = buildAnswerText(parsed.payload);
    const missing = parsed.payload ? expectedContains.filter((keyword) => !answer.includes(keyword)) : expectedContains;
    const unexpected = parsed.payload ? expectedExcludes.filter((keyword) => answer.includes(keyword)) : [];

    let status = '通过';
    const reasons = [];
    if (!result) {
      status = '异常';
      reasons.push('Promptfoo 没有返回这条用例的结果');
    } else if (result.error) {
      status = '异常';
      reasons.push(firstLine(result.error));
    } else if (parsed.error) {
      status = '异常';
      reasons.push(parsed.error);
    } else if (result.success === false || missing.length || unexpected.length) {
      status = '失败';
    }

    if (missing.length) reasons.push(`缺少关键词：${missing.join('、')}`);
    if (unexpected.length) reasons.push(`出现不该有内容：${unexpected.join('、')}`);
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
      missing: missing.join('、'),
      unexpected: unexpected.join('、'),
      title: parsed.payload && parsed.payload.title ? parsed.payload.title : '',
      answer,
      notes: vars.notes || '',
    };
  });
}

function writeCsv(rows, outputFile) {
  const headers = ['序号', '分类', '问题', '测试结果', '失败原因', '缺失关键词', '不该出现内容', '接口标题', '接口回答', '备注'];
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => [
      row.index,
      row.category,
      row.question,
      row.status,
      row.reason,
      row.missing,
      row.unexpected,
      row.title,
      row.answer,
      row.notes,
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
      <td>${escapeHtml(row.missing)}</td>
      <td>${escapeHtml(row.unexpected)}</td>
      <td>${escapeHtml(row.title)}</td>
      <td><pre>${escapeHtml(row.answer)}</pre></td>
      <td>${escapeHtml(row.notes)}</td>
    </tr>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>问一句 Promptfoo 100 问测试报告</title>
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
    pre { margin: 0; white-space: pre-wrap; font-family: inherit; max-width: 360px; }
    .meta { color: #667085; font-size: 13px; }
  </style>
</head>
<body>
  <h1>问一句 Promptfoo 100 问测试报告</h1>
  <div class="meta">生成时间：${escapeHtml(generatedAt)}　原始结果：${escapeHtml(path.basename(sourceJson))}</div>
  <div class="summary">
    <div class="card"><strong>${total}</strong>总问题数</div>
    <div class="card pass-text"><strong>${passed}</strong>通过</div>
    <div class="card fail-text"><strong>${failed}</strong>失败</div>
    <div class="card error-text"><strong>${errors}</strong>异常</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>序号</th>
        <th>分类</th>
        <th>问题</th>
        <th>测试结果</th>
        <th>失败原因</th>
        <th>缺失关键词</th>
        <th>不该出现内容</th>
        <th>接口标题</th>
        <th>接口回答</th>
        <th>备注</th>
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
    throw new Error('Usage: node scripts/build-promptfoo-query-report.js --input <query-results.json> --cases <query-cases.json> --out-dir <reports-dir>');
  }

  const raw = readJson(input);
  const cases = readJson(casesPath);
  const results = ensureArray(raw.results && raw.results.results);
  const rows = buildRows(cases, results);

  fs.mkdirSync(outDir, { recursive: true });
  const csvFile = path.join(outDir, 'query-report.csv');
  let actualCsvFile = csvFile;
  try {
    writeCsv(rows, csvFile);
  } catch (error) {
    if (error && error.code !== 'EBUSY') throw error;
    actualCsvFile = path.join(outDir, `query-report-${Date.now()}.csv`);
    writeCsv(rows, actualCsvFile);
  }
  writeHtml(rows, path.join(outDir, 'query-report.html'), input);

  const failed = rows.filter((row) => row.status !== '通过').length;
  console.log(`中文报告已生成：${path.join(outDir, 'query-report.html')}`);
  console.log(`CSV 明细已生成：${actualCsvFile}`);
  console.log(`共 ${rows.length} 条，${rows.length - failed} 条通过，${failed} 条需检查。`);
}

main();
