const TITLES = [
  '首页新客户单商品订单成功保存',
  '首页已有客户单商品订单成功保存',
  '首页正式保存动作真实执行一次',
  '首页 saveState 真实调用一次',
  '首页订单只新增一张',
  '首页客户按合同新增或复用',
  '首页商品目录副作用精确可观测',
  '首页保存后显示成功',
  '首页保存后从真实存储重新读取成功',
  '完整页新客户单商品订单成功保存',
  '完整页已有客户单商品订单成功保存',
  '完整页确认卡字段与最终订单一致',
  '完整页用户确认字段作为最终保存字段',
  '完整页 saveFormal 真实执行一次',
  '完整页 saveState 真实调用一次',
  '订单 customerId 指向正确客户',
  '订单 items 恰好一项',
  '商品名数量单位单价和小计正确',
  '顶层兼容字段与 items[0] 一致',
  '订单 totalAmount 正确',
  '交期字段按普通订单合同保存',
  '普通新订单初始状态正确',
  '订单 originalText 完整保留',
  '创建时间和更新时间存在且合理',
  '订单进度只新增一次',
  '解析日志按正式合同精确新增',
  '普通订单不新增报价',
  '普通订单不新增待收款',
  '普通订单不新增收款',
  '普通订单不新增定金',
  '普通订单不新增待办',
  '普通订单不新增待整理',
  '普通订单不修改无关客户和订单',
  '保存后订单列表能看到新订单',
  '列表客户商品金额交期和状态正确',
  '点击后订单详情可以打开',
  '详情字段来自重读持久化数据',
  '详情 originalText 正确',
  '页面重开后仍只存在同一订单',
  '应用重启后订单仍然存在',
  '重启不新增订单',
  '重启不新增版本或收据',
  '同一次页面连续点击只正式保存一次',
  '同一事务精确重放零业务增量',
  '两个旧快照最多一个提交成功',
  '被拒绝的旧快照不能覆盖新数据',
  '主存储写入前失败保持完整旧状态',
  '主存储写后读回失败按事务合同恢复',
  '保存失败不留下半张订单',
  '保存失败不留下孤立客户',
  '保存失败不留下错误进度或解析日志',
  '保存失败页面不得显示业务成功',
  '故障后日志备份和锁状态符合事务合同',
  '未执行页面正式保存不能冒充页面成功',
  '页面保存返回失败不能以内存构造判成功',
  '报告区分页面动作隔离重放真实提交和重读'
];

const GROUPS = [
  [1, 9, 'HOME_QUICK'],
  [10, 15, 'FULL_PAGE'],
  [16, 26, 'FIELD_INTEGRITY'],
  [27, 33, 'SCOPE_BOUNDARY'],
  [34, 39, 'LIST_AND_DETAIL'],
  [40, 46, 'RESTART_AND_IDEMPOTENCY'],
  [47, 53, 'FAILURE_AND_ROLLBACK'],
  [54, 56, 'NO_SILENT_BYPASS']
];

function groupFor(number) {
  const match = GROUPS.find(([start, end]) => number >= start && number <= end);
  return match && match[2] || '';
}

function scenarioFor(number) {
  if ([40, 41, 42].includes(number)) return 'APP_RESTART';
  if (number === 43) return 'DOUBLE_CLICK';
  if (number === 44) return 'EXACT_TRANSACTION_REPLAY';
  if ([45, 46].includes(number)) return 'CONCURRENT_SNAPSHOTS';
  if ([47, 49, 50, 51, 52, 53].includes(number)) return 'PRIMARY_WRITE_FAULT';
  if (number === 48) return 'READBACK_FAULT';
  if (number === 54) return 'NO_PAGE_ACTION';
  if (number === 55) return 'BUSINESS_RETURN_ERROR';
  if (number === 56) return 'REPORT_DISTINCTION';
  if (number === 39) return 'PAGE_RELOAD';
  return 'NORMAL_SAVE';
}

function surfaceFor(number) {
  if (number <= 9 || [43, 47, 50, 52, 54, 56].includes(number)) return 'HOME_QUICK';
  return 'FULL_PAGE';
}

function fixtureFor(number) {
  if ([2, 6, 11, 16].includes(number)) return 'sio-existing-customer-v1';
  if (number >= 27 && number <= 33) return 'sio-unrelated-business-v1';
  return 'sio-empty-v1';
}

