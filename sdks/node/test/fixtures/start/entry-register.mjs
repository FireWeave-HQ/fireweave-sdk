// Zero-config sugar: start from the environment alone.
import '@fireweaveai/server-sdk/register';
import { fw } from '@fireweaveai/server-sdk/start';
console.log(JSON.stringify({ value: await fw.controlPoints.getBooleanValue('x', false, { targetingKey: 'u1' }), status: fw.status() }));
await fw.shutdown();
