// CommonJS apps: require(esm) of the start entry (no top-level await inside it).
const { start, fw } = require('@fireweaveai/server-sdk/start');
start({ controlPoints: { 'new-checkout': { local: true } } });
fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' })
  .then((value) => { console.log(JSON.stringify({ value })); return fw.shutdown(); });
