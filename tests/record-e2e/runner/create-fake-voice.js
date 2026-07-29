function createFakeVoice(transcript = '') {
  let manager = null;
  const events = [];

  function getRecordRecognitionManager() {
    if (manager) return manager;
    manager = {
      onStart: null,
      onRecognize: null,
      onStop: null,
      onError: null,
      start(options = {}) {
        events.push({ type: 'START', lang: options.lang || '' });
        setImmediate(() => {
          if (typeof manager.onStart === 'function') manager.onStart({ synthetic: true });
          if (typeof manager.onRecognize === 'function') {
            manager.onRecognize({ result: transcript, synthetic: true });
          }
          if (typeof manager.onStop === 'function') {
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
      return {
        events: JSON.parse(JSON.stringify(events)),
        transcriptDelivered: events.some((item) => item.type === 'TRANSCRIPT_DELIVERED')
      };
    },
    plugin: {
      getRecordRecognitionManager
    }
  };
}

module.exports = {
  createFakeVoice
};
