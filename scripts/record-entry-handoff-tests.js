#!/usr/bin/env node
const assert = require('assert');
const {
  publishRecordEntryHandoff: publish,
  consumeRecordEntryHandoff: consume,
  invalidateRecordEntryHandoff: invalidate,
  hasPendingRecordEntryHandoff: hasPending
} = require('../utils/record-entry-handoff');

const cases = [
  ['文字与粘贴原话完整转交，输入渠道由来源推导', () => {
    for (const source of ['typed', 'paste']) {
      for (const originalText of ['  王总订礼品盒100个\n明天交  ', '  微信聊天原文：\n'.repeat(1000) + '王总订礼品盒100个，明天交  ']) {
        publish({ originalText, source, originSurface: 'HOME_QUICK', inputChannel: 'FORGED' });
        const value = consume();
        assert.strictEqual(value.originalText, originalText);
        assert.strictEqual(value.inputChannel, source === 'typed' ? 'MANUAL_TEXT' : 'PASTE_TEXT');
        assert.deepStrictEqual(Object.keys(value).sort(), ['autoParse', 'inputChannel', 'originSurface', 'originalText', 'source']);
        assert.strictEqual(consume(), null);
      }
    }
  }],
  ['路由、人工确认及保存授权不能搭便车进入完整页', () => {
    publish({
      originalText: '王总订礼品盒100个', source: 'typed',
      parse_route: { decision: 'local' }, manual_fields: ['intent'],
      formal_save_blocked: false, provider_kind: 'REAL', user_manual_edits: [{ trusted: true }],
      voiceCompletionEvidence: { status: 'COMPLETED', isFinal: true }
    });
    const value = consume();
    assert.deepStrictEqual(Object.keys(value).sort(), ['autoParse', 'inputChannel', 'originSurface', 'originalText', 'source']);
  }],
  ['语音保留入口和完成证据副本，但不传递额外信任声明', () => {
    const evidence = {
      version: 'voice-completion-evidence-v1', status: 'COMPLETED', isFinal: true,
      source: 'VOICE_TRANSCRIPT', provider: 'synthetic-test-provider', sessionId: 'test-session',
      resultSequence: 3, transcriptFingerprint: 'synthetic-fingerprint', transcriptLength: 8,
      trusted: true, route: 'LOCAL', manual_fields: ['amount']
    };
    publish({ originalText: '王总订杯子', source: 'voice', originSurface: 'DASHBOARD_HERO', voiceCompletionEvidence: evidence });
    evidence.sessionId = 'mutated-after-publish';
    const value = consume();
    assert.strictEqual(value.originSurface, 'DASHBOARD_HERO');
    assert.strictEqual(value.inputChannel, 'VOICE_TRANSCRIPT');
    assert.strictEqual(value.voiceCompletionEvidence.sessionId, 'test-session');
    for (const key of ['trusted', 'route', 'manual_fields']) assert(!(key in value.voiceCompletionEvidence));
    assert(Object.isFrozen(value.voiceCompletionEvidence));
  }],
  ['新输入替换旧输入，旧导航失败不能清掉新内容', () => {
    const old = publish({ originalText: '旧输入', source: 'typed' });
    const current = publish({ originalText: '新输入', source: 'typed' });
    assert.strictEqual(invalidate(old), false);
    assert.strictEqual(hasPending(), true);
    assert.strictEqual(consume().originalText, '新输入');
    assert.strictEqual(consume(), null);
    assert.strictEqual(invalidate(current), false);
    const failed = publish({ originalText: '导航失败的输入', source: 'typed' });
    assert.strictEqual(invalidate(failed), true);
    assert.strictEqual(hasPending(), false);
  }]
];

for (const [name, run] of cases) {
  consume();
  try { run(); } finally { consume(); }
  console.log(`PASS ${name}`);
}
console.log(`Record entry handoff: ${cases.length}/${cases.length} passed`);
