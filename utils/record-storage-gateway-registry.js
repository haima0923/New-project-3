const { safeClone } = require('./record-state-diff');

const TRUSTED_GATEWAYS = new WeakMap();

function gatewayError(message) {
  const error = new Error(message);
  error.code = 'STORAGE_GATEWAY_INVALID';
  return error;
}

function validateGatewayShape(gateway) {
  if (!gateway || typeof gateway !== 'object'
    || typeof gateway.getStorageSync !== 'function'
    || typeof gateway.setStorageSync !== 'function'
    || typeof gateway.removeStorageSync !== 'function') {
    throw gatewayError('Storage gateway合同不完整。');
  }
}

function registerTrustedGateway(gateway, descriptor) {
  validateGatewayShape(gateway);
  TRUSTED_GATEWAYS.set(gateway, Object.freeze(Object.assign({}, descriptor)));
  return Object.freeze(gateway);
}

function getTrustedGatewayIdentity(gateway) {
  const descriptor = TRUSTED_GATEWAYS.get(gateway);
  return descriptor ? safeClone(descriptor) : null;
}

module.exports = {
  gatewayError,
  getTrustedGatewayIdentity,
  registerTrustedGateway,
  validateGatewayShape
};
