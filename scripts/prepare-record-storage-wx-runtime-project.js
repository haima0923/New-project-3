const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const RUNTIME_SOURCE_FILES = Object.freeze([
  'runtime-test/app.js',
  'runtime-test/app.json',
  'runtime-test/app.wxss',
  'runtime-test/project.config.json',
  'runtime-test/runtime-storage-guard.js',
  'runtime-test/pages/index/index.js',
  'runtime-test/pages/index/index.json',
  'runtime-test/pages/index/index.wxml',
  'runtime-test/pages/index/index.wxss'
]);

const RUNTIME_SHARED_FILES = Object.freeze([
  'utils/record-storage-adapter-contract.js',
  'utils/record-storage-coordinator.js',
  'utils/record-storage-gateway-registry.js',
  'utils/record-storage-runtime-test-contract.js',
  'utils/record-storage-runtime-test-gateway.js',
  'utils/record-storage-transaction-contract.js',
  'utils/record-storage-transaction.js',
  'utils/record-storage-state-projector.js',
  'utils/record-storage-wx-runtime-harness.js',
  'utils/record-state-diff.js'
]);

const ALL_RUNTIME_PROJECT_FILES = Object.freeze(
  RUNTIME_SOURCE_FILES.concat(RUNTIME_SHARED_FILES)
);

function buildError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertOutputDirectory(outputDirectory) {
  if (!outputDirectory) {
    throw buildError(
      'WX_RUNTIME_BUILD_OUTPUT_REQUIRED',
      '必须显式提供仓库外的空白输出目录。'
    );
  }
  const resolved = path.resolve(outputDirectory);
  const realRoot = fs.realpathSync(root);
  let existing = resolved;
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    missingSegments.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const projectedRealPath = path.join(
    fs.realpathSync(existing),
    ...missingSegments
  );
  if (isInside(realRoot, projectedRealPath)) {
    throw buildError(
      'WX_RUNTIME_BUILD_OUTPUT_INSIDE_REPOSITORY',
      '隔离运行时项目必须生成到仓库外。'
    );
  }
  if (resolved === path.parse(resolved).root) {
    throw buildError(
      'WX_RUNTIME_BUILD_OUTPUT_UNSAFE',
      '拒绝使用文件系统根目录作为输出。'
    );
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw buildError(
      'WX_RUNTIME_BUILD_OUTPUT_SYMLINK',
      '隔离运行时项目输出目录不能是符号链接。'
    );
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    throw buildError(
      'WX_RUNTIME_BUILD_OUTPUT_NOT_EMPTY',
      '隔离运行时项目输出目录必须为空。'
    );
  }
  return resolved;
}

function prepareRecordStorageWxRuntimeProject(outputDirectory) {
  const outputRoot = assertOutputDirectory(outputDirectory);
  fs.mkdirSync(outputRoot, { recursive: true });
  const manifestFiles = [];
  ALL_RUNTIME_PROJECT_FILES.forEach((relativeSource) => {
    const source = path.join(root, relativeSource);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw buildError(
        'WX_RUNTIME_BUILD_SOURCE_MISSING',
        `隔离运行时依赖不存在：${relativeSource}`
      );
    }
    const relativeTarget = relativeSource.startsWith('runtime-test/')
      ? relativeSource.slice('runtime-test/'.length)
      : relativeSource;
    const target = path.join(outputRoot, relativeTarget);
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const copied = fs.readFileSync(target);
    if (sha256(content) !== sha256(copied)) {
      throw buildError(
        'WX_RUNTIME_BUILD_HASH_MISMATCH',
        `隔离运行时文件复制校验失败：${relativeSource}`
      );
    }
    manifestFiles.push({
      source: relativeSource,
      target: relativeTarget,
      sha256: sha256(content),
      sizeBytes: content.length
    });
  });
  const manifest = {
    schemaVersion: 'record-storage-wx-runtime-build-v1',
    entry: 'app.js',
    productionAppIncluded: false,
    productionStorageIncluded: false,
    sourceFileCount: manifestFiles.length,
    files: manifestFiles
  };
  fs.writeFileSync(
    path.join(outputRoot, 'runtime-test-build-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return { outputRoot, manifest };
}

function main() {
  const result = prepareRecordStorageWxRuntimeProject(process.argv[2]);
  console.log(`WX runtime project prepared: ${result.outputRoot}`);
  console.log(`Files: ${result.manifest.sourceFileCount}`);
}

if (require.main === module) main();

module.exports = {
  ALL_RUNTIME_PROJECT_FILES,
  RUNTIME_SHARED_FILES,
  RUNTIME_SOURCE_FILES,
  prepareRecordStorageWxRuntimeProject
};
