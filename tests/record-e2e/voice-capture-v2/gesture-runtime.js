function createVirtualScheduler() {
  let currentTime = 0;
  let sequence = 0;
  const tasks = new Map();
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;

  function setTimeoutVirtual(callback, delay = 0, ...args) {
    sequence += 1;
    const handle = { id: sequence, unref() { return handle; } };
    tasks.set(handle.id, {
      args,
      callback,
      dueAt: currentTime + Math.max(0, Number(delay) || 0),
      handle
    });
    return handle;
  }

  function clearTimeoutVirtual(handle) {
    if (!handle) return;
    tasks.delete(typeof handle === 'object' ? handle.id : handle);
  }

  function advanceBy(milliseconds) {
    const target = currentTime + Math.max(0, Number(milliseconds) || 0);
    while (true) {
      const next = Array.from(tasks.values())
        .filter((task) => task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)[0];
      if (!next) break;
      tasks.delete(next.handle.id);
      currentTime = next.dueAt;
      next.callback(...next.args);
    }
    currentTime = target;
  }

  global.setTimeout = setTimeoutVirtual;
  global.clearTimeout = clearTimeoutVirtual;

  return {
    advanceBy,
    now() { return currentTime; },
    pendingCount() { return tasks.size; },
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
  return { touches: [primary].concat(extraTouches), changedTouches: [primary] };
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

module.exports = {
  createVirtualScheduler,
  point,
  touchEnd,
  touchMove,
  touchStart
};
