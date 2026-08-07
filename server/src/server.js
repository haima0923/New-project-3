const http = require('http');
const crypto = require('crypto');
const { assertAuthConfig, getConfig, isRealAiEnabled } = require('./config');
const { getAllowedOrigin, readJsonBody, sendJson } = require('./lib/http');
const { createRateLimiter } = require('./lib/rate-limit');
const { getBearerToken, loginWithWechatCode, verifySessionToken } = require('./lib/wechat-auth');
const {
  createInternalParseRouteContext,
  parseWithAi,
  queryWithAi,
  transcribeWithAi
} = require('./ai/model');
const { numberPattern, parseChineseNumber } = require('../utils/chinese-number');
const { parseInput } = require('../utils/parser');
const { UNIT_PATTERN, unitsMatch } = require('../utils/units');

const SERVER_PARSE_ROUTES = Object.freeze({
  ASK_USER: 'ASK_USER',
  AUTO_DEEP: 'AUTO_DEEP',
  FAST_LOCAL: 'FAST_LOCAL',
  SAFE_BLOCKED: 'SAFE_BLOCKED'
});
const FACT_FIELDS = new Set([
  'amount', 'customerName', 'dueDate', 'paymentAmount', 'productName', 'quantity', 'todoTitle', 'unitPrice'
]);
const ORDER_TOTAL_CUE_SOURCE = '(?:总金额|订单金额|整单金额|这单金额|总价|总计|合计|一共|总共|金额)';
const FUZZY_AMOUNT_SOURCE = '(?:大概|大约|约|左右|上下|差不多|估计)';

const config = getConfig();
const aiRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.aiRateLimitMaxRequests
});
const deepAiRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.aiDeepRateLimitMaxRequests
});
const authLoginRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.authLoginRateLimitMaxRequests
});

function isAiRoute(req) {
  return req.method === 'POST' && ['/api/ai/parse', '/api/ai/parse/deep', '/api/ai/query', '/api/ai/transcribe'].includes(req.url);
}

function isDeepParseRoute(req) {
  return req.method === 'POST' && req.url === '/api/ai/parse/deep';
}

