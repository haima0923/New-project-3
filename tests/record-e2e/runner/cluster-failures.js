const { stableHash } = require('../../../utils/record-state-diff');

const RISK_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, UNKNOWN: 3 });
const CANDIDATE_OWNERSHIPS = new Set([
  'EXPECTED_MAPPING_MISMATCH_CANDIDATE',
  'FIXTURE_DATA_ERROR_CANDIDATE',
  'TEST_CONTRACT_MISMATCH_CANDIDATE',
  'OBSERVABILITY_EXPECTATION_MISMATCH',
  'UNCLASSIFIED_REQUIRES_REVIEW'
]);

function failedAssertionNames(result) {
  return (result.assertions || [])
    .filter((assertion) => assertion.pass === false)
    .map((assertion) => assertion.name);
}

function rootCauseKey(result) {
  if (result.entrySurface === 'HOME_QUICK'
    && result.pageEvidence
    && result.pageEvidence.pageEditConsistency
    && result.pageEvidence.pageEditConsistency.consistent === false) {
    return 'CONFIRMATION:PRIMARY_ITEM_SYNC';
  }
  const missing = result.surfaceEvidence && result.surfaceEvidence.missingCapabilities || [];
  if (result.failureCode === 'REQUIRED_PAGE_CAPABILITY_MISSING' && missing.length) {
    return `SURFACE_CAPABILITY:${missing.slice().sort().join('+')}`;
  }
  if (result.caseId === 'REC-E2E-PERSIST-003') {
    return 'CONTRACT:EXACT_REPLAY_PAGE_SAVE_COUNTER';
  }
  if (result.caseId === 'REC-E2E-PERSIST-004') {
    return 'EXPECTED_MAPPING:OPERATION_LOG_CREATE';
  }
  const firstAssertion = result.primaryFailure && result.primaryFailure.name
    || failedAssertionNames(result)[0]
    || result.failureCode
    || 'UNKNOWN';
  if (result.failureOwnership === 'OBSERVABILITY_EXPECTATION_MISMATCH') {
    const roots = Array.from(new Set(failedAssertionNames(result).map((name) => (
      String(name).split('.')[0]
    )))).sort();
    return `OBSERVABILITY:${roots.join('+')}`;
  }
  if (result.failureStage === 'AI_NORMALIZE_ERROR') {
    return `AI_NORMALIZE:${result.aiProfile}:${firstAssertion}`;
  }
  if (result.failureStage === 'LOCAL_PARSE_ERROR') {
    return `LOCAL_PARSE:${result.businessType}:${firstAssertion}`;
  }
  if (result.failureStage === 'ROUTE_ERROR') {
    return `ROUTE_ACTUAL:${result.routeEvidence
      && result.routeEvidence.actualRoute || 'UNKNOWN'}:${firstAssertion}`;
  }
  if (result.failureStage === 'PREFLIGHT_ERROR') {
    return `PREFLIGHT:${firstAssertion}`;
  }
  if (result.failureStage === 'CONFIRMATION_ERROR') {
    return `CONFIRMATION:${firstAssertion}`;
  }
  if (result.failureStage === 'STATE_DIFF_ERROR') {
    return `STATE_DIFF:${firstAssertion}`;
  }
  return `${result.failureOwnership}:${result.failureStage}:${firstAssertion}`;
}

function clusterKey(result) {
  return `${rootCauseKey(result)}::OWNERSHIP:${result.failureOwnership}`;
}

function rootKey(key) {
  return String(key).split('::OWNERSHIP:')[0];
}

