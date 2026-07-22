#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const benchmark = require('../test-fixtures/real-ai-comparison-v1.json');

const STATUS_ZH = {
  exact_correct: '字段完全正确',
  safe_uncertain_correct: '正确承认不确定',
  split_correct: '正确识别为多笔业务',
  wrong_or_incomplete: '答错或漏字段',
  unsafe_wrong: '危险错误',
  format_failure: '返回格式错误',
  timeout: '超时',
  service_failure: '模型服务失败'
};

function parseArgs(argv) {
  const args = { inputs: [], markdown: '', html: '' };
  argv.forEach((entry) => {
    if (entry.startsWith('--inputs=')) args.inputs = entry.slice(9).split(',').map((item) => item.trim()).filter(Boolean);
    else if (entry.startsWith('--markdown=')) args.markdown = entry.slice(11);
    else if (entry.startsWith('--html=')) args.html = entry.slice(7);
    else throw new Error(`UNKNOWN_ARGUMENT:${entry}`);
  });
  if (!args.inputs.length) throw new Error('INPUTS_REQUIRED');
  if (!args.markdown && !args.html) throw new Error('OUTPUT_REQUIRED');
  return args;
}

function resolve(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function oneLine(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
}

function pct(numerator, denominator) {
  if (!denominator) return '—';
  return `${(numerator * 100 / denominator).toFixed(1)}%`;
}

function seconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(2)}秒`;
}

function configKey(item) {
  return `${item.model}||${item.promptVersion}`;
}

function actualSummary(result) {
  if (result.errorCode) return `没有可用答案（${result.errorCode}）`;
  const output = result.modelResult || {};
  const fields = output.fields || {};
  const parts = [`类型=${output.intent || '空'}`];
  const labels = {
    customerName: '客户', productName: '商品', quantity: '数量', unit: '单位', unitPrice: '单价',
    amount: '金额', paymentAmount: '本次收款', depositAmount: '定金', paymentKind: '款项类型',
    dueDate: '日期', orderId: '订单关联', receivableId: '待收关联', todoTitle: '提醒内容'
  };
  Object.entries(labels).forEach(([field, label]) => {
    if (fields[field] !== undefined && fields[field] !== null && String(fields[field]) !== '') {
      parts.push(`${label}=${oneLine(fields[field])}`);
    }
  });
  if (Array.isArray(fields.items) && fields.items.length) {
    parts.push(`商品明细=${fields.items.map((item) => `${item.productName || '空'}×${item.quantity || '空'}@${item.unitPrice || '空'}`).join('；')}`);
  }
  const risks = [];
  if ((output.missing_fields || []).length) risks.push(`缺失:${output.missing_fields.join('、')}`);
  if ((output.low_confidence_fields || []).length) risks.push(`不确定:${output.low_confidence_fields.join('、')}`);
  if ((output.field_conflicts || []).length) risks.push(`冲突:${oneLine(JSON.stringify(output.field_conflicts))}`);
  if ((output.intent_candidates || []).length) risks.push(`候选业务:${output.intent_candidates.join('、')}`);
  if (risks.length) parts.push(`风险提示=${risks.join('；')}`);
  return parts.join('；');
}

function expectedSummary(testCase) {
  const expected = testCase.expected || {};
  const parts = [];
  if (expected.kind === 'exact') parts.push('应准确提取');
  if (expected.kind === 'safe_uncertain') parts.push('应保留不确定并阻止直接保存');
  if (expected.kind === 'split_required') parts.push('应识别为多笔业务并阻止合并保存');
  if (expected.intent) parts.push(`类型=${expected.intent}`);
  if (expected.allowedIntents) parts.push(`允许类型=${expected.allowedIntents.join('/')}`);
  Object.entries(expected.fields || {}).forEach(([field, value]) => parts.push(`${field}=${value}`));
  if (expected.items) {
    parts.push(`items=${expected.items.map((item) => `${item.productName}×${item.quantity}@${item.unitPrice}`).join('；')}`);
  }
  if (expected.mustBeEmpty) parts.push(`必须留空=${expected.mustBeEmpty.join('、')}`);
  if (expected.mustMarkUncertain) parts.push(`必须提示不确定=${expected.mustMarkUncertain.join('、')}`);
  if (expected.requiredIntentCandidates) parts.push(`必须识别候选=${expected.requiredIntentCandidates.join('、')}`);
  return parts.join('；');
}

function splitLabel(testCase) {
  if (testCase.split === 'final_holdout') return '最终未见题';
  if (testCase.split === 'holdout') return '首轮验证题';
  return '开发题';
}

function failedChecks(result) {
  return (result.score && result.score.checks || []).filter((item) => !item.pass).map((item) => {
    return `${item.label}：应为 ${oneLine(JSON.stringify(item.expected))}，实际 ${oneLine(JSON.stringify(item.actual))}`;
  });
}

function aggregate(results) {
  const groups = new Map();
  results.forEach((item) => {
    const key = configKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return Array.from(groups.entries()).map(([key, items]) => {
    const [model, promptVersion] = key.split('||');
    const exactExpected = items.filter((item) => item.expectedKind === 'exact').length;
    const safeExpected = items.length - exactExpected;
    const exactCorrect = items.filter((item) => item.score.classification === 'exact_correct').length;
    const safeCorrect = items.filter((item) => ['safe_uncertain_correct', 'split_correct'].includes(item.score.classification)).length;
    const accepted = items.filter((item) => item.score.accepted).length;
    const byCase = new Map();
    items.forEach((item) => {
      if (!byCase.has(item.caseId)) byCase.set(item.caseId, []);
      byCase.get(item.caseId).push(item);
    });
    const durations = items.map((item) => item.elapsedMs).sort((a, b) => a - b);
    const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] || 0;
    return {
      key, model, promptVersion, attempts: items.length, exactExpected, exactCorrect, safeExpected, safeCorrect,
      accepted, unsafe: items.filter((item) => item.score.classification === 'unsafe_wrong').length,
      uniqueCases: byCase.size,
      allAttemptsCorrectCases: Array.from(byCase.values()).filter((attempts) => attempts.every((item) => item.score.accepted)).length,
      errors: items.filter((item) => ['format_failure', 'timeout', 'service_failure'].includes(item.score.classification)).length,
      within8Correct: items.filter((item) => item.score.accepted && item.elapsedMs <= 8000).length,
      averageMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
      p95Ms: p95,
      totalTokens: items.reduce((sum, item) => sum + (Number(item.usage && item.usage.total_tokens) || 0), 0)
    };
  });
}

function buildMarkdown(datasets, results, summaries) {
  const lines = [
    '# 货小玲真实 AI 模型与提示词对比报告',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。`,
    '',
    '## 先说清楚这份报告代表什么',
    '',
    `- 使用同一套 ${benchmark.cases.length} 道虚构但贴近真实业务的句子，固定“今天”为 ${benchmark.referenceDate}。`,
    '- “字段完全正确”与“正确承认不确定”分开计算；模型答不出来或被拒绝，不能算识别正确。',
    '- 时间是服务器到模型的回答时间，不含微信语音转文字、手机网络、登录和页面渲染。',
    '- 这份报告只测模型回答；是否真的阻止错误保存，仍要另跑小程序完整保存链路。',
    '- 前32道用于同题优化回归；最后8道是在第五版提示词冻结后才加入的最终验证题，结果不会再用于改提示词。',
    '',
    '## 总成绩',
    '',
    '| 模型 | 提示词 | 调用次数 | 正确处理 | 每题所有轮次都正确 | 明确题完全正确 | 模糊题安全处理 | 危险错误 | 8秒内且正确 | 平均时间 | P95时间 | 总Token |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  summaries.forEach((item) => {
    lines.push(`| ${item.model} | ${item.promptVersion} | ${item.attempts} | ${item.accepted}/${item.attempts}（${pct(item.accepted, item.attempts)}） | ${item.allAttemptsCorrectCases}/${item.uniqueCases} | ${item.exactCorrect}/${item.exactExpected}（${pct(item.exactCorrect, item.exactExpected)}） | ${item.safeCorrect}/${item.safeExpected}（${pct(item.safeCorrect, item.safeExpected)}） | ${item.unsafe} | ${item.within8Correct}/${item.attempts} | ${seconds(item.averageMs)} | ${seconds(item.p95Ms)} | ${item.totalTokens || '未返回'} |`);
  });
  lines.push('', '## 逐题明细', '');
  benchmark.cases.forEach((testCase) => {
    const rows = results.filter((item) => item.caseId === testCase.id);
    lines.push(`### ${testCase.id}｜${testCase.category}｜${splitLabel(testCase)}`, '');
    lines.push(`**题目：** ${testCase.text.replace(/\n/g, ' / ')}`, '');
    lines.push(`**标准答案：** ${expectedSummary(testCase)}`, '');
    lines.push('| 模型 | 提示词 | 次数 | 结果 | 时间 | AI实际答案 | 错在哪里 |');
    lines.push('| --- | --- | ---: | --- | ---: | --- | --- |');
    rows.forEach((row) => {
      const failures = failedChecks(row);
      lines.push(`| ${row.model} | ${row.promptVersion} | ${row.run} | ${STATUS_ZH[row.score.classification] || row.score.classification} | ${seconds(row.elapsedMs)} | ${actualSummary(row).replace(/\|/g, '\\|')} | ${(failures.length ? failures.join('；') : '无').replace(/\|/g, '\\|')} |`);
    });
    lines.push('');
  });
  lines.push('## 本次没有验证的内容', '', '- 微信真实语音在口音、噪声下能否正确转成文字。', '- 小程序确认卡、人工修改、点击保存后的完整业务链路。', '- 真机从说完一句话到看到确认卡的总耗时。', '');
  return `${lines.join('\n')}\n`;
}

