const { isRealAiEnabled } = require('../config');
const { mockParse, mockQuery, mockTranscribe } = require('./mock');
const { resolveBusinessTimeContext } = require('../../utils/record-flow-runtime');

const COMPLEX_PARSE_PATTERN = /(?:上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|价格不变|还是|最终|最后|确认价|改成|改为|改价|改数量|延期|提前|那单|那笔|不是|不对|写错|算了|贵了|便宜|就按|客户说|他说|她说|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|换成|替换|取消|别做|先别|等确认|撤回|定金|订金|预付|尾款|欠款|还了|还剩|结清|到账|转了|付了|收了)/i;
const CRITICAL_FIELDS = ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'dueDate'];

function createAiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function extractJson(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('Empty AI response');
  try {
    return JSON.parse(source);
  } catch (error) {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

const AI_BUSINESS_FIELD_KEYS = [
  'customerId', 'customerName', 'phone', 'company', 'region', 'todoTitle', 'followupDays',
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'paymentAmount',
  'depositAmount', 'amount', 'totalAmount', 'statedAmount', 'calculatedAmount',
  'remainingAmount', 'paymentMethod', 'paymentKind', 'dueDate', 'quoteDate', 'orderId',
  'quotationId', 'receivableId', 'remark'
];
const AI_ITEM_FIELD_KEYS = [
  'productName', 'product_name', 'name', 'spec', 'quantity', 'unit', 'unitPrice', 'unit_price',
  'priceUnit', 'price_unit', 'totalAmount', 'total_amount', 'amount', 'itemDeliveryDate',
  'deliveryDate', 'dueDate', 'itemRemark', 'remark'
];

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === 'object') return Object.keys(value).some((key) => hasMeaningfulValue(value[key]));
  if (typeof value === 'boolean') return value;
  return true;
}

function hasBusinessScalar(value) {
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' && Number.isFinite(value);
}

function hasMeaningfulItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    && AI_ITEM_FIELD_KEYS.some((key) => hasBusinessScalar(item[key]));
}

function normalizeIntentCandidateValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = value.intent || value.type || value.value || value.name || value.label || '';
  }
  return String(value || '').trim().toLowerCase();
}

function getAiBusinessResultValidity(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, kind: 'empty', reason: 'AI result is not an object' };
  }
  const fields = result.fields && typeof result.fields === 'object' && !Array.isArray(result.fields)
    ? result.fields
    : result;
  const intent = String(result.intent || '').trim().toLowerCase();
  const knownIntent = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'query']
    .includes(intent);
  const hasBusinessField = AI_BUSINESS_FIELD_KEYS.some((key) => (
    hasBusinessScalar(fields[key]) || (fields !== result && hasBusinessScalar(result[key]))
  ));
  const fieldEvidence = result.field_evidence || result.fieldEvidence || {};
  const fieldSources = result.field_sources || result.fieldSources || {};
  const hasBusinessEvidence = AI_BUSINESS_FIELD_KEYS.concat('items').some((key) => (
    hasMeaningfulValue(fieldEvidence[key])
    || /^(?:history|source|original|message|user|local)(?::|$)/i.test(String(fieldSources[key] || '').trim())
  ));
  const items = fields.items || fields.lineItems || fields.line_items || fields.products || fields.goods
    || result.items || result.lineItems || result.line_items || result.products || result.goods;
  const hasItems = Array.isArray(items) && items.some(hasMeaningfulItem);
  const hasSafetyFinding = [
    result.missing_fields || result.missingFields,
    result.low_confidence_fields || result.lowConfidenceFields,
    result.field_conflicts || result.fieldConflicts
  ].some((value) => hasMeaningfulValue(value));
  const rawIntentCandidates = result.intent_candidates || result.intentCandidates || [];
  const intentCandidates = Array.from(new Set(
    (Array.isArray(rawIntentCandidates) ? rawIntentCandidates : [rawIntentCandidates])
      .map(normalizeIntentCandidateValue)
      .filter(Boolean)
  ));
  const hasIntentUncertainty = intentCandidates.length > 1
    || (intentCandidates.length > 0 && (!intent || intent === 'unknown'
      || intentCandidates.some((candidate) => candidate !== intent)));
  const explicitDecision = String(result.decision || result.status || '').trim().toLowerCase();
  const explicitDecisionReason = result.confirm_message || result.confirmMessage || result.reason || result.message;
  const explicitlyNotRecordable = result.no_record === true
    || result.recordable === false
    || (['no_record', 'needs_user_confirm', 'needs_ai', 'pending'].includes(explicitDecision)
      && hasMeaningfulValue(explicitDecisionReason));
  const hasUnknownConclusion = intent === 'unknown'
    && hasMeaningfulValue(explicitDecisionReason);

  if (hasSafetyFinding || hasIntentUncertainty || explicitlyNotRecordable || hasUnknownConclusion
    || (intent === 'unknown' && (hasBusinessField || hasItems))) {
    return { valid: true, kind: 'uncertain', reason: 'AI returned an explicit safety decision' };
  }
  if (knownIntent || ((hasBusinessField || hasItems) && hasBusinessEvidence)) {
    return { valid: true, kind: 'business', reason: 'AI returned a business decision or field' };
  }
  return { valid: false, kind: 'empty', reason: 'AI returned no business decision, field, or safety finding' };
}

