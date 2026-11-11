// Jest with its default configuration (babel-jest, CommonJS, node environment).
// The ES module name is mapped to the twin by moduleNameMapper (docs/module-formats.md).
const { start, fw } = require('@fireweaveai/server-sdk/start');
const { isFireweaveError } = require('@fireweaveai/server-sdk');

test('start and read under Jest', async () => {
  start({ controlPoints: { 'new-checkout': { local: true } } });
  expect(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' })).toBe(true);
  expect(typeof isFireweaveError).toBe('function');
  await fw.shutdown();
});