function buildHtml(results, summaries) {
  const cards = benchmark.cases.map((testCase) => {
    const rows = results.filter((item) => item.caseId === testCase.id).map((row) => {
      const failures = failedChecks(row);
      const cls = row.score.accepted ? 'ok' : row.score.unsafe ? 'danger' : 'bad';
      return `<tr><td>${esc(row.model)}</td><td>${esc(row.promptVersion)}</td><td>${row.run}</td><td><span class="pill ${cls}">${esc(STATUS_ZH[row.score.classification] || row.score.classification)}</span></td><td>${esc(seconds(row.elapsedMs))}</td><td>${esc(actualSummary(row))}</td><td>${esc(failures.length ? failures.join('；') : '无')}</td></tr>`;
    }).join('');
    return `<section><h2>${esc(testCase.id)}｜${esc(testCase.category)} <small>${splitLabel(testCase)}</small></h2><p><b>题目：</b>${esc(testCase.text)}</p><p><b>标准答案：</b>${esc(expectedSummary(testCase))}</p><div class="scroll"><table><thead><tr><th>模型</th><th>提示词</th><th>次数</th><th>结果</th><th>时间</th><th>AI实际答案</th><th>错在哪里</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join('');
  const summaryRows = summaries.map((item) => `<tr><td>${esc(item.model)}</td><td>${esc(item.promptVersion)}</td><td>${item.attempts}</td><td>${item.accepted}/${item.attempts}（${pct(item.accepted, item.attempts)}）</td><td>${item.allAttemptsCorrectCases}/${item.uniqueCases}</td><td>${item.exactCorrect}/${item.exactExpected}（${pct(item.exactCorrect, item.exactExpected)}）</td><td>${item.safeCorrect}/${item.safeExpected}（${pct(item.safeCorrect, item.safeExpected)}）</td><td>${item.unsafe}</td><td>${item.within8Correct}/${item.attempts}</td><td>${seconds(item.averageMs)}</td><td>${seconds(item.p95Ms)}</td><td>${item.totalTokens || '未返回'}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>货小玲真实AI对比报告</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f7fb;color:#172033;line-height:1.55}.wrap{max-width:1500px;margin:auto;padding:24px}h1{font-size:30px}h2{font-size:20px;margin:0 0 10px}small{font-weight:500;color:#627084}section,.intro{background:#fff;border:1px solid #e5eaf2;border-radius:14px;padding:18px;margin:16px 0;box-shadow:0 5px 20px rgba(29,58,100,.05)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e8edf4;padding:10px;text-align:left;vertical-align:top;min-width:90px}th{background:#f7f9fc}.scroll{overflow:auto}.pill{white-space:nowrap;border-radius:999px;padding:3px 8px;font-weight:700}.ok{background:#e7f7ee;color:#167341}.bad{background:#fff3da;color:#9a5b00}.danger{background:#ffe6e6;color:#b42318}ul{padding-left:22px}</style></head><body><main class="wrap"><h1>货小玲真实 AI 模型与提示词对比报告</h1><div class="intro"><p>同一套 ${benchmark.cases.length} 道题，固定“今天”为 ${benchmark.referenceDate}。字段正确、安全承认不确定、危险错误分别统计。</p><ul><li>模型被拒绝不等于识别正确。</li><li>8秒内返回不等于8秒内答对。</li><li>这里只测模型回答，保存安全和真机总耗时另测。</li><li>最后8道题是在第五版提示词冻结后加入，结果不再用于继续调提示词。</li></ul><div class="scroll"><table><thead><tr><th>模型</th><th>提示词</th><th>调用</th><th>正确处理</th><th>每题全部轮次都正确</th><th>明确题完全正确</th><th>模糊题安全处理</th><th>危险错误</th><th>8秒内正确</th><th>平均</th><th>P95</th><th>总Token</th></tr></thead><tbody>${summaryRows}</tbody></table></div></div>${cards}</main></body></html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasets = args.inputs.map((input) => JSON.parse(fs.readFileSync(resolve(input), 'utf8')));
  const results = datasets.flatMap((dataset) => dataset.results || []);
  const summaries = aggregate(results);
  if (args.markdown) {
    const output = resolve(args.markdown);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, buildMarkdown(datasets, results, summaries), 'utf8');
  }
  if (args.html) {
    const output = resolve(args.html);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, buildHtml(results, summaries), 'utf8');
  }
  console.log(`报告已生成：${args.markdown || ''} ${args.html || ''}`.trim());
}

main();