function createRequestId() {
  return `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createOriginalTextFingerprint(text, rawMessages = []) {
  const evidence = JSON.stringify({
    text: String(text || ''),
    rawMessages: Array.isArray(rawMessages) ? rawMessages : []
  });
  return crypto.createHash('sha256').update(evidence, 'utf8').digest('hex');
}

function getCanonicalRawMessages(body = {}) {
  if (!Array.isArray(body.rawMessages)) return [];
  return body.rawMessages.map((message, index) => ({
    index: Number.isInteger(message && message.index) ? message.index : index,
    speaker: String(message && message.speaker || '').trim(),
    time: String(message && message.time || '').trim(),
    content: String(message && (message.content || message.text) || '').trim()
  })).filter((message) => message.content);
}

function getCanonicalBusinessInput(body = {}) {
  const rawMessages = getCanonicalRawMessages(body);
  const fallbackText = String(body.text || body.extractedText || body.rawText || '').trim();
  return {
    rawMessages,
    text: rawMessages.length
      ? rawMessages.map((message) => message.content).join('\n').trim()
      : fallbackText
  };
}

function uniqueFactFields(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value && value.field || value || '').trim())
    .filter((value) => FACT_FIELDS.has(value))));
}

function toPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toMoneyCents(value, allowZero = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) return null;
  return Math.round((number + Number.EPSILON) * 100);
}

function isNonOrderTotalContext(prefix) {
  return /(?:单价|价格|报价|优惠|折扣|运费|货款|已付|付了|付款|已收|收了|收到|收款|到账|定金|订金|预付款?|还欠|尚欠|欠款|待收|应收|尾款)\s*(?:的)?\s*$/.test(prefix);
}

function getExplicitOrderTotalEvidence(text) {
  const originalText = String(text || '');
  const cuePattern = new RegExp(ORDER_TOTAL_CUE_SOURCE, 'g');
  const amountPattern = new RegExp(
    `^\\s*(?:是|为|共|改成|改为)?\\s*[：:]?\\s*(${numberPattern()})\\s*(万元|元|块钱|块)?`
  );
  const fuzzyBeforePattern = new RegExp(`${FUZZY_AMOUNT_SOURCE}\\s*$`);
  const fuzzyAfterPattern = new RegExp(`^\\s*(?:是|为|共|改成|改为)?\\s*[：:]?\\s*${FUZZY_AMOUNT_SOURCE}`);
  const fuzzyTrailingPattern = new RegExp(`^\\s*${FUZZY_AMOUNT_SOURCE}`);
  const cents = [];
  let ambiguous = false;
  let cue;
  while ((cue = cuePattern.exec(originalText)) !== null) {
    const prefix = originalText.slice(Math.max(0, cue.index - 16), cue.index);
    if (isNonOrderTotalContext(prefix)) continue;
    const suffix = originalText.slice(cue.index + cue[0].length);
    if (fuzzyBeforePattern.test(prefix) || fuzzyAfterPattern.test(suffix)) {
      ambiguous = true;
      continue;
    }
    const amountMatch = suffix.match(amountPattern);
    if (!amountMatch) {
      ambiguous = true;
      continue;
    }
    const trailing = suffix.slice(amountMatch[0].length);
    if (['一共', '总共', '总计', '合计'].includes(cue[0])
      && !amountMatch[2]
      && new RegExp(`^\\s*${UNIT_PATTERN}`).test(trailing)) {
      continue;
    }
    if (fuzzyTrailingPattern.test(trailing)
      || !/^(?:$|[，,。；;\s]|为准|后|前|交|发|出|拿|结)/.test(trailing)) {
      ambiguous = true;
      continue;
    }
    const amount = parseChineseNumber(
      `${amountMatch[1]}${amountMatch[2] && amountMatch[2].includes('万') && !String(amountMatch[1]).includes('万') ? '万' : ''}`
    );
    const amountCents = toMoneyCents(amount, true);
    if (amountCents === null) ambiguous = true;
    else cents.push(amountCents);
  }
  return { ambiguous, cents };
}

function hasNonItemMoneyEvidencePrefix(text, index) {
  const prefix = String(text || '').slice(Math.max(0, index - 24), index);
  return /(?:定金|订金|预付款?|已付|付款|已收|收款|到账|还欠|尚欠|欠款|待收|应收|尾款|运费|包装费|货款)\s*(?:是|为|共|[：:])?\s*$/.test(prefix);
}

function countPotentialItemFactEvidence(text) {
  const sourceText = String(text || '');
  const number = numberPattern();
  const quantityPattern = new RegExp(`(?:${number})\\s*${UNIT_PATTERN}`);
  const unitPricePattern = new RegExp(
    `(?:每\\s*${UNIT_PATTERN}\\s*(?:${number})|单价\\s*(?:是|为)?\\s*(?:${number})\\s*(?:元钱|块钱|元|块|毛钱|毛|角|分)?|(?:${number})\\s*(?:元钱|块钱|元|块|毛钱|毛|角|分)?\\s*(?:一|每|/)\\s*${UNIT_PATTERN})`
  );
  const unitPriceMatches = Array.from(sourceText.matchAll(new RegExp(unitPricePattern.source, 'g')));
  const quantityEvidenceCount = Array.from(sourceText.matchAll(new RegExp(quantityPattern.source, 'g')))
    .filter((quantityMatch) => !unitPriceMatches.some((priceMatch) => (
      quantityMatch.index >= priceMatch.index
      && quantityMatch.index < priceMatch.index + priceMatch[0].length
    )))
    .filter((match) => !hasNonItemMoneyEvidencePrefix(sourceText, match.index)).length;
  const unitPriceEvidenceCount = unitPriceMatches
    .filter((match) => !hasNonItemMoneyEvidencePrefix(sourceText, match.index)).length;
  return Math.max(quantityEvidenceCount, unitPriceEvidenceCount);
}

function itemQuestionTarget(index, itemField) {
  return {
    field: 'items',
    fieldPath: `items[${index}].${itemField}`,
    itemField,
    itemIndex: index
  };
}

function inspectAutoDeepItemFacts(text, items) {
  const issues = [];
  const itemSubtotalCents = [];
  items.forEach((item, index) => {
    const productName = String(item && item.productName || '').trim();
    const quantity = toPositiveNumber(item && item.quantity);
    const unit = String(item && item.unit || '').trim();
    const unitPrice = toPositiveNumber(item && (item.unitPrice || item.unit_price));
    if (!productName) issues.push({
      code: `ITEM_${index + 1}_PRODUCT_NAME_REQUIRED`,
      questionTarget: itemQuestionTarget(index, 'productName')
    });
    if (quantity === null) issues.push({
      code: `ITEM_${index + 1}_QUANTITY_REQUIRED`,
      questionTarget: itemQuestionTarget(index, 'quantity')
    });
    if (!unit) issues.push({
      code: `ITEM_${index + 1}_UNIT_REQUIRED`,
      questionTarget: itemQuestionTarget(index, 'unit')
    });
    if (unitPrice === null) issues.push({
      code: `ITEM_${index + 1}_UNIT_PRICE_REQUIRED`,
      questionTarget: itemQuestionTarget(index, 'unitPrice')
    });
    if (!productName || quantity === null || !unit || unitPrice === null) return;
    if (!unitsMatch(item.unit || '', item.priceUnit || item.price_unit || '')) {
      issues.push({
        code: `ITEM_${index + 1}_UNIT_CONFLICT`,
        questionTarget: itemQuestionTarget(index, 'unit')
      });
      return;
    }
    const subtotalCents = toMoneyCents(quantity * unitPrice);
    if (subtotalCents === null) {
      issues.push({
        code: `ITEM_${index + 1}_AMOUNT_INVALID`,
        questionTarget: itemQuestionTarget(index, 'unitPrice')
      });
      return;
    }
    const statedItemTotal = item.totalAmount || item.total_amount || item.amount;
    if (statedItemTotal !== undefined && statedItemTotal !== null && String(statedItemTotal).trim() !== '') {
      const statedItemTotalCents = toMoneyCents(statedItemTotal);
      if (statedItemTotalCents !== subtotalCents) {
        issues.push({
          code: `ITEM_${index + 1}_AMOUNT_CONFLICT`,
          questionTarget: itemQuestionTarget(index, 'unitPrice')
        });
        return;
      }
    }
    itemSubtotalCents.push(subtotalCents);
  });

  if (issues.length || itemSubtotalCents.length !== items.length) {
    return {
      eligible: false,
      questionTarget: issues[0] && issues[0].questionTarget,
      reasonCodes: issues.map((issue) => issue.code)
    };
  }

  const explicitTotalEvidence = getExplicitOrderTotalEvidence(text);
  if (explicitTotalEvidence.ambiguous) {
    return {
      eligible: false,
      questionTarget: { field: 'amount', fieldPath: 'amount' },
      reasonCodes: ['ORDER_TOTAL_UNCERTAIN']
    };
  }
  if (explicitTotalEvidence.cents.length) {
    const calculatedTotalCents = itemSubtotalCents.reduce((sum, cents) => sum + cents, 0);
    if (new Set(explicitTotalEvidence.cents).size !== 1
      || explicitTotalEvidence.cents[0] !== calculatedTotalCents) {
      return {
        eligible: false,
        questionTarget: { field: 'amount', fieldPath: 'amount' },
        reasonCodes: ['ORDER_TOTAL_CONFLICT']
      };
    }
  }
  return { eligible: true, questionTarget: null, reasonCodes: [] };
}

function decideServerParseRoute(body = {}) {
  const canonicalInput = getCanonicalBusinessInput(body);
  const text = canonicalInput.text;
  const originalTextFingerprint = createOriginalTextFingerprint(text, canonicalInput.rawMessages);
  if (!text) {
    return {
      localDraft: null,
      originalTextFingerprint,
      rawMessages: canonicalInput.rawMessages,
      reasonCodes: ['EMPTY_BUSINESS_TEXT'],
      route: SERVER_PARSE_ROUTES.SAFE_BLOCKED,
      text
    };
  }

  const source = ['paste', 'typed', 'voice'].includes(body.source) ? body.source : 'typed';
  const localDraft = parseInput({
    businessDate: body.businessDate,
    businessTimezone: body.businessTimezone,
    context: body.context || 'home',
    nowInstant: body.nowInstant,
    source,
    state: {},
    text
  });
  const missingFacts = uniqueFactFields(localDraft.missing_fields);
  const lowConfidenceFacts = uniqueFactFields(localDraft.low_confidence_fields);
  const conflictFacts = uniqueFactFields(localDraft.field_conflicts);
  const unresolvedFacts = Array.from(new Set(
    missingFacts.concat(lowConfidenceFacts, conflictFacts)
  ));

  if (localDraft.formal_save_blocked === true || localDraft.mixed_business === true) {
    return {
      localDraft,
      originalTextFingerprint,
      rawMessages: canonicalInput.rawMessages,
      reasonCodes: ['LOCAL_SAFETY_BLOCKED'],
      route: SERVER_PARSE_ROUTES.SAFE_BLOCKED,
      text
    };
  }
  if (unresolvedFacts.length) {
    return {
      localDraft,
      originalTextFingerprint,
      rawMessages: canonicalInput.rawMessages,
      reasonCodes: unresolvedFacts.map((field) => `MISSING_OR_UNCERTAIN_${field}`),
      route: SERVER_PARSE_ROUTES.ASK_USER,
      text
    };
  }

  const items = Array.isArray(localDraft.fields && localDraft.fields.items)
    ? localDraft.fields.items
    : [];
  const potentialItemFactEvidenceCount = countPotentialItemFactEvidence(text);
  if (potentialItemFactEvidenceCount > 1 && potentialItemFactEvidenceCount > items.length) {
    return {
      localDraft,
      originalTextFingerprint,
      questionTarget: { field: 'items', fieldPath: `items[${items.length}]` },
      rawMessages: canonicalInput.rawMessages,
      reasonCodes: ['UNRESOLVED_ITEM_FACT_CANDIDATE'],
      route: SERVER_PARSE_ROUTES.ASK_USER,
      text
    };
  }
  if (items.length > 1) {
    const factAdmission = inspectAutoDeepItemFacts(text, items);
    if (!factAdmission.eligible) {
      return {
        localDraft,
        originalTextFingerprint,
        questionTarget: factAdmission.questionTarget || null,
        rawMessages: canonicalInput.rawMessages,
        reasonCodes: factAdmission.reasonCodes,
        route: SERVER_PARSE_ROUTES.ASK_USER,
        text
      };
    }
    return {
      localDraft,
      originalTextFingerprint,
      rawMessages: canonicalInput.rawMessages,
      reasonCodes: ['MULTI_ITEM_REQUIRES_DEEP_REVIEW'],
      route: SERVER_PARSE_ROUTES.AUTO_DEEP,
      text
    };
  }
  return {
    localDraft,
    originalTextFingerprint,
    rawMessages: canonicalInput.rawMessages,
    reasonCodes: ['SAFE_FAST_PARSE'],
    route: SERVER_PARSE_ROUTES.FAST_LOCAL,
    text
  };
}

function createRouteError(code, message, decision) {
  const error = new Error(message);
  error.code = code;
  error.serverRoute = decision.route;
  error.originalTextFingerprint = decision.originalTextFingerprint;
  error.questionTarget = decision.questionTarget || null;
  return error;
}

function buildTrustedModelPayload(body, decision) {
  return {
    businessContext: body.businessContext && typeof body.businessContext === 'object'
      ? body.businessContext
      : {},
    businessDate: body.businessDate,
    businessTimezone: body.businessTimezone,
    context: body.context || 'home',
    customerCandidates: Array.isArray(body.customerCandidates) ? body.customerCandidates : [],
    extractedText: decision.text,
    localDraft: decision.localDraft || {},
    nowInstant: body.nowInstant,
    rawMessages: decision.rawMessages || [],
    rawText: decision.text,
    source: ['paste', 'typed', 'voice'].includes(body.source) ? body.source : 'typed',
    text: decision.text
  };
}

function parseAtTrustedServerRoute(body, options) {
  const decision = decideServerParseRoute(body);
  if (decision.route === SERVER_PARSE_ROUTES.ASK_USER) {
    throw createRouteError('AI_ROUTE_ASK_USER', 'Original text is missing a required business fact', decision);
  }
  if (decision.route === SERVER_PARSE_ROUTES.SAFE_BLOCKED) {
    throw createRouteError('AI_ROUTE_SAFE_BLOCKED', 'Original text cannot be parsed safely', decision);
  }
  if (options.deepRequested && decision.route !== SERVER_PARSE_ROUTES.AUTO_DEEP) {
    throw createRouteError('AI_DEEP_NOT_AUTHORIZED', 'Deep request is not eligible for quality model', decision);
  }
  if (!options.deepRequested && decision.route === SERVER_PARSE_ROUTES.AUTO_DEEP) {
    throw createRouteError('AI_DEEP_REQUIRED', 'Input requires an eligible deep review request', decision);
  }

  const routeContext = decision.route === SERVER_PARSE_ROUTES.AUTO_DEEP
    ? createInternalParseRouteContext({
      originalTextFingerprint: decision.originalTextFingerprint,
      requestId: options.requestId,
      route: decision.route
    })
    : null;
  return parseWithAi(config, buildTrustedModelPayload(body, decision), {
    requestId: options.requestId,
    routeContext
  })
    .then((payload) => Object.assign({}, payload, {
      ai_original_text_fingerprint: decision.originalTextFingerprint,
      ai_server_route: decision.route
    }));
}

function getParseErrorStatus(error) {
  const code = String((error && error.code) || 'AI_PARSE_FAILED');
  if (['INVALID_BUSINESS_DATE', 'UNSUPPORTED_BUSINESS_TIMEZONE', 'INVALID_NOW_INSTANT', 'BUSINESS_DATE_MISMATCH'].includes(code)) return 400;
  if (['AI_DEEP_NOT_AUTHORIZED', 'AI_DEEP_REQUIRED'].includes(code)) return 409;
  if (['AI_ROUTE_ASK_USER', 'AI_ROUTE_SAFE_BLOCKED'].includes(code)) return 422;
  if (code === 'AI_FAST_TIMEOUT' || code === 'AI_DEEP_TIMEOUT') return 504;
  if (code === 'AI_RESPONSE_INVALID' || code === 'AI_RESPONSE_EMPTY_BUSINESS') return 422;
  if (code === 'AI_PROVIDER_UNAVAILABLE') return 502;
  return 500;
}

function toSafeParseError(error) {
  const code = String((error && error.code) || 'AI_PARSE_FAILED');
  const messages = {
    AI_FAST_TIMEOUT: '智能快速核对超时。',
    AI_RESPONSE_INVALID: '智能核对没有给出可核对的结果。',
    AI_RESPONSE_EMPTY_BUSINESS: '智能核对返回了空业务结果，已拒绝采用。',
    AI_PROVIDER_UNAVAILABLE: '智能核对服务暂时不可用。',
    AI_DEEP_TIMEOUT: '深度核对超时。',
    AI_DEEP_NOT_AUTHORIZED: '这条内容不符合深度核对条件。',
    AI_DEEP_REQUIRED: '这条内容需要通过可信深度核对处理。',
    AI_ROUTE_ASK_USER: '原话缺少必要信息，请先向老板确认。',
    AI_ROUTE_SAFE_BLOCKED: '这条内容暂时不能安全整理。',
    INVALID_BUSINESS_DATE: '业务日期格式不正确。',
    UNSUPPORTED_BUSINESS_TIMEZONE: '业务时区不受支持。',
    INVALID_NOW_INSTANT: '当前时刻格式不正确。',
    BUSINESS_DATE_MISMATCH: '业务日期与当前时刻不一致。'
  };
  return { error: code, message: messages[code] || '智能核对暂时不可用。' };
}

function isWechatLoginRoute(req) {
  return req.method === 'POST' && req.url === '/api/auth/wechat-login';
}

function authenticateAiRequest(req, res, origin) {
  if (!config.authRequired) return { sub: 'anonymous-local-mode' };
  const claims = verifySessionToken(getBearerToken(req), config);
  if (claims) return claims;
  sendJson(res, 401, {
    error: 'AUTH_REQUIRED',
    message: '请先完成微信登录后再使用智能识别。'
  }, origin);
  return null;
}

function handleRequest(req, res) {
  const origin = getAllowedOrigin(req, config.allowedOrigins);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'yiwu-boss-ai-assistant-server',
      mode: isRealAiEnabled(config) ? 'ai' : 'mock',
      authRequired: config.authRequired
    }, origin);
    return;
  }

  if (isWechatLoginRoute(req)) {
    const rate = authLoginRateLimiter.consume(req);
    if (!rate.allowed) {
      sendJson(res, 429, {
        error: 'RATE_LIMITED',
        message: '登录请求过于频繁，请稍后再试。',
        retryAfterSeconds: rate.retryAfterSeconds
      }, origin);
      return;
    }
    readJsonBody(req)
      .then((body) => loginWithWechatCode(config, String(body.code || '').trim()))
      .then((session) => sendJson(res, 200, {
        token: session.token,
        expiresAt: session.expiresAt
      }, origin))
      .catch(() => sendJson(res, 401, {
        error: 'WECHAT_LOGIN_FAILED',
        message: '微信登录校验未通过，请稍后重试。'
      }, origin));
    return;
  }

  if (isAiRoute(req)) {
    const claims = authenticateAiRequest(req, res, origin);
    if (!claims) return;
    const rate = (isDeepParseRoute(req) ? deepAiRateLimiter : aiRateLimiter).consume(req, Date.now(), claims.sub);
    if (!rate.allowed) {
      sendJson(res, 429, {
        error: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试。',
        retryAfterSeconds: rate.retryAfterSeconds
      }, origin);
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/api/ai/parse') {
    const requestId = createRequestId();
    const startedAt = Date.now();
    readJsonBody(req)
      .then((body) => parseAtTrustedServerRoute(body, { deepRequested: false, requestId }))
      .then((payload) => sendJson(res, 200, Object.assign({}, payload, {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiFastRequestTimeoutMs
      }), origin))
      .catch((error) => sendJson(res, getParseErrorStatus(error), Object.assign(toSafeParseError(error), {
        ai_original_text_fingerprint: error.originalTextFingerprint || '',
        ai_question_target: error.questionTarget || null,
        ai_request_id: requestId,
        ai_server_route: error.serverRoute || '',
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiFastRequestTimeoutMs
      }), origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/parse/deep') {
    const requestId = createRequestId();
    const startedAt = Date.now();
    readJsonBody(req)
      .then((body) => parseAtTrustedServerRoute(body, { deepRequested: true, requestId }))
      .then((payload) => sendJson(res, 200, Object.assign({}, payload, {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiQualityRequestTimeoutMs
      }), origin))
      .catch((error) => sendJson(res, getParseErrorStatus(error), Object.assign(toSafeParseError(error), {
        ai_original_text_fingerprint: error.originalTextFingerprint || '',
        ai_question_target: error.questionTarget || null,
        ai_request_id: requestId,
        ai_server_route: error.serverRoute || '',
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiQualityRequestTimeoutMs
      }), origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/query') {
    readJsonBody(req)
      .then((body) => queryWithAi(config, body))
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_QUERY_FAILED',
        message: error.message
      }, origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/transcribe') {
    transcribeWithAi(config)
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_TRANSCRIBE_FAILED',
        message: error.message
      }, origin));
    return;
  }

  sendJson(res, 404, {
    error: 'NOT_FOUND'
  }, origin);
}

const server = http.createServer(handleRequest);
assertAuthConfig(config);
server.listen(config.port, '127.0.0.1', () => {
  console.log(`AI assistant server listening on ${config.port}`);
  console.log(`Mode: ${isRealAiEnabled(config) ? 'AI' : 'mock'}`);
});
