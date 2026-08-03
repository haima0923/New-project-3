const { safeClone } = require('../../../utils/record-state-diff');
const { loadContract } = require('../single-item-order-complete-save-v1/load-contract');

const baseCase = loadContract().cases.find((item) => item.caseId === 'REC-E2E-SIO-001');

const DATE_VARIANTS = [
  {
    variantId: 'CONTROL_EXACT_INPUT',
    title: '真机无空格控制组',
    input: '赵老板订300个杯垫，每个2元，8月15日交'
  },
  {
    variantId: 'MONTH_DAY_COMPACT',
    title: '月日紧凑格式',
    input: '赵老板定了 300 个杯垫，每个 2 元，8月15日交'
  },
  {
    variantId: 'MONTH_DAY_ALL_SPACED',
    title: '月日单位全部带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 月 15 日交'
  },
  {
    variantId: 'MONTH_COMPACT_DAY_SPACED',
    title: '月后带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8月 15日交'
  },
  {
    variantId: 'MONTH_SPACED_DAY_UNIT_SPACED',
    title: '月前和日单位前带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 月15 日交'
  },
  {
    variantId: 'FULL_DATE_COMPACT',
    title: '完整年月日紧凑格式',
    input: '赵老板定了 300 个杯垫，每个 2 元，2026年8月15日交'
  },
  {
    variantId: 'FULL_DATE_ALL_SPACED',
    title: '完整年月日全部带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，2026 年 8 月 15 日交'
  },
  {
    variantId: 'SLASH_COMPACT',
    title: '斜杠紧凑格式',
    input: '赵老板定了 300 个杯垫，每个 2 元，8/15交'
  },
  {
    variantId: 'SLASH_SPACED',
    title: '斜杠两侧带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 / 15交'
  },
  {
    variantId: 'DASH_SPACED',
    title: '短横线两侧带普通空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 - 15交'
  },
  {
    variantId: 'IDEOGRAPHIC_SPACES',
    title: '日期中含全角空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8\u3000月\u300015\u3000日交'
  },
  {
    variantId: 'NO_BREAK_SPACES',
    title: '日期中含不换行空格',
    input: '赵老板定了 300 个杯垫，每个 2 元，8\u00a0月\u00a015\u00a0日交'
  },
  {
    variantId: 'SPACED_DATE_SHIP',
    title: '普通空格日期加发货动词',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 月 15 日发'
  },
  {
    variantId: 'SPACED_DATE_DELIVER',
    title: '普通空格日期加交货动词',
    input: '赵老板定了 300 个杯垫，每个 2 元，8 月 15 日交货'
  }
];

function buildCase(variant, surface, index) {
  const caseNumber = 101 + index;
  const input = variant.input;
  return {
    caseId: `REC-E2E-ODW-${String(caseNumber).padStart(3, '0')}`,
    title: `${variant.title}·${surface === 'HOME_QUICK' ? '首页' : '完整页'}`,
    group: 'DATE_WHITESPACE_COMPLETE_SAVE',
    riskLevel: 'P0',
    fixtureRef: 'sio-empty-v1',
    entrySurface: surface,
    scenario: 'NORMAL_SAVE',
    expectedProfile: 'ORDER_DATE_WHITESPACE_V1',
    variantId: variant.variantId,
    clock: {
      businessDate: '2026-08-03',
      nowInstant: '2026-08-03T02:00:00.000Z',
      timezone: 'Asia/Shanghai'
    },
    initialState: safeClone(baseCase.initialState),
    sample: {
      customerId: '',
      customerName: '赵老板',
      dueDate: '2026-08-15',
      input,
      productName: '杯垫',
      quantity: '300',
      totalAmount: '600',
      unit: '个',
      unitPrice: '2'
    },
    contract: {
      initialPersistentState: '业务集合为空，只有已完成初始化的本地用户元数据。',
      input,
      pageEntry: surface === 'HOME_QUICK' ? '首页快速记一笔' : '完整记一笔页面',
      expectedParseRoute: 'local',
      expectedAiCalls: 0,
      expectedConfirmationFields: {
        customerName: '赵老板',
        productName: '杯垫',
        quantity: '300',
        unit: '个',
        unitPrice: '2',
        totalAmount: '600',
        dueDate: '2026-08-15'
      },
      expectedPageFormalSaveCalls: 1,
      expectedSaveStateCalls: 1,
      expectedCommitResult: 'ONE_CONFIRMED_COMMIT',
      expectedPersistentState: '新增一张且只新增一张交期为2026-08-15的完整普通订单。',
      expectedListAndDetail: '列表和详情从真实重读状态显示同一订单及相同交期。',
      expectedRestart: '本矩阵不单独启动新进程；现有56条继续负责重启合同。',
      expectedDateControlInteractions: 0,
      mustNotExist: ['人工日期选择', 'fixture预填交期', 'AI补日期', '第二张目标订单', '错误成功提示'],
      productionGap: '数字、年月日单位或日期分隔符附近的空白导致明确交期未进入正式订单。'
    }
  };
}

const cases = [];
DATE_VARIANTS.forEach((variant) => {
  ['HOME_QUICK', 'FULL_PAGE'].forEach((surface) => {
    cases.push(buildCase(variant, surface, cases.length));
  });
});

module.exports = { DATE_VARIANTS, cases };
