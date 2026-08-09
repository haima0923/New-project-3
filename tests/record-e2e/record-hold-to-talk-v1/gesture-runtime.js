function createVirtualScheduler() {
  let now = 0;
  let sequence = 0;
  const tasks = new Map();
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;

  function setTimeoutVirtual(callback, delay = 0, ...args) {
    sequence += 1;
    const handle = {
      id: sequence,
      unref() { return handle; }
    };
    tasks.set(handle.id, {
      args,
      callback,
      dueAt: now + Math.max(0, Number(delay) || 0),
      handle
    });
    return handle;
  }

  function clearTimeoutVirtual(handle) {
    if (!handle) return;
    tasks.delete(typeof handle === 'object' ? handle.id : handle);
  }

  function nextDueAtOrBefore(target) {
    return Array.from(tasks.values())
      .filter((task) => task.dueAt <= target)
      .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)[0] || null;
  }

  function advanceBy(milliseconds) {
    const target = now + Math.max(0, Number(milliseconds) || 0);
    let task = nextDueAtOrBefore(target);
    while (task) {
      tasks.delete(task.handle.id);
      now = task.dueAt;
      task.callback(...task.args);
      task = nextDueAtOrBefore(target);
    }
    now = target;
  }

  global.setTimeout = setTimeoutVirtual;
  global.clearTimeout = clearTimeoutVirtual;

  return {
    advanceBy,
    now() { return now; },
    pendingCount() { return tasks.size; },
    pendingDelays() {
      return Array.from(tasks.values()).map((task) => task.dueAt - now).sort((a, b) => a - b);
    },
    restore() {
      tasks.clear();
      global.setTimeout = nativeSetTimeout;
      global.clearTimeout = nativeClearTimeout;
    }
  };
}

function point(identifier, clientX, clientY) {
  return { identifier, clientX, clientY };
}

function touchStart(identifier = 1, clientX = 200, clientY = 400, extraTouches = []) {
  const primary = point(identifier, clientX, clientY);
  return {
    touches: [primary].concat(extraTouches),
    changedTouches: [primary]
  };
}

function touchMove(touches) {
  return { touches: touches.slice(), changedTouches: touches.slice() };
}

function touchEnd(identifier = 1, clientX = 200, clientY = 400, remainingTouches = []) {
  return {
    touches: remainingTouches.slice(),
    changedTouches: [point(identifier, clientX, clientY)]
  };
}

function touchCancel(identifier = 1, clientX = 200, clientY = 400, remainingTouches = []) {
  return touchEnd(identifier, clientX, clientY, remainingTouches);
}

module.exports = {
  createVirtualScheduler,
  point,
  touchCancel,
  touchEnd,
  touchMove,
  touchStart
};
