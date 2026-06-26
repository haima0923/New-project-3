const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

loadEnvFile();

function getConfig() {
  return {
    port: Number(process.env.PORT || 3001),
    env: process.env.NODE_ENV || 'development',
    aiProvider: process.env.AI_PROVIDER || 'mock',
    aiApiKey: process.env.AI_API_KEY || '',
    aiBaseUrl: (process.env.AI_BASE_URL || '').replace(/\/$/, ''),
    aiModel: process.env.AI_MODEL || '',
    allowedOrigins: process.env.ALLOWED_ORIGINS || '*'
  };
}

function isRealAiEnabled(config) {
  return Boolean(config.aiApiKey && config.aiBaseUrl && config.aiModel && config.aiProvider !== 'mock');
}

module.exports = {
  getConfig,
  isRealAiEnabled
};