function clusterTitle(key) {
  key = rootKey(key);
  const titles = {
    'CONFIRMATION:PRIMARY_ITEM_SYNC': '首页顶层编辑与items[0]不同步',
    'CONTRACT:EXACT_REPLAY_PAGE_SAVE_COUNTER': 'Exact replay旧页面保存计数合同冲突',
    'EXPECTED_MAPPING:OPERATION_LOG_CREATE': '隔离提交operationLogs映射预期差异'
  };
  if (titles[key]) return titles[key];
  if (key.startsWith('SURFACE_CAPABILITY:')) {
    return `页面缺少必要交互能力：${key.split(':')[1]}`;
  }
  if (key.startsWith('LOCAL_PARSE:')) return `本地解析字段差异：${key.split(':').slice(1).join(' / ')}`;
  if (key.startsWith('AI_NORMALIZE:')) return `Fake/Replay标准化差异：${key.split(':').slice(1).join(' / ')}`;
  if (key.startsWith('ROUTE_ACTUAL:')) return `生产路由差异：${key.split(':').slice(1).join(' / ')}`;
  if (key.startsWith('PREFLIGHT:')) return `安全预检差异：${key.split(':')[1]}`;
  if (key.startsWith('OBSERVABILITY:')) return `可观测集合预期差异：${key.split(':')[1]}`;
  if (key.startsWith('STATE_DIFF:')) return `最终State Diff差异：${key.split(':')[1]}`;
  return key.replace(/:/g, ' / ');
}

function suspectedRootArea(key, ownership) {
  key = rootKey(key);
  if (key.startsWith('SURFACE_CAPABILITY:')) return 'pages/input/input.js page capability';
  if (key === 'CONFIRMATION:PRIMARY_ITEM_SYNC') return 'pages/dashboard/dashboard.js confirmation edit';
  if (key.startsWith('LOCAL_PARSE:')) return 'local parser/result mapping';
  if (key.startsWith('AI_NORMALIZE:')) return 'fake/replay response normalize and merge';
  if (key.startsWith('ROUTE_ACTUAL:')) return 'production route decision';
  if (key.startsWith('PREFLIGHT:')) return 'domain preflight/result mapping';
  if (key.startsWith('CONTRACT:')) return 'E2E execution evidence contract';
  if (key.startsWith('EXPECTED_MAPPING:') || key.startsWith('OBSERVABILITY:')) {
    return 'E2E State Diff/observability mapping contract';
  }
  if (ownership === 'CONFIRMED_LEGACY_BUSINESS_DEFECT') return 'Legacy business mutation';
  return 'requires targeted evidence review';
}

function recommendedNextAction(ownership, risk) {
  if (ownership === 'TEST_CONTRACT_MISMATCH_CANDIDATE'
    || ownership === 'EXPECTED_MAPPING_MISMATCH_CANDIDATE'
    || ownership === 'OBSERVABILITY_EXPECTATION_MISMATCH'
    || ownership === 'FIXTURE_DATA_ERROR_CANDIDATE') {
    return '先只读核对Case合同、字段别名与Diff投影；确认后只修测试合同，不改产品代码。';
  }
  if (ownership === 'UNCLASSIFIED_REQUIRES_REVIEW') {
    return '补充单题分层Evidence并人工判责；证据不足前不得修改产品或Expected。';
  }
  if (risk === 'P0') {
    return '建立独立产品修复任务，先运行时复现最早失败层，再修对应生产模块并重跑整个Cluster。';
  }
  return '建立分层产品修复任务，修复后重跑该Cluster及相邻业务分类。';
}

