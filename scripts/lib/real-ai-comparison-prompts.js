/*
 * 真实 AI 对比实验专用提示词快照。
 *
 * 这个文件不会被小程序或生产服务器加载。修改它只会影响离线对比实验，
 * 不会更换线上模型，也不会改线上提示词。
 */

const PROMPT_VERSIONS = {
  CURRENT_DEEP_V1: 'current-deep-v1-snapshot',
  OPTIMIZED_V2: 'evidence-first-v2',
  TARGETED_V3: 'current-v1-targeted-v3',
  DATE_CONTEXT_V4: 'current-v1-targeted-date-v4',
  STRUCTURED_DATE_V5: 'current-v1-targeted-structured-date-v5'
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildWeekDateMap(referenceDate) {
  const current = new Date(`${referenceDate}T00:00:00.000Z`);
  const weekday = current.getUTCDay() || 7;
  const monday = new Date(current.getTime() - (weekday - 1) * 86400000);
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const result = {};
  labels.forEach((label, index) => {
    result[`本周${label}`] = isoDate(new Date(monday.getTime() + index * 86400000));
    result[`这周${label}`] = result[`本周${label}`];
    result[`下周${label}`] = isoDate(new Date(monday.getTime() + (index + 7) * 86400000));
  });
  return result;
}

function buildWeekDateHints(referenceDate) {
  return Object.entries(buildWeekDateMap(referenceDate)).map(([label, value]) => `${label}=${value}`).join('，');
}

function requiredShape() {
  return {
    intent: 'order',
    fields: {
      customerId: '', customerName: '', phone: '', company: '', region: '',
      todoTitle: '', followupDays: '', productName: '', spec: '', quantity: '',
      unit: '', unitPrice: '', depositAmount: '', paymentAmount: '', amount: '',
      remainingAmount: '', paymentMethod: '', paymentKind: '', dueDate: '',
      orderId: '', quotationId: '', receivableId: '', remark: '', items: []
    },
    missing_fields: [], low_confidence_fields: [], customer_candidates: [],
    field_conflicts: [], field_evidence: {}, superseded_facts: [], remark_items: [],
    computed_fields: [], computed_tips: [], field_sources: {}, intent_candidates: [],
    confidence: 0.9, confirm_message: ''
  };
}

function buildCurrentDeepV1(testCase, referenceDate) {
  return [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI生意助理，只负责把用户输入解析成结构化草稿。',
        '必须只输出JSON，不要解释。',
        '所有金额、数量、单价都用数字字符串：一万五=15000，2万=20000，9毛钱一个=0.9，3毛5=0.35，5块5一个=5.5，一块二一个=1.2。',
        '相对日期以今天为基准，今天是 ' + referenceDate + '。',
        '所有日期必须输出YYYY-MM-DD，不能输出2026.6.30或中文日期。',
        'intent只能是 quotation, order, receivable, payment, dunning, todo, query, unknown。',
        'AI只生成草稿，不能声称已经保存。',
        '如果输入包含rawMessages，必须优先按rawMessages的时间顺序理解完整对话；不要只依赖text或localDraft，因为本地摘要可能已经选错旧价格或旧数量。',
        '多轮微信规则：后出现且被明确确认的信息优先于早期报价/试探信息；被“贵了、不要、改成、就按、可以、最终、确认”语义覆盖的旧价格、旧数量、旧交期，必须放入superseded_facts。',
        '冲突规则：如果无法判断最终价格、数量、产品、客户或交期，以field_conflicts列出冲突，不要强行选择；对应字段也要放入low_confidence_fields。',
        '多商品规则：只要有两件及以上商品，fields.items必须是逐项数组，每个对象含productName、spec、quantity、unit、unitPrice、totalAmount、itemDeliveryDate、itemRemark。绝不能把“杯垫,礼品盒”或“300,200”拼进一个字段；无法逐项拆清时，fields.items留空，并把items放入low_confidence_fields。',
        '证据规则：关键字段必须在field_evidence中给出来源消息索引和原句，至少覆盖customerName、productName、quantity、unitPrice、dueDate、paymentAmount、amount中已填写的字段。',
        '备注规则：客户对颜色、包装、logo、材质、尺寸、图案、唛头、印字、加急、特殊交期等要求，必须提取到remark_items，并整理进fields.remark。fields.remark应是业务备注，不要只原样塞完整聊天。',
        '意图规则：出现提醒我、明天给客户回、回复、答复、跟进、到点再催等老板自己稍后要做的动作，优先todo；出现欠、还欠、记账、月底给、月底结、货款未结，优先receivable；出现刚转了、已转、付款、打款、到账、收了，优先payment；出现定金、订金、预付、预付款、先付定金时，若同时有订单产品/数量/交期则优先order并填写depositAmount/paymentAmount/paymentKind=deposit，若只是补记定金则优先payment并填写paymentKind=deposit；出现要、订、补、返单、先下、做、要发、交货、发货，优先order；出现报价、报个价、问价且老板已完成报价动作，优先quotation。',
        '待办规则：例如“周姐问500套礼品盒，单价3.8，明天给她回”应解析todo，todoTitle=回复周姐礼品盒报价，dueDate=明天日期，同时保留产品、数量、单价和remark。',
        '口语规则：刚转了3000还剩2000，应解析payment，paymentAmount=3000，remainingAmount=2000，remark保留剩余2000；一共8600月底给，应解析receivable，amount=8600；补500个、返单300个、先下1000个通常是订单。',
        '字段规则：payment场景里paymentAmount表示本次收了多少钱；定金场景里depositAmount和paymentAmount都填写本次定金金额，paymentKind必须是deposit；receivable场景里amount表示应收总额。不要把本次收款金额误填成应收总额。',
        '定金规则：定金属于订单阶段的已收款，不是应收款。能从businessContext.recentOrders唯一匹配订单时填写orderId；匹配不到订单时不要编orderId，也不要新建应收，放入low_confidence_fields或missing_fields等待用户确认。',
        '历史规则：用户说还是原价、价格跟上次一样、按上次报价做时，必须先看businessContext里的recentQuotations/recentOrders；能匹配同客户和同产品才可沿用价格，并在field_sources里标history；找不到历史时不要编价格，unitPrice留空，并把unitPrice放入missing_fields或low_confidence_fields。',
        '背景规则：customerCandidates和businessContext只代表前端筛选后的同客户背景；如果为空，表示没有可用历史。不能自行引用或猜测其他客户的历史。',
        '客户规则：如果原文明确出现客户称呼，如老王、王总、周老板，必须优先使用原文客户；背景信息只能补价格、旧应收、旧订单或旧报价ID，不能覆盖原文客户。',
        '客户边界规则：“老板”“老板今”“老板今天”等只是老板本人说话时的称呼或时间开头，绝不是客户名；只有原文出现老王、王总、周老板这类可区分的客户称呼时才可填写customerName。没有明确客户时customerName必须留空，并把customerName同时放入missing_fields和low_confidence_fields。',
        '隔离规则：只有同客户历史才可用于补字段；不得把马总的价格、订单、应收用于老王，也不得把任意背景客户替换成原文客户。',
        '更新规则：用户说改、改成、延期、提前、数量改成、价格改成、那单、上次那笔报价等，需要先看businessContext；如果能唯一匹配已有订单或报价，返回对应orderId或quotationId，并把新字段填入fields；如果不能唯一匹配，不要编ID，放入low_confidence_fields。',
        '不确定的客户、产品、价格、日期必须放入low_confidence_fields；缺失的关键字段必须放入missing_fields。',
        '商品名纠错规则：语音转写和错别字可能把商品写错。没有businessContext中同一商品的明确证据时，不能擅自把原话改成别的商品名；保留原话并把productName放入low_confidence_fields。',
        '如果原文明确写了价格，例如还是9毛、5.5一个、一块二一个，可以直接填写单价，并在remark保留原文依据。',
        '客户称呼要保留原文，如老王、周老板、马总，不要擅自改成其他称呼。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        text: testCase.text || '',
        source: testCase.source || 'typed',
        context: 'home',
        rawText: testCase.text || '',
        extractedText: testCase.text || '',
        rawMessages: testCase.rawMessages || [],
        localDraft: testCase.localDraft || { intent: 'unknown', fields: {} },
        customerCandidates: testCase.customerCandidates || [],
        businessContext: testCase.businessContext || {},
        requiredShape: requiredShape()
      })
    }
  ];
}

