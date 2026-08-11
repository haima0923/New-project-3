function createVirtualScheduler() {
  let currentTime = 0;
  let sequence = 0;
  const tasks = new Map();
  const taskHistory = [];
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const nativeDateNow = Date.now;
  const epochTime = nativeDateNow();

  function setTimeoutVirtual(callback, delay = 0, ...args) {
    sequence += 1;
    const handle = { id: sequence, unref() { return handle; } };
    const task = {
      args,
      callback,
      cancelled: false,
      dueAt: currentTime + Math.max(0, Number(delay) || 0),
      handle,
      invoked: false
    };
    tasks.set(handle.id, task);
    taskHistory.push(task);
    return handle;
  }

  function clearTimeoutVirtual(handle) {
    if (!handle) return;
    const id = typeof handle === 'object' ? handle.id : handle;
    const task = tasks.get(id);
    if (task) task.cancelled = true;
    tasks.delete(id);
  }

  function advanceBy(milliseconds) {
    const target = currentTime + Math.max(0, Number(milliseconds) || 0);
    while (true) {
      const next = Array.from(tasks.values())
        .filter((task) => task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)[0];
      if (!next) break;
      tasks.delete(next.handle.id);
      next.invoked = true;
      currentTime = next.dueAt;
      next.callback(...next.args);
    }
    currentTime = target;
  }

  global.setTimeout = setTimeoutVirtual;
  global.clearTimeout = clearTimeoutVirtual;
  Date.now = () => epochTime + currentTime;

  return {
    advanceBy,
    checkpoint() { return sequence; },
    invokeSnapshot(task) {
      if (!task || typeof task.callback !== 'function') return false;
      task.callback(...task.args);
      return true;
    },
    invokeSnapshotAtDue(task) {
      if (!task || typeof task.callback !== 'function') return false;
      advanceBy(Math.max(0, Number(task.dueAt) - currentTime));
      task.callback(...task.args);
      return true;
    },
    now() { return currentTime; },
    pendingCount() { return tasks.size; },
    snapshotsAfter(checkpoint = 0) {
      return taskHistory.filter((task) => task.handle.id > checkpoint).slice();
    },
    restore() {
      tasks.clear();
      taskHistory.length = 0;
      global.setTimeout = nativeSetTimeout;
      global.clearTimeout = nativeClearTimeout;
      Date.now = nativeDateNow;
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