function buildCluster(key, results) {
  const ownerships = Array.from(new Set(results.map((result) => result.failureOwnership)));
  if (ownerships.length !== 1) {
    throw Object.assign(new Error(`Cluster ${key} mixes ownerships: ${ownerships.join(', ')}`), {
      code: 'RUNNER_ERROR',
      failureCode: 'CLUSTER_OWNERSHIP_CONFLICT'
    });
  }
  const stages = Array.from(new Set(results.map((result) => result.failureStage))).sort();
  const risks = Array.from(new Set(results.map((result) => result.riskLevel || 'UNKNOWN')))
    .sort((left, right) => RISK_ORDER[left] - RISK_ORDER[right]);
  const failureCodes = Array.from(new Set(results.map((result) => result.failureCode))).sort();
  const assertionNames = Array.from(new Set(results.flatMap(failedAssertionNames))).sort();
  const capabilities = Array.from(new Set(results.flatMap((result) => (
    result.surfaceEvidence && result.surfaceEvidence.missingCapabilities || []
  )))).sort();
  const actualRoutes = Array.from(new Set(results.map((result) => (
    result.routeEvidence && result.routeEvidence.actualRoute || ''
  )).filter(Boolean))).sort();
  const expectedRoutes = Array.from(new Set(results.map((result) => (
    result.expectedRoute || ''
  )).filter(Boolean))).sort();
  const ownershipName = ownerships[0];
  const risk = risks[0] || 'UNKNOWN';
  const caseIds = results.map((result) => result.caseId).sort();
  return {
    caseCount: caseIds.length,
    caseIds,
    clusterId: stableHash({
      actualRoutes,
      assertionNames,
      capabilities,
      failureCodes,
      key,
      ownershipName
    }, 'record-e2e-cluster-v1'),
    confirmedFacts: [
      `${caseIds.length}条Case在双轮全量中得到相同Case/Lane语义`,
      `最早失败层：${stages.join(', ')}`,
      `Ownership：${ownershipName}`
    ].concat(capabilities.length ? [`页面缺失能力：${capabilities.join(', ')}`] : []),
    failureCodes,
    failureOwnership: ownershipName,
    primaryFailureStage: stages.length === 1 ? stages[0] : stages,
    recommendedNextAction: recommendedNextAction(ownershipName, risk),
    risk,
    sharedEvidence: {
      actualRoutes,
      assertionNames,
      capabilities,
      expectedRoutes
    },
    suspectedRootArea: suspectedRootArea(key, ownershipName),
    title: clusterTitle(key),
    unconfirmedFacts: CANDIDATE_OWNERSHIPS.has(ownershipName)
      ? ['责任归属仍是测试合同/映射候选，尚未授权修改Case或产品。']
      : ['尚未证明同一根因覆盖Cluster之外的其他Case。']
  };
}

function queuePriority(cluster) {
  const confirmed = cluster.failureOwnership.startsWith('CONFIRMED_');
  const productP0 = confirmed && cluster.risk === 'P0';
  if (productP0 && ![
    'CONFIRMED_PRODUCT_CAPABILITY_GAP',
    'CONFIRMED_CONFIRMATION_DEFECT'
  ].includes(cluster.failureOwnership)) return 1;
  if (productP0) return 2;
  if (confirmed) return 3;
  return 4;
}

function clusterFailures(results) {
  const failures = results.filter((result) => result.caseStatus === 'CASE_FAIL');
  const grouped = new Map();
  failures.forEach((result) => {
    if (!result.failureOwnership) {
      throw Object.assign(new Error(`${result.caseId} has no failureOwnership`), {
        code: 'RUNNER_ERROR',
        failureCode: 'FAILURE_OWNERSHIP_MISSING'
      });
    }
    const key = clusterKey(result);
    grouped.set(key, (grouped.get(key) || []).concat(result));
  });
  const clusters = Array.from(grouped.entries()).map(([key, items]) => buildCluster(key, items));
  const clusteredIds = clusters.flatMap((cluster) => cluster.caseIds);
  if (clusteredIds.length !== failures.length
    || new Set(clusteredIds).size !== failures.length) {
    throw Object.assign(new Error('Failure clustering lost or duplicated Case IDs'), {
      code: 'RUNNER_ERROR',
      failureCode: 'CLUSTER_COVERAGE_ERROR'
    });
  }
  clusters.sort((left, right) => (
    queuePriority(left) - queuePriority(right)
    || RISK_ORDER[left.risk] - RISK_ORDER[right.risk]
    || right.caseCount - left.caseCount
    || left.clusterId.localeCompare(right.clusterId)
  ));
  return {
    caseFailCount: failures.length,
    clusteredCaseCount: clusteredIds.length,
    clusters,
    repairQueue: clusters.map((cluster, index) => ({
      affectedCaseCount: cluster.caseCount,
      clusterId: cluster.clusterId,
      priority: queuePriority(cluster),
      queueOrder: index + 1,
      recommendedNextAction: cluster.recommendedNextAction,
      risk: cluster.risk,
      suspectedRootArea: cluster.suspectedRootArea,
      title: cluster.title
    }))
  };
}

module.exports = {
  clusterFailures,
  clusterKey,
  queuePriority
};
