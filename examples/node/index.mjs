/**
 * Fireweave SDK — minimal Node example.
 *
 * Default mode runs fully OFFLINE against the deterministic in-memory adapter.
 *
 * Production path (ADR-0005):
 *   --remote  + FW_API_URL + FW_PROJECT_API_KEY  → FireweaveRemoteAdapter (fw-server / stub)
 *
 * Advanced (direct PostHog — not the product default):
 *   --posthog + POSTHOG_HOST + POSTHOG_API_KEY
 *
 * Stub: node test-server/implementation/server.mjs  (127.0.0.1:3901)
 */
import { OpenFeature } from '@openfeature/server-sdk';
import {
  FireweaveClient,
  FireweaveProvider,
  FireweaveRemoteAdapter,
  FireweaveRuntime,
  InMemoryAdapter,
} from '@fireweaveai/sdk';

const useRemote = process.argv.includes('--remote') || process.env.FW_API_URL !== undefined;
const usePostHog = process.argv.includes('--posthog');

// ---------------------------------------------------------------------------
// 1. Configure a backend adapter.
async function makeAdapter() {
  if (useRemote) {
    return new FireweaveRemoteAdapter({
      apiUrl: process.env.FW_API_URL ?? 'http://127.0.0.1:3901',
      apiKey: process.env.FW_PROJECT_API_KEY ?? 'project-api-key_dev',
      requestTimeoutMs: 3000,
    });
  }
  if (usePostHog) {
    const { PostHogAdapter } = await import('@fireweaveai/sdk/posthog');
    return new PostHogAdapter({
      projectApiKey: process.env.POSTHOG_API_KEY ?? 'phc_example',
      host: process.env.POSTHOG_HOST ?? 'http://127.0.0.1:3901',
      featureFlagsRequestTimeoutMs: 3000,
    });
  }
  // Offline default: deterministic in-memory flags (great for tests/CI).
  return new InMemoryAdapter({
    flags: {
      'new-checkout': {
        type: 'boolean',
        enabled: true,
        value: true,
        variant: 'on',
        metadata: { version: 4 },
      },
      'checkout-theme': {
        type: 'string',
        enabled: true,
        value: 'midnight',
        variant: 'midnight',
        // Only members of the beta cohort get the variant:
        matchAttribute: { cohort: 'beta' },
      },
    },
  });
}

const adapter = await makeAdapter();

// Stub fixture keys when talking to the Fireweave remote protocol.
const boolFlag = useRemote ? 'fw-bool-on' : 'new-checkout';
const stringFlag = useRemote ? 'fw-string-theme' : 'checkout-theme';

// 2. Build the runtime + provider and register with OpenFeature.
const runtime = new FireweaveRuntime(adapter, {
  ...(usePostHog
    ? {
        projectApiKey: process.env.POSTHOG_API_KEY ?? 'phc_example',
        host: process.env.POSTHOG_HOST ?? 'http://127.0.0.1:3901',
      }
    : {}),
});
const provider = new FireweaveProvider(runtime, { lazyReady: false });
await OpenFeature.setProviderAndWait('checkout', provider);
const flags = OpenFeature.getClient('checkout');

// 3. Evaluate a boolean flag with a targeting context.
const context = { targetingKey: 'user_01HZXEXAMPLE0000000000001', cohort: 'beta', plan: 'pro' };
const enabled = await flags.getBooleanValue(boolFlag, false, context);
console.log(`${boolFlag} enabled: ${enabled}`);

// 4. Detailed resolution: value + variant + reason + Fireweave metadata.
const details = await flags.getStringDetails(stringFlag, 'classic', context);
console.log(`${stringFlag} details:`, {
  value: details.value,
  variant: details.variant,
  reason: details.reason,
  flagMetadata: details.flagMetadata,
});

if (!useRemote) {
  // Targeting: a user outside the beta cohort falls back to the default.
  const fallback = await flags.getStringValue(stringFlag, 'classic', {
    targetingKey: 'user_01HZXEXAMPLE0000000000002',
  });
  console.log(`${stringFlag} for non-beta user: ${fallback}`);
}

// 5. Fireweave extensions: detailed evaluation, releases, signals, exposures.
const fireweave = new FireweaveClient(runtime);

// Detailed Decision-returning evaluation on the public client surface:
const decision = await fireweave.flags.evaluate(boolFlag, 'boolean', false, context);
console.log(`flags.evaluate reason: ${decision.reason}`);

// Ratified ID shapes: stmp_/chg_/sfc_ + 26-char Crockford ULIDs.
const release = fireweave.releases.setContext({
  stampIds: ['stmp_01HZXEXAMPE000000000000001'],
  rolloutId: 'rollout_01HZXEXAMPE000000000000001',
  changeId: 'chg_01HZXEXAMPE000000000000001',
  surfaces: [{ surfaceId: 'sfc_01HZXEXAMPE000000000000001', kind: 'node-server' }],
});
console.log('release context set:', release.ok);

fireweave.signals.recordHealth({ name: 'checkout-api', status: 'healthy' });
fireweave.exposures.record({
  targetingKey: context.targetingKey,
  flagKey: boolFlag,
  value: enabled,
  variant: enabled ? 'on' : undefined,
});
await fireweave.exposures.flush();
console.log('capabilities:', fireweave.capabilities.get().runtime);

// 6. Clean shutdown (flushes queued telemetry, closes the provider).
await OpenFeature.close();
console.log('shut down cleanly');
