// Recommended layout: the start module is the entrypoint's first import.
import './fireweave.start.mjs';
import { early } from './sibling.mjs';
import { fw } from '@fireweaveai/server-sdk/start';
const later = await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' });
console.log(JSON.stringify({ early: await early, later, mode: fw.status().mode }));
await fw.shutdown();
