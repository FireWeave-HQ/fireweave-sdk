// Run with: node -r @fireweaveai/server-sdk-cjs/register register.cjs (FIREWEAVE_ENV=local)
const assert = require('node:assert/strict');
const { fw } = require('@fireweaveai/server-sdk-cjs/start');

(async () => {
  assert.equal(await fw.controlPoints.getBooleanValue('x', false, { targetingKey: 'u1' }), false);
  assert.equal(fw.status().mode, 'local');
  await fw.shutdown();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
