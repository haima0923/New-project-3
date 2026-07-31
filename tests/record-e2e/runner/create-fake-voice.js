function createFakeVoice(transcript = '') {
  let manager = null;
  const events = [];

  function getRecordRecognitionManager() {
    if (manager) return manager;
    manager = {
      __recordVoiceFake: true,
      onStart: null,
      onRecognize: null,
      onStop: null,
      onError: null,
      start(options = {}) {
        const recordVoiceSessionId = String(options.recordVoiceSessionId || '');
        events.push({
          type: 'START',
          lang: options.lang || '',
          recordVoiceSessionId
        });
        setImmediate(() => {
          if (typeof manager.onStart === 'function') {
            events.push({ type: 'START_CALLBACK' });
            manager.onStart({ synthetic: true });
          }
          if (typeof manager.onRecognize === 'function') {
            events.push({ type: 'PARTIAL_CALLBACK' });
            manager.onRecognize({ result: transcript, synthetic: true });
          }
          if (typeof manager.onStop === 'function') {
            events.push({ type: 'FINAL_CALLBACK', recordVoiceSessionId });
            manager.onStop({ result: transcript, synthetic: true });
          }
          // START only proves that recognition was requested. The page's
          // asynchronous parser is not reachable until the stop callback has
          // delivered the transcript and triggered the real page flow.
          events.push({ type: 'TRANSCRIPT_DELIVERED' });
        });
      },
      stop() {
        events.push({ type: 'STOP' });
      }
    };
    return manager;
  }

  return {
    audit() {
      let sessionAudit = null;
      try {
        sessionAudit = require('../../../utils/voice-recognition').getVoiceRecognitionAudit();
      } catch (error) {
        sessionAudit = null;
      }
      return {
        events: JSON.parse(JSON.stringify(events)),
        finalCallbackInvocationCount: events.filter(
          (item) => item.type === 'FINAL_CALLBACK'
        ).length,
        partialCallbackInvocationCount: events.filter(
          (item) => item.type === 'PARTIAL_CALLBACK'
        ).length,
        staleSessionAcceptedCount: countStaleSessionAccepted(events, sessionAudit),
        staleSessionRejectedCount: Number(
          sessionAudit && sessionAudit.staleSessionRejectedCount || 0
        ),
        transcriptDelivered: events.some((item) => item.type === 'TRANSCRIPT_DELIVERED')
      };
    },
    plugin: {
      getRecordRecognitionManager
    }
  };
}

function countStaleSessionAccepted(events = [], sessionAudit = null) {
  const acceptedSessionId = String(
    sessionAudit
    && sessionAudit.acceptedFinalCount === 1
    && sessionAudit.evidence
    && sessionAudit.evidence.sessionId
    || ''
  );
  if (!acceptedSessionId) return 0;
  return events.filter((event) => (
    event
    && event.type === 'FINAL_CALLBACK'
    && event.recordVoiceSessionId
    && event.recordVoiceSessionId !== acceptedSessionId
  )).length;
}

module.exports = {
  countStaleSessionAccepted,
  createFakeVoice
};
