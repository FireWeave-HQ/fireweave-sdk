// An ES module importing the twin's named exports (Node's CommonJS interop).
import assert from 'node:assert/strict';
import { isFireweaveError } from '@fireweaveai/server-sdk-cjs';
import { start, fw } from '@fireweaveai/server-sdk-cjs/start';

assert.equal(typeof isFireweaveError, 'function');
start({ controlPoints: { 'new-checkout': { local: true } } });
assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
await fw.shutdown();
console.log('ok');
