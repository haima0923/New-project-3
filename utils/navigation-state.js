function getGlobalData() {
  if (typeof getApp !== 'function') return null;
  const app = getApp();
  return app && app.globalData ? app.globalData : null;
}

function setNextOrderFilter(filter) {
  const globalData = getGlobalData();
  if (!globalData) return;
  globalData.nextOrderFilter = filter || null;
  globalData.resetOrderFiltersOnNextShow = false;
}

function setNextRecordFilter(filterType) {
  const globalData = getGlobalData();
  if (!globalData) return;
  globalData.nextRecordFilter = filterType || null;
}

function peekNextOrderFilter() {
  const globalData = getGlobalData();
  return globalData ? globalData.nextOrderFilter : null;
}

function consumeNextOrderFilter() {
  const globalData = getGlobalData();
  if (!globalData || !globalData.nextOrderFilter) return null;
  const filter = globalData.nextOrderFilter;
  globalData.nextOrderFilter = null;
  globalData.resetOrderFiltersOnNextShow = false;
  return filter;
}

function clearNextOrderFilter() {
  const globalData = getGlobalData();
  if (!globalData) return;
  globalData.nextOrderFilter = null;
}

function requestOrderFilterReset() {
  const globalData = getGlobalData();
  if (!globalData) return;
  if (globalData.nextOrderFilter) return;
  globalData.resetOrderFiltersOnNextShow = true;
}

function consumeOrderFilterReset() {
  const globalData = getGlobalData();
  if (!globalData || !globalData.resetOrderFiltersOnNextShow) return false;
  globalData.resetOrderFiltersOnNextShow = false;
  return true;
}

function consumeNextRecordFilter() {
  const globalData = getGlobalData();
  if (!globalData || !globalData.nextRecordFilter) return null;
  const filter = globalData.nextRecordFilter;
  globalData.nextRecordFilter = null;
  return filter;
}

module.exports = {
  clearNextOrderFilter,
  consumeNextOrderFilter,
  consumeNextRecordFilter,
  consumeOrderFilterReset,
  peekNextOrderFilter,
  requestOrderFilterReset,
  setNextRecordFilter,
  setNextOrderFilter
};
