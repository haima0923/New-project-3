#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const inputsArg = process.argv.find((item) => item.startsWith('--inputs='));
const outputArg = process.argv.find((item) => item.startsWith('--output='));
if (!inputsArg || !outputArg) throw new Error('USAGE: --inputs=a.json,b.json --output=merged.json');
const resolve = (value) => path.isAbsolute(value) ? value : path.join(root, value);
const inputPaths = inputsArg.slice(9).split(',').map((item) => resolve(item.trim())).filter(Boolean);
const outputPath = resolve(outputArg.slice(9));
const offsets = {};
const merged = [];

inputPaths.forEach((inputPath) => {
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const byConfig = {};
  (data.results || []).forEach((result) => {
    const key = `${result.promptVersion}||${result.model}`;
    if (!byConfig[key]) byConfig[key] = [];
    byConfig[key].push(result);
  });
  Object.entries(byConfig).forEach(([key, results]) => {
    const offset = offsets[key] || 0;
    results.forEach((result) => merged.push(Object.assign({}, result, { run: Number(result.run || 1) + offset })));
    const maxRun = Math.max(...results.map((result) => Number(result.run || 1)));
    offsets[key] = offset + maxRun;
  });
});

const output = {
  generatedAt: new Date().toISOString(),
  mergedFrom: inputPaths,
  results: merged
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`已合并 ${merged.length} 条结果：${outputPath}`);
