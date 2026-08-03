const { safeClone } = require('../../../utils/record-state-diff');
const { executeSingleItemOrderCase } = require('./execute-case');

process.on('message', async (message) => {
  try {
    const result = await executeSingleItemOrderCase(
      safeClone(message.testCase),
      Number(message.attempt || 1)
    );
    if (process.send) process.send({ ok: true, result });
  } catch (error) {
    if (process.send) {
      process.send({
        ok: false,
        error: {
          code: error.code || 'AUTOMATION_DRIVER_ERROR',
          message: error.message,
          stack: error.stack
        }
      });
    }
  }
});
