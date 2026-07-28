const { executeCaseInWorker } = require('./execute-case');

process.once('message', async (message) => {
  try {
    const result = await executeCaseInWorker(message);
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