function sampleFor(fixtureRef) {
  if (fixtureRef === 'sio-existing-customer-v1') {
    return {
      customerId: 'sio-customer-li',
      customerName: '李姐',
      dueDate: '2026-08-12',
      input: '李姐订200个文件袋，每个4元，8月12日交。',
      productName: '文件袋',
      quantity: '200',
      totalAmount: '800',
      unit: '个',
      unitPrice: '4'
    };
  }
  if (fixtureRef === 'sio-unrelated-business-v1') {
    return {
      customerId: '',
      customerName: '赵老板',
      dueDate: '2026-08-15',
      input: '赵老板订300个杯垫，每个2元，8月15日交。',
      productName: '杯垫',
      quantity: '300',
      totalAmount: '600',
      unit: '个',
      unitPrice: '2'
    };
  }
  return {
    customerId: '',
    customerName: '王总',
    dueDate: '2026-08-10',
    input: '王总订100个水杯，每个8元，8月10日交。',
    productName: '水杯',
    quantity: '100',
    totalAmount: '800',
    unit: '个',
    unitPrice: '8'
  };
}

function productionGapFor(number) {
  if (number <= 15) return '若失败，真实页面输入、确认或正式保存链路未完整执行。';
  if (number <= 26) return '若失败，正式订单字段、进度或解析日志没有按合同持久化。';
  if (number <= 33) return '若失败，普通订单保存越界修改了范围外业务集合。';
  if (number <= 39) return '若失败，持久化订单未被真实列表或详情页面正确读取。';
  if (number <= 46) return '若失败，重启、重复动作、精确重放或旧快照并发不安全。';
  if (number <= 53) return '若失败，保存故障可能留下半截数据、脏事务状态或错误成功提示。';
  return '若失败，测试报告可能把内存构造或隔离重放误报成真实页面保存。';
}

function buildCase(number) {
  const fixtureRef = fixtureFor(number);
  const sample = sampleFor(fixtureRef);
  const entrySurface = surfaceFor(number);
  const scenario = scenarioFor(number);
  const expectedSaveStateCalls = scenario === 'NO_PAGE_ACTION' || scenario === 'BUSINESS_RETURN_ERROR'
    ? 0
    : (scenario === 'CONCURRENT_SNAPSHOTS' ? 2 : 1);
  return {
    caseId: `REC-E2E-SIO-${String(number).padStart(3, '0')}`,
    title: TITLES[number - 1],
    group: groupFor(number),
    riskLevel: number <= 56 ? 'P0' : 'P1',
    fixtureRef,
    entrySurface,
    scenario,
    expectedProfile: `SIO_${String(number).padStart(3, '0')}`,
    sample,
    contract: {
      initialPersistentState: fixtureRef === 'sio-empty-v1'
        ? '业务集合为空，只有已完成初始化的本地用户元数据。'
        : (fixtureRef === 'sio-existing-customer-v1'
          ? '存在唯一同名客户，订单及范围外集合为空。'
          : '存在一名无关客户和一张无关旧订单，目标客户尚不存在。'),
      input: sample.input,
      pageEntry: entrySurface === 'HOME_QUICK' ? '首页快速记一笔' : '完整记一笔页面',
      expectedParseRoute: 'local',
      expectedAiCalls: 0,
      expectedConfirmationFields: {
        customerName: sample.customerName,
        productName: sample.productName,
        quantity: sample.quantity,
        unit: sample.unit,
        unitPrice: sample.unitPrice,
        totalAmount: sample.totalAmount,
        dueDate: sample.dueDate
      },
      expectedPageFormalSaveCalls: ['NO_PAGE_ACTION', 'CONCURRENT_SNAPSHOTS'].includes(scenario) ? 0 : 1,
      expectedSaveStateCalls,
      expectedCommitResult: scenario === 'READBACK_FAULT'
        ? 'ONE_CONFIRMED_COMMIT_AFTER_READBACK_RECOVERY'
        : (['PRIMARY_WRITE_FAULT', 'BUSINESS_RETURN_ERROR', 'NO_PAGE_ACTION'].includes(scenario)
          ? 'NO_COMMIT'
          : 'ONE_COMMIT_OR_EXPLICIT_REPLAY'),
      expectedPersistentState: scenario === 'READBACK_FAULT'
        ? '一次损坏读回后再次核验，最终只能是完整新状态或完整旧状态；本夹具应确认完整新状态。'
        : (['PRIMARY_WRITE_FAULT', 'BUSINESS_RETURN_ERROR', 'NO_PAGE_ACTION'].includes(scenario)
          ? '原持久化业务状态完整不变。'
          : '新增一张且只新增一张完整普通订单。'),
      expectedListAndDetail: '成功提交时列表和详情都从真实重读状态显示同一订单。',
      expectedRestart: [40, 41, 42].includes(number)
        ? '新进程启动后仍为同一张订单且零新增提交。'
        : '本案例不要求单独启动新进程，报告明确标记未执行。',
      mustNotExist: ['报价', '待收款', '收款', '定金', '待办', '待整理', '第二张目标订单', '错误成功提示'],
      productionGap: productionGapFor(number)
    }
  };
}

const cases = TITLES.map((_, index) => buildCase(index + 1));

module.exports = { cases };
