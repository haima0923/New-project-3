const fs = require('fs');

const WRITE_METHODS = [
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync'
];

function isWriteFlag(flags) {
  return typeof flags === 'number'
    ? flags !== 0
    : /[wa+]/.test(String(flags || 'r'));
}

function createHostFilesystemGuard() {
  const originals = new Map();
  const promiseOriginals = new Map();
  const events = [];
  let installed = false;

  function block(method, target) {
    events.push({ method, target: String(target || '') });
    const error = new Error(`Headless Runner blocked host filesystem write: ${method}`);
    error.code = 'AUTOMATION_STORAGE_GUARD_ERROR';
    throw error;
  }

  function install() {
    if (installed) return;
    installed = true;
    WRITE_METHODS.forEach((method) => {
      if (typeof fs[method] !== 'function') return;
      originals.set(method, fs[method]);
      fs[method] = (...args) => block(method, args[0]);
    });
    ['open', 'openSync'].forEach((method) => {
      if (typeof fs[method] !== 'function') return;
      originals.set(method, fs[method]);
      fs[method] = (...args) => {
        if (isWriteFlag(args[1])) return block(method, args[0]);
        return originals.get(method).apply(fs, args);
      };
    });
    if (fs.promises) {
      ['appendFile', 'mkdir', 'open', 'rename', 'rm', 'truncate', 'unlink', 'writeFile']
        .forEach((method) => {
          if (typeof fs.promises[method] !== 'function') return;
          promiseOriginals.set(method, fs.promises[method]);
          fs.promises[method] = async (...args) => {
            if (method === 'open' && !isWriteFlag(args[1])) {
              return promiseOriginals.get(method).apply(fs.promises, args);
            }
            return block(`promises.${method}`, args[0]);
          };
        });
    }
  }

  function restore() {
    originals.forEach((value, key) => { fs[key] = value; });
    promiseOriginals.forEach((value, key) => { fs.promises[key] = value; });
  }

  return {
    audit() {
      return {
        auditPerformed: true,
        guardInstalled: installed,
        hostFilesystemStorageCalls: events.length,
        events: events.slice()
      };
    },
    install,
    restore
  };
}

module.exports = {
  createHostFilesystemGuard,
  isWriteFlag
};
