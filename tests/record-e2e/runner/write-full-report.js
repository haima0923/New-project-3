const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./constants');
const { sanitizeEvidence } = require('./sanitize-evidence');

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateOutputPath(outputPath) {
  if (!outputPath || !path.isAbsolute(outputPath)) {
    throw Object.assign(new Error('--output must be an explicit absolute path'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const resolved = path.resolve(outputPath);
  if (isInside(ROOT, resolved)) {
    throw Object.assign(new Error('--output must not write inside the repository'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const allowedRoots = Array.from(new Set([
    path.resolve(os.tmpdir()),
    '/private/tmp',
    '/tmp'
  ].map((item) => path.resolve(item))));
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw Object.assign(new Error('--output must be inside a repository-external temp directory'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return resolved;
}

function writeFullReport(outputPath, report) {
  const resolved = validateOutputPath(outputPath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw Object.assign(new Error(`Output parent does not exist: ${parent}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const sanitized = sanitizeEvidence(report);
  const payload = `${JSON.stringify(sanitized, null, 2)}\n`;
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (_cleanupError) {
      // The exact temporary file is best-effort cleanup only.
    }
    throw error;
  }
  return {
    bytes: Buffer.byteLength(payload),
    path: resolved,
    sanitized: true
  };
}

module.exports = {
  isInside,
  validateOutputPath,
  writeFullReport
};
