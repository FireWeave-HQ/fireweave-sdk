/**
 * @jest-environment jsdom
 */
// Jest + jsdom. jsdom has no TextEncoder, which the SDK needs when it loads; the
// documented consumer fix is the one-line setupFiles polyfill (jest-setup.cjs).
// The ESM name is mapped to the twin by moduleNameMapper (docs/module-formats.md).
const { start, fw, defineControlPoints } = require('@fireweaveai/web-sdk/start');

test('start and read under Jest (jsdom environment)', async () => {
  await start({ controlPoints: defineControlPoints({ 'new-checkout': { local: true } }), mode: 'local', log: () => {} });
  expect(fw.controlPoints.getBooleanValue('new-checkout', false)).toBe(true);
  await fw.shutdown();
});
