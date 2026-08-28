/**
 * Fireweave SDK — minimal Node example.
 *
 * Default mode runs fully OFFLINE (mode: 'local', no network, no credentials).
 *
 * Production path (ADR-0005):
 *   --remote + FW_API_URL + FW_PROJECT_API_KEY  → mode: 'remote' (fw-server / stub)
 *
 * Stub: node test-server/implementation/server.mjs  (127.0.0.1:3901)
 *
 * Runs unchanged under `node`, `bun`, and `deno run --allow-net --allow-env`.
 */
import { initFireweave } from '@fireweaveai/server-sdk';

const useRemote = process.argv.includes('--remote') || process.env.FW_API_URL !== undefined;

// 1. `initFireweave` is the single entry point (spec/modes.md) — it validates
// the mode, builds the matching adapter, and brings the client to READY.
const fireweave = useRemote
  ? await initFireweave({
      mode: 'remote',
      apiUrl: process.env.FW_API_URL ?? 'http://127.0.0.1:3901',
      apiKey: process.env.FW_PROJECT_API_KEY ?? 'project-api-key_dev',
    })
  : await initFireweave({
      // Local mode seeds a deterministic in-process map — no network, no
      // credentials. Great for tests and offline dev.
      mode: 'local',
      local: { controlPoints: { 'new-checkout': true } },
    });

// Stub fixture key when talking to the Fireweave remote protocol.
const boolFlag = useRemote ? 'fw-bool-on' : 'new-checkout';

// 2. Evaluate a boolean control point with a targeting context.
const context = { targetingKey: 'user_01HZXEXAMPLE0000000000001', plan: 'pro' };
const enabled = await fireweave.controlPoints.getBooleanValue(boolFlag, false, context);
console.log(`${boolFlag} enabled: ${enabled}`);

// 3. Detailed resolution: value + variant + reason (upgrades from `*Value`
// without restructuring the call — same arguments, richer return).
const details = await fireweave.controlPoints.getBooleanDetails(boolFlag, false, context);
console.log(`${boolFlag} details:`, {
  value: details.value,
  variant: details.variant,
  reason: details.reason,
});

// 4. Register the durable targeting facts for this user — once per login,
// not on every evaluation. Resolves `{ ok: false }` rather than throwing (it
// runs in sign-in paths); the offline default and the --remote stub (which
// has no /v1/targets/register route) both degrade the same, honest way.
const registered = await fireweave.registerTarget(context.targetingKey, {
  kind: 'user',
  properties: { plan: context.plan },
});
console.log(`registerTarget ok: ${registered.ok}${registered.ok ? '' : ` (${registered.error?.kind})`}`);

// 5. Clean shutdown.
await fireweave.shutdown();
console.log('shut down cleanly');
