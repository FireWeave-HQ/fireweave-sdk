// Jest with its default configuration (babel-jest, CommonJS, node environment).
// The ESM name is mapped to the twin by moduleNameMapper (docs/module-formats.md).
const { start, fw, defineControlPoints } = require('@fireweaveai/web-sdk/start');

test('start and read under Jest (node environment)', async () => {
  await start({ controlPoints: defineControlPoints({ 'new-checkout': { local: true } }), mode: 'local', log: () => {} });
  expect(fw.controlPoints.getBooleanValue('new-checkout', false)).toBe(true);
  await fw.shutdown();
});
