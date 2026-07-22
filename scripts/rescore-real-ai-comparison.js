#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const benchmark = require('../test-fixtures/real-ai-comparison-v1.json');
const { scoreResult } = require('./lib/real-ai-comparison-score');

const root = path.join(__dirname, '..');
const inputArg = process.argv.find((item) => item.startsWith('--input='));
const outputArg = process.argv.find((item) => item.startsWith('--output='));
if (!inputArg || !outputArg) throw new Error('USAGE: --input=... --output=...');
const resolve = (value) => path.isAbsolute(value) ? value : path.join(root, value);
const inputPath = resolve(inputArg.slice(8));
const outputPath = resolve(outputArg.slice(9));
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const cases = new Map(benchmark.cases.map((item) => [item.id, item]));

data.results = (data.results || []).map((result) => {
  const testCase = cases.get(result.caseId);
  if (!testCase) throw new Error(`UNKNOWN_CASE:${result.caseId}`);
  const transportError = result.errorCode ? { code: result.errorCode } : null;
  return Object.assign({}, result, {
    expectedKind: testCase.expected.kind,
    score: scoreResult(testCase, result.modelResult, transportError)
  });
});
data.rescoredAt = new Date().toISOString();
data.scoringNote = '模型原始答案与耗时未改变；仅按当前冻结题库重新计算互斥评分。';
delete data.summaries;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(`已重新评分 ${data.results.length} 条，不改变模型原始答案：${outputPath}`);
