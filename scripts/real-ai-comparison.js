#!/usr/bin/env node
/*
 * 货小玲真实 AI 模型 × 提示词对比实验。
 *
 * 默认只输出执行计划；只有显式传入 --real 才会产生真实模型调用和费用。
 * 所有题目均来自 test-fixtures/real-ai-comparison-v1.json，均为虚构数据。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildMessages, PROMPT_VERSIONS } = require('./lib/real-ai-comparison-prompts');
const { scoreResult } = require('./lib/real-ai-comparison-score');

const root = path.join(__dirname, '..');
const fixturePath = path.join(root, 'test-fixtures', 'real-ai-comparison-v1.json');
const benchmark = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function parseArgs(argv) {
  const args = {
    real: false,
    runs: 1,
    split: 'all',
    cases: [],
    models: [],
    prompt: PROMPT_VERSIONS.CURRENT_DEEP_V1,
    concurrency: 2,
    timeoutMs: 25000,
    maxTokens: 2000,
    output: ''
  };
  argv.forEach((entry) => {
    if (entry === '--real') args.real = true;
    else if (entry.startsWith('--runs=')) args.runs = Math.max(1, Number(entry.slice(7)) || 1);
    else if (entry.startsWith('--split=')) args.split = entry.slice(8);
    else if (entry.startsWith('--cases=')) args.cases = entry.slice(8).split(',').map((item) => item.trim()).filter(Boolean);
    else if (entry.startsWith('--models=')) args.models = entry.slice(9).split(',').map((item) => item.trim()).filter(Boolean);
    else if (entry.startsWith('--prompt=')) args.prompt = entry.slice(9);
    else if (entry.startsWith('--concurrency=')) args.concurrency = Math.min(4, Math.max(1, Number(entry.slice(14)) || 1));
    else if (entry.startsWith('--timeout-ms=')) args.timeoutMs = Math.max(1000, Number(entry.slice(13)) || 25000);
    else if (entry.startsWith('--max-tokens=')) args.maxTokens = Math.max(200, Number(entry.slice(13)) || 2000);
    else if (entry.startsWith('--output=')) args.output = entry.slice(9);
    else throw new Error(`UNKNOWN_ARGUMENT:${entry}`);
  });
  return args;
}

function loadServerConfig() {
  const candidates = [
    path.join(root, 'server', 'src', 'config.js'),
    path.join(process.cwd(), 'src', 'config.js')
  ];
  const configPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!configPath) throw new Error('SERVER_CONFIG_NOT_FOUND');
  const moduleValue = require(configPath);
  return { config: moduleValue.getConfig(), isRealAiEnabled: moduleValue.isRealAiEnabled };
}

function selectCases(args) {
  return benchmark.cases.filter((testCase) => {
    if (args.split !== 'all' && testCase.split !== args.split) return false;
    if (args.cases.length && !args.cases.includes(testCase.id)) return false;
    return true;
  });
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function percentile(values, rate) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rate) - 1)];
}

function summarize(results) {
  const durations = results.map((item) => item.elapsedMs);
  const count = (name) => results.filter((item) => item.score.classification === name).length;
  const accepted = results.filter((item) => item.score.accepted);
  const exactExpected = results.filter((item) => item.expectedKind === 'exact');
  const safeExpected = results.filter((item) => item.expectedKind !== 'exact');
  const evidenceRequired = results.reduce((sum, item) => sum + item.score.evidence.required.length, 0);
  const evidenceCovered = results.reduce((sum, item) => sum + item.score.evidence.covered.length, 0);
  const usage = results.reduce((acc, item) => {
    acc.promptTokens += Number(item.usage && item.usage.prompt_tokens) || 0;
    acc.completionTokens += Number(item.usage && item.usage.completion_tokens) || 0;
    acc.totalTokens += Number(item.usage && item.usage.total_tokens) || 0;
    return acc;
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  return {
    attempts: results.length,
    exactExpected: exactExpected.length,
    exactCorrect: count('exact_correct'),
    safeExpected: safeExpected.length,
    safeBehaviorCorrect: count('safe_uncertain_correct') + count('split_correct'),
    wrongOrIncomplete: count('wrong_or_incomplete'),
    unsafeWrong: count('unsafe_wrong'),
    formatFailure: count('format_failure'),
    timeout: count('timeout'),
    serviceFailure: count('service_failure'),
    expectedBehaviorCorrect: accepted.length,
    withinEightSecondsAndCorrect: accepted.filter((item) => item.elapsedMs <= 8000).length,
    withinEightSecondsButWrong: results.filter((item) => item.elapsedMs <= 8000 && !item.score.accepted).length,
    averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? Math.max(...durations) : 0,
    evidenceCoverage: evidenceRequired ? evidenceCovered / evidenceRequired : 1,
    usage
  };
}

function safeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function extractJson(content) {
  const source = String(content || '').trim();
  if (!source) throw safeError('AI_EMPTY_RESPONSE', '模型返回空内容');
  try {
    return JSON.parse(source);
  } catch (error) {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) throw safeError('AI_INVALID_JSON', '模型没有返回JSON');
    try {
      return JSON.parse(match[0]);
    } catch (nested) {
      throw safeError('AI_INVALID_JSON', '模型JSON无法解析');
    }
  }
}

async function callModel(config, task, args) {
  const messages = buildMessages(args.prompt, task.testCase, benchmark.referenceDate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model: task.model,
        messages,
        temperature: 0.1,
        enable_thinking: false,
        response_format: { type: 'json_object' },
        max_tokens: args.maxTokens
      }),
      signal: controller.signal
    });
    if (!response.ok) throw safeError(`AI_HTTP_${response.status}`, `模型服务返回HTTP ${response.status}`);
    const data = await response.json();
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message ? choice.message.content : '';
    const parsed = extractJson(content);
    const score = scoreResult(task.testCase, parsed, null);
    return {
      caseId: task.testCase.id,
      split: task.testCase.split,
      category: task.testCase.category,
      text: task.testCase.text,
      expectedKind: task.testCase.expected.kind,
      model: task.model,
      promptVersion: args.prompt,
      run: task.run,
      elapsedMs: Date.now() - startedAt,
      finishReason: choice && choice.finish_reason ? choice.finish_reason : '',
      usage: data && data.usage ? data.usage : {},
      modelResult: parsed,
      score
    };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    const transportError = {
      code: timedOut ? 'AI_TIMEOUT' : (error && error.code) || 'AI_REQUEST_FAILED'
    };
    return {
      caseId: task.testCase.id,
      split: task.testCase.split,
      category: task.testCase.category,
      text: task.testCase.text,
      expectedKind: task.testCase.expected.kind,
      model: task.model,
      promptVersion: args.prompt,
      run: task.run,
      elapsedMs: Date.now() - startedAt,
      finishReason: '',
      usage: {},
      errorCode: transportError.code,
      score: scoreResult(task.testCase, null, transportError)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function next() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(tasks[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

function buildTasks(cases, models, runs) {
  const tasks = [];
  for (let run = 1; run <= runs; run += 1) {
    cases.forEach((testCase, caseIndex) => {
      const order = caseIndex % 2 === 0 ? models : models.slice().reverse();
      order.forEach((model) => tasks.push({ run, testCase, model }));
    });
  }
  return tasks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedCases = selectCases(args);
  if (!selectedCases.length) throw new Error('NO_CASES_SELECTED');
  const loaded = loadServerConfig();
  const models = unique(args.models.length ? args.models : [loaded.config.aiFastModel, loaded.config.aiModel]);
  if (!models.length) throw new Error('NO_MODELS_CONFIGURED');
  const tasks = buildTasks(selectedCases, models, args.runs);
  const plan = {
    mode: args.real ? 'real-ai' : 'plan-only',
    benchmarkVersion: benchmark.benchmarkVersion,
    referenceDate: benchmark.referenceDate,
    promptVersion: args.prompt,
    models,
    caseCount: selectedCases.length,
    developmentCases: selectedCases.filter((item) => item.split === 'development').length,
    holdoutCases: selectedCases.filter((item) => item.split === 'holdout').length,
    finalHoldoutCases: selectedCases.filter((item) => item.split === 'final_holdout').length,
    runs: args.runs,
    totalCalls: tasks.length,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    maxTokens: args.maxTokens,
    output: args.output || '(stdout only)'
  };

  if (!args.real) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (!loaded.isRealAiEnabled(loaded.config)) throw new Error('REAL_AI_CONFIG_MISSING');

  process.stderr.write(`开始真实AI对比：${tasks.length}次调用，${models.length}个模型，${selectedCases.length}道题。\n`);
  const results = await runPool(tasks, args.concurrency, async (task, index) => {
    const result = await callModel(loaded.config, task, args);
    process.stderr.write(`[${index + 1}/${tasks.length}] ${task.testCase.id} · ${task.model} · ${result.score.classification} · ${result.elapsedMs}ms\n`);
    return result;
  });

  const byModel = {};
  models.forEach((model) => {
    byModel[model] = summarize(results.filter((item) => item.model === model));
  });
  const promptHash = crypto.createHash('sha256')
    .update(buildMessages(args.prompt, selectedCases[0], benchmark.referenceDate)[0].content)
    .digest('hex');
  const output = {
    generatedAt: new Date().toISOString(),
    plan,
    promptHash,
    summaries: byModel,
    results
  };

  if (args.output) {
    const outputPath = path.isAbsolute(args.output) ? args.output : path.join(root, args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    process.stderr.write(`结果已写入 ${outputPath}\n`);
  }
  process.stdout.write(`${JSON.stringify({ plan, promptHash, summaries: byModel }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ errorCode: error && error.code ? error.code : error && error.message ? error.message : 'UNKNOWN_ERROR' })}\n`);
  process.exitCode = 1;
});
