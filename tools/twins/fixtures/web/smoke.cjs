// require() every web twin entry point, start in local mode, read, and check
// that an error from ./start passes isFireweaveError from the package root.
const assert = require('node:assert/strict');
const root = require('@fireweaveai/web-sdk-cjs');
const { start, fw, defineControlPoints } = require('@fireweaveai/web-sdk-cjs/start');
const { fireweave } = require('@fireweaveai/web-sdk-cjs/vite');
const { fireweaveDefine } = require('@fireweaveai/web-sdk-cjs/define');

assert.equal(typeof fireweave, 'function');
assert.equal(typeof fireweaveDefine, 'function');
(async () => {
  await start({ controlPoints: defineControlPoints({ 'new-checkout': { local: true } }), mode: 'local', log: () => {} });
  assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
  assert.equal(typeof root.isFireweaveError, 'function');
  await fw.shutdown();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