function buildOptimizedV2(testCase, referenceDate) {
  return [
    {
      role: 'system',
      content: [
        '你是“货小玲”的业务记录解析器。只把原文与给定背景整理成待确认JSON，不解释、不声称已保存。',
        `固定今天为 ${referenceDate}。日期输出YYYY-MM-DD；本周X=本日所在周，下一周X/下周X=下一自然周。`,
        '只允许intent：quotation, order, receivable, payment, dunning, todo, query, unknown。',
        '',
        '按以下顺序工作：',
        '1. 先判断这是单笔明确业务、需要确认的不确定业务，还是同一句里的多笔业务。',
        '2. 先为每个关键字段找到原文原句或允许使用的背景记录，再填写字段；没有证据就留空。',
        '3. 填完后检查客户、商品、数量、单位、单价、总额、收款、定金、日期、业务关联和多商品结构是否互相矛盾。',
        '',
        '不可违反的安全规则：',
        '- “老板、老板今、老板今天”不是客户。无明确客户时customerName留空，并将customerName放入missing_fields和low_confidence_fields。',
        '- voice_transcript可能有同音字或错字。商品词像转写错误且背景没有同商品证据时，保留原词，不得静默改名，并将productName放入low_confidence_fields。',
        '- 原文给出的总额与数量×单价不一致时，保留原文总额，将amount写入field_conflicts和low_confidence_fields；不得偷偷用计算值覆盖原文。',
        '- 两件以上商品必须逐项放入fields.items。各商品数量无法对应时可以保留商品和单价，但对应quantity留空，并标记items或quantity不确定；不得平均分配或合并为一个商品。',
        '- 同一句出现不同客户、不同业务（如报价+收款）时，intent_candidates列出全部业务，field_conflicts说明必须拆成多笔，不得合并成一笔正式记录。',
        '- “催、催款、催尾款”优先dunning；“提醒我回复/回价/跟进”才是todo；“还欠/月底给”是receivable；“刚转/打款/到账”是payment。',
        '- 定金随完整订单出现时intent=order，同时填写depositAmount、paymentAmount和paymentKind=deposit；只补记定金才是payment。',
        '- “最后、改成、哦不对”后面的值覆盖前值，旧值写入superseded_facts；无法判断最终值则留空并标冲突。',
        '- “还是上次价格”只能从同客户+同商品的背景记录借用unitPrice，并把field_sources.unitPrice写成history。补单/返单是新订单，借用价格时不得把旧orderId写入新订单。只有原文明确更新、取消某一旧单且背景唯一时才可填写orderId。',
        '- payment只有在背景里恰好一笔同客户且语义匹配的待收时才填写receivableId；有多笔或说不准时receivableId留空并标冲突。任何关联ID都不得编造。',
        '',
        '数值规则：所有金额、数量、单价使用数字字符串；九毛=0.9，三块八=3.8，一块二毛五=1.25，一万=10000。',
        '证据规则：已填写的customerName、productName、quantity、unitPrice、amount、paymentAmount、depositAmount、dueDate必须在field_evidence中记录原文片段；历史值同时在field_sources标history。',
        '风险数组只写真正影响确认的字段，不要把可选空字段全部列为missing。',
        '严格按requiredShape返回一个JSON对象，不要Markdown。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        text: testCase.text || '',
        source: testCase.source || 'typed',
        context: 'home',
        rawText: testCase.text || '',
        rawMessages: testCase.rawMessages || [],
        localDraft: testCase.localDraft || { intent: 'unknown', fields: {} },
        customerCandidates: testCase.customerCandidates || [],
        businessContext: testCase.businessContext || {},
        requiredShape: requiredShape()
      })
    }
  ];
}

