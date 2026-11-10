// An ES module importing the twin's named exports (Node's CommonJS interop).
import assert from 'node:assert/strict';
import { isFireweaveError } from '@fireweaveai/web-sdk-cjs';
import { start, fw, defineControlPoints } from '@fireweaveai/web-sdk-cjs/start';
import { fireweave } from '@fireweaveai/web-sdk-cjs/vite';
import { fireweaveDefine } from '@fireweaveai/web-sdk-cjs/define';

assert.equal(typeof isFireweaveError, 'function');
assert.equal(typeof fireweave, 'function');
assert.equal(typeof fireweaveDefine, 'function');
await start({ controlPoints: defineControlPoints({ 'new-checkout': { local: true } }), mode: 'local', log: () => {} });
assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
await fw.shutdown();
console.log('ok');