function assertAiBusinessResult(result) {
  const validity = getAiBusinessResultValidity(result);
  if (!validity.valid) {
    throw createAiError('AI_RESPONSE_EMPTY_BUSINESS', validity.reason);
  }
  return validity;
}

function compactStateForPrompt(state) {
  const safeState = state || {};
  return {
    customers: (safeState.customers || []).slice(0, 50),
    quotations: (safeState.quotations || []).slice(0, 50),
    orders: (safeState.orders || []).slice(0, 50),
    receivables: (safeState.receivables || []).slice(0, 50),
    paymentRecords: (safeState.paymentRecords || []).slice(0, 50),
    todos: (safeState.todos || []).slice(0, 50),
    pendingNotes: (safeState.pendingNotes || []).slice(0, 20)
  };
}

function chatCompletion(config, messages, options = {}) {
  const url = `${config.aiBaseUrl}/chat/completions`;
  const timeoutMs = Number(options.timeoutMs || config.aiQualityRequestTimeoutMs || 20000);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.aiApiKey}`
    },
    body: JSON.stringify({
      model: options.model || config.aiModel,
      messages,
      temperature: 0.1,
      // 记一笔需要稳定 JSON，而不是展示推理过程。通义混合思考模型默认会思考，
      // 明确关闭可避免不必要的等待和 token 消耗；复杂内容由更强的 Plus 模型处理。
      enable_thinking: false,
      response_format: { type: 'json_object' }
    }),
    signal: controller ? controller.signal : undefined
  })
    .then((res) => {
      if (!res.ok) {
        return res.text().then((body) => {
          throw createAiError('AI_PROVIDER_UNAVAILABLE', `AI HTTP ${res.status}: ${body}`);
        });
      }
      return res.json();
    })
    .then((data) => {
      const content = data
        && data.choices
        && data.choices[0]
        && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      try {
        return extractJson(content);
      } catch (error) {
        throw createAiError('AI_RESPONSE_INVALID', 'AI did not return valid JSON');
      }
    })
    .catch((error) => {
      if (error && error.name === 'AbortError') {
        throw createAiError(options.timeoutCode || 'AI_PROVIDER_TIMEOUT', 'AI request timed out');
      }
      if (error && error.code) throw error;
      if (error && /json|empty ai response/i.test(error.message || '')) {
        throw createAiError('AI_RESPONSE_INVALID', 'AI did not return valid JSON');
      }
      if (error) error.code = 'AI_PROVIDER_UNAVAILABLE';
      throw error;
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
}

function getPayloadText(payload = {}) {
  return String(payload.rawText || payload.text || '').trim();
}

function hasHistoryContext(payload = {}) {
  const context = payload.businessContext || {};
  return Object.keys(context).some((key) => Array.isArray(context[key]) && context[key].length > 0);
}

function hasCriticalUncertainty(fields = []) {
  return (fields || []).some((field) => CRITICAL_FIELDS.includes(field));
}

function isSimpleFastParse(payload = {}) {
  const localDraft = payload.localDraft || {};
  const fields = localDraft.fields || {};
  const text = getPayloadText(payload);
  const lines = text.split(/\n/).filter(Boolean);
  const rawMessages = Array.isArray(payload.rawMessages) ? payload.rawMessages : [];
  const intent = localDraft.intent || 'unknown';

  // 手动输入若仍需 AI，通常已触发不确定、历史或冲突规则，直接走更强模型。
  if (!['voice', 'paste'].includes(payload.source)) return false;
  if (!text || text.length > 120 || lines.length > 1 || rawMessages.length > 1) return false;
  if (COMPLEX_PARSE_PATTERN.test(text) || hasHistoryContext(payload)) return false;
  if ((localDraft.field_conflicts || []).length || hasCriticalUncertainty(localDraft.low_confidence_fields)) return false;
  if ((localDraft.items || []).length > 1 || (fields.items || []).length > 1) return false;

  // 收款、待收和定金关系会影响账目，始终让 Plus 处理。
  if (['payment', 'receivable'].includes(intent) || fields.depositAmount || fields.paymentKind === 'deposit') return false;

  if (['quotation', 'order'].includes(intent)) {
    return Boolean(fields.customerName && fields.productName && fields.quantity && fields.unitPrice);
  }
  if (intent === 'todo') return Boolean(fields.todoTitle);
  return false;
}

function selectParseModel(config, payload = {}) {
  if (payload.reviewMode === 'deep') return { model: config.aiModel, tier: 'quality', canEscalate: false };
  return { model: config.aiFastModel || config.aiModel, tier: 'fast', canEscalate: false };
}

function shouldEscalateFastResult(result = {}) {
  const fields = result.fields || {};
  if (!result || result.intent === 'unknown') return true;
  if ((result.field_conflicts || []).length) return true;
  if (hasCriticalUncertainty(result.low_confidence_fields)) return true;
  if (hasCollapsedMultiItemValues(fields)) return true;
  if (['quotation', 'order'].includes(result.intent)) {
    return !(fields.customerName && fields.productName && fields.quantity && fields.unitPrice);
  }
  return false;
}

function hasCollapsedMultiItemValues(fields = {}) {
  return ['productName', 'quantity', 'unit', 'unitPrice', 'amount', 'totalAmount']
    .some((field) => typeof fields[field] === 'string' && /[，,、；;]/.test(fields[field]))
    && !((fields.items || fields.lineItems || fields.line_items || []).length > 1);
}

function markCollapsedMultiItems(result = {}) {
  const fields = result.fields || {};
  if (!hasCollapsedMultiItemValues(fields)) return result;
  const conflicts = Array.isArray(result.field_conflicts) ? result.field_conflicts.slice() : [];
  if (!conflicts.some((item) => item && item.field === 'items')) {
    conflicts.push({
      field: 'items',
      message: 'AI 没有逐项返回多件商品，不能把多件商品合并成一条保存。'
    });
  }
  const low = Array.isArray(result.low_confidence_fields) ? result.low_confidence_fields.slice() : [];
  if (!low.includes('items')) low.push('items');
  return Object.assign({}, result, {
    field_conflicts: conflicts,
    low_confidence_fields: low
  });
}

function withParseMetadata(result, config, selection, escalated) {
  return Object.assign({}, result, {
    provider: config.aiProvider || 'ai',
    ai_model: escalated ? config.aiModel : selection.model,
    ai_model_tier: escalated ? 'quality' : selection.tier,
    ai_escalated: Boolean(escalated),
    ai_review_mode: selection.tier === 'quality' ? 'deep' : 'standard',
    ai_business_result_valid: true
  });
}

function buildFastParseMessages(payload, today) {
  return [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI生意助理，只做一次快速、保守的结构化核对。',
        '必须只输出JSON，不要解释、不要思考过程、不要声称已保存。',
        '只能根据原文填写字段；原文没有明确客户、商品、数量、价格或日期时必须留空并放入missing_fields。',
        '“老板”“老板今”“老板今天”是老板本人称呼或时间开头，绝不是客户名。',
        '数字统一用字符串；九毛=0.9，三块八=3.8；日期按今天 ' + today + ' 输出 YYYY-MM-DD。',
        'intent只能是 quotation, order, receivable, payment, dunning, todo, query, unknown。',
        '若发现改价、历史关联、多商品、聊天前后冲突、收款、欠款或定金，不要猜，放入low_confidence_fields。',
        '商品名必须以原话为准。语音转写可能有错字或口音；没有用户历史商品的明确证据时，不要擅自把商品改成另一个名称，应保留原话并把productName放入low_confidence_fields。',
        '如果出现两件及以上商品或同一商品有多个规格，必须放入fields.items数组，每个商品/规格一项；每项包含productName、spec、quantity、unit、unitPrice、priceUnit、totalAmount，禁止把多个值用逗号拼进一个字段。',
        '紫色、红色、S码、A款等明确对应商品的颜色/尺码/款式填spec；“颜色淡一点、不要色差、外箱红色”等制作或包装要求才放remark。',
        'unit是数量单位，priceUnit是单价按什么单位计价。不得自行换算单位；两者不一致时totalAmount留空，并把priceUnit放入low_confidence_fields或field_conflicts。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        text: payload.text || '',
        source: payload.source || 'typed',
        localDraft: payload.localDraft || {},
        requiredShape: {
          intent: 'order',
          fields: {
            customerName: '', productName: '', spec: '', quantity: '', unit: '', unitPrice: '', priceUnit: '', amount: '',
            paymentAmount: '', depositAmount: '', paymentKind: '', dueDate: '', remark: '', items: []
          },
          missing_fields: [], low_confidence_fields: [], field_conflicts: [], field_evidence: {},
          confidence: 0.9, confirm_message: ''
        }
      })
    }
  ];
}

function withModelTimeout(config, selection) {
  return Object.assign({}, selection, {
    timeoutMs: selection.tier === 'fast'
      ? config.aiFastRequestTimeoutMs
      : config.aiQualityRequestTimeoutMs
  });
}

function parseWithAi(config, payload, dependencies = {}) {
  let runtime;
  try {
    runtime = resolveBusinessTimeContext(payload || {}, { clock: dependencies.clock });
  } catch (error) {
    return Promise.reject(error);
  }
  payload = Object.assign({}, payload || {}, {
    businessDate: runtime.businessDate,
    businessTimezone: runtime.businessTimezone,
    nowInstant: runtime.nowInstant
  });
  if (!isRealAiEnabled(config)) return Promise.resolve(mockParse(payload));
  const today = runtime.businessDate;
  const messages = payload.reviewMode === 'deep' ? [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI生意助理，只负责把用户输入解析成结构化草稿。',
        '必须只输出JSON，不要解释。',
        '所有金额、数量、单价都用数字字符串：一万五=15000，2万=20000，9毛钱一个=0.9，3毛5=0.35，5块5一个=5.5，一块二一个=1.2。',
        '相对日期以今天为基准，今天是 ' + today + '。',
        '所有日期必须输出YYYY-MM-DD，不能输出2026.6.30或中文日期。',
        'intent只能是 quotation, order, receivable, payment, dunning, todo, query, unknown。',
        'AI只生成草稿，不能声称已经保存。',
        '如果输入包含rawMessages，必须优先按rawMessages的时间顺序理解完整对话；不要只依赖text或localDraft，因为本地摘要可能已经选错旧价格或旧数量。',
        '多轮微信规则：后出现且被明确确认的信息优先于早期报价/试探信息；被“贵了、不要、改成、就按、可以、最终、确认”语义覆盖的旧价格、旧数量、旧交期，必须放入superseded_facts。',
        '冲突规则：如果无法判断最终价格、数量、产品、客户或交期，以field_conflicts列出冲突，不要强行选择；对应字段也要放入low_confidence_fields。',
        '多商品/多规格规则：只要有两件及以上商品，或同一商品有紫色30个、红色10个等多个规格，fields.items必须是逐项数组，并逐项拆开；每个对象含productName、spec、quantity、unit、unitPrice、priceUnit、totalAmount、itemDeliveryDate、itemRemark。绝不能把“杯垫,礼品盒”“紫色,红色”或“300,200”拼进一个字段；无法逐项拆清时，fields.items留空，并把items放入low_confidence_fields。',
        '规格规则：明确对应商品的颜色、尺码、款式（如紫色、红色、S码、A款）填spec；“颜色淡一点、不要色差、外箱红色、logo位置”等制作、质量或包装要求不算规格，放入remark_items和fields.remark。',
        '计量单位规则：unit表示数量单位，priceUnit表示单价按什么单位计价。支持个、只、支、件、套、台、盒、瓶、罐、桶、打、箱、包、袋、捆、扎、斤、公斤、吨、磅、米、码、卷、平方米、平方尺、张、升、立方米、车、柜、托盘、匹、令、两、克、千支、条、头、批、双、本、组、把；千克/kg统一为公斤，托统一为托盘，方/m³统一为立方米，㎡统一为平方米。不得自行做箱转个、打转个、千支转支等换算；unit与priceUnit不一致时totalAmount留空，并把priceUnit放入field_conflicts和low_confidence_fields。',
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
        text: payload.text || '',
        source: payload.source || 'typed',
        context: payload.context || 'home',
        rawText: payload.rawText || '',
        extractedText: payload.extractedText || payload.text || '',
        rawMessages: payload.rawMessages || (payload.pasteMeta && payload.pasteMeta.rawMessages) || [],
        localDraft: payload.localDraft || {},
        customerCandidates: payload.customerCandidates || [],
        businessContext: payload.businessContext || {},
        requiredShape: {
          intent: 'order',
          fields: {
            customerId: '',
            customerName: '',
            phone: '',
            company: '',
            region: '',
            todoTitle: '',
            followupDays: '',
            productName: '',
            spec: '',
            quantity: '',
            unit: '',
            unitPrice: '',
            priceUnit: '',
            depositAmount: '',
            paymentAmount: '',
            amount: '',
            remainingAmount: '',
            paymentMethod: '',
            paymentKind: '',
            dueDate: '',
            orderId: '',
            quotationId: '',
            remark: '',
            items: []
          },
          missing_fields: [],
          low_confidence_fields: [],
          customer_candidates: [],
          field_conflicts: [],
          field_evidence: {},
          superseded_facts: [],
          remark_items: [],
          computed_fields: [],
          computed_tips: [],
          field_sources: {},
          intent_candidates: [],
          confidence: 0.9,
          confirm_message: ''
        }
      })
    }
  ] : buildFastParseMessages(payload, today);
  const selection = selectParseModel(config, payload);
  const requestSelection = withModelTimeout(config, selection);
  requestSelection.timeoutCode = selection.tier === 'fast' ? 'AI_FAST_TIMEOUT' : 'AI_DEEP_TIMEOUT';
  return chatCompletion(config, messages, requestSelection)
    .then((result) => {
      assertAiBusinessResult(result);
      // 普通快速核对绝不能为了“凑完整”再偷偷请求慢模型。
      if (selection.tier === 'fast' && shouldEscalateFastResult(result)) {
        throw createAiError('AI_RESPONSE_INVALID', 'Fast AI result is incomplete or uncertain');
      }
      return withParseMetadata(markCollapsedMultiItems(result), config, selection, false);
    });
}

function queryWithAi(config, payload) {
  if (!isRealAiEnabled(config)) return Promise.resolve(mockQuery(payload));
  return chatCompletion(config, [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI查询助理。',
        '你只能根据用户提供的JSON数据回答，不能编造。',
        '回答必须是JSON：{ "title": string, "lines": string[], "readonly": true }。',
        '语气要短、直接、像老板看得懂的待办说明。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: payload.question || '',
        state: compactStateForPrompt(payload.state || {})
      })
    }
  ]).then((result) => Object.assign({}, result, {
    readonly: true,
    provider: config.aiProvider || 'ai'
  }));
}

function transcribeWithAi() {
  return Promise.resolve(mockTranscribe());
}

module.exports = {
  getAiBusinessResultValidity,
  isSimpleFastParse,
  parseWithAi,
  queryWithAi,
  selectParseModel,
  shouldEscalateFastResult,
  transcribeWithAi
};