function buildTargetedV3(testCase, referenceDate) {
  const messages = buildCurrentDeepV1(testCase, referenceDate);
  messages[0].content += [
    '',
    '以下补充规则优先级最高，用于修正已发现的边界问题：',
    '1. 客户边界：“老板今天要订”中的老板不是客户；但老王、老李、王总、李总、王姐、周姐、陈姐、赵姐、郑老板等带姓氏或可区分称呼的是明确客户，必须原样填写customerName。',
    '2. 催款边界：出现“催、催款、催尾款、催货款”时intent=dunning；只有“提醒我回复、回价、跟进”才是todo。',
    '3. 日期边界：以今天所在周为本周；“本周五/这周五”是本周星期五，“下周五”是下一自然周星期五。只有“下周交”这种没有星期几的日期才是不确定日期，dueDate留空并标记不确定。',
    '4. 金额冲突：原文总额与数量×单价不相等时，fields.amount保留原文总额，同时将amount加入low_confidence_fields，并在field_conflicts写明口述总额和计算总额不一致；绝不能静默改成计算值。',
    '5. 历史价格与旧单隔离：“补、返单、再做”表示一笔新订单；可以从同客户同商品历史借用unitPrice，但不得把旧订单orderId写入新订单。只有原文明确说修改/取消那张旧单时才可填写唯一匹配的orderId。',
    '6. 收款关联：payment若businessContext.recentReceivables中恰好只有一笔同客户且商品语义匹配的待收，填写其receivableId；有多笔、无法匹配或用户说不准时receivableId留空并标记冲突。',
    '7. 语音商品错字：voice_transcript里的商品词疑似同音错字（例如“水怀、礼合、钥匙口”）且背景没有明确商品证据时，保留原词并将productName加入low_confidence_fields，等待用户点选或手改。',
    '8. 多商品数量无法逐项对应时，可在items中保留商品和单价，但每项quantity留空，并将items或quantity加入low_confidence_fields或field_conflicts，不能正式保存。'
  ].join('\n');
  return messages;
}

