// require() the server twin, start in local mode, read, and check that an error
// thrown by ./start passes isFireweaveError from the package root.
const assert = require('node:assert/strict');
const root = require('@fireweaveai/server-sdk-cjs');
const { start, fw } = require('@fireweaveai/server-sdk-cjs/start');

start({ controlPoints: { 'new-checkout': { local: true } } });
(async () => {
  assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
  let error;
  try {
    start({ controlPoints: { other: { local: false } } });
  } catch (e) {
    error = e;
  }
  assert.ok(root.isFireweaveError(error), 'a second start() with another config throws a FireweaveError');
  assert.equal(error.kind, 'Configuration');
  await fw.shutdown();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
