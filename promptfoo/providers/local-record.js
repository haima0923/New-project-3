module.exports = class LocalRecordProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'local-record';
    this.config = options.config || {};
    this.baseUrl = (this.config.baseUrl || 'http://127.0.0.1:3001').replace(/\/$/, '');
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context = {}) {
    const vars = context.vars || {};
    const text = vars.question || prompt;
    const body = {
      text,
      source: vars.source || 'typed',
      context: vars.context || 'home',
    };

    const response = await fetch(`${this.baseUrl}/api/ai/parse`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();

    if (!response.ok) {
      return {
        error: `Local record endpoint returned HTTP ${response.status}: ${raw.slice(0, 500)}`,
      };
    }

    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {
        error: `Local record endpoint returned non-JSON: ${raw.slice(0, 500)}`,
      };
    }

    return {
      output: JSON.stringify(payload),
      metadata: {
        baseUrl: this.baseUrl,
        provider: payload.provider,
        intent: payload.intent,
      },
    };
  }
};
