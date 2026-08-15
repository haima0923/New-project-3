#!/usr/bin/env node
const { CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');

async function main() {
  const id = String(process.argv[2] || '');
  const contract = CASES.find((entry) => entry.id === id);
  if (!contract) {
    const error = new Error(`Unknown Voice Record Evidence case: ${id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  process.stdout.write(JSON.stringify(await executeCase(contract)));
}

main().catch((error) => {
  process.stderr.write(`${error.code || 'UNEXPECTED_RUNNER_ERROR'}:${error.message}\n`);
  process.exitCode = 2;
});