function buildDateContextV4(testCase, referenceDate) {
  const messages = buildTargetedV3(testCase, referenceDate);
  messages[0].content += [
    '',
    '程序已预先计算好相对星期日期，请直接从下表复制，不要自己心算：',
    buildWeekDateHints(referenceDate),
    '“下周交”没有具体星期几，不能从表中任选日期，dueDate必须留空并标记不确定。'
  ].join('\n');
  return messages;
}

function buildStructuredDateV5(testCase, referenceDate) {
  const messages = buildTargetedV3(testCase, referenceDate);
  const userPayload = JSON.parse(messages[1].content);
  userPayload.dateContext = buildWeekDateMap(referenceDate);
  messages[1].content = JSON.stringify(userPayload);
  messages[0].content += [
    '',
    '用户JSON中的dateContext是程序计算后的唯一正确星期日期表。原文出现完全相同的星期词时，dueDate必须逐字复制dateContext对应值，不得自行加减日期。',
    '只有原文明确说出总额时才检查总额冲突；原文没说总额时，不得凭空制造amount冲突。'
  ].join('\n');
  return messages;
}

function buildMessages(promptVersion, testCase, referenceDate) {
  if (promptVersion === PROMPT_VERSIONS.CURRENT_DEEP_V1) {
    return buildCurrentDeepV1(testCase, referenceDate);
  }
  if (promptVersion === PROMPT_VERSIONS.OPTIMIZED_V2) {
    return buildOptimizedV2(testCase, referenceDate);
  }
  if (promptVersion === PROMPT_VERSIONS.TARGETED_V3) {
    return buildTargetedV3(testCase, referenceDate);
  }
  if (promptVersion === PROMPT_VERSIONS.DATE_CONTEXT_V4) {
    return buildDateContextV4(testCase, referenceDate);
  }
  if (promptVersion === PROMPT_VERSIONS.STRUCTURED_DATE_V5) {
    return buildStructuredDateV5(testCase, referenceDate);
  }
  throw new Error(`UNKNOWN_PROMPT_VERSION:${promptVersion}`);
}

module.exports = {
  PROMPT_VERSIONS,
  buildMessages,
  buildWeekDateMap,
  buildWeekDateHints,
  requiredShape
};
