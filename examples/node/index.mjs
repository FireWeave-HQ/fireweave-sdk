/**
 * Fireweave SDK — minimal Node example.
 *
 * Default mode runs fully OFFLINE against the deterministic in-memory adapter.
 * Pass --posthog (plus optional env) to talk to a PostHog-protocol backend:
 *   POSTHOG_HOST     e.g. http://127.0.0.1:3901  (the repo's test-server stub)
 *   POSTHOG_API_KEY  e.g. phc_example
 *
 * Demonstrates: provider configuration, OpenFeature registration, boolean
 * evaluation, detailed resolution, targeting context, releases.setContext +
 * signals.recordHealth, exposures, and clean shutdown.
 */
import { OpenFeature } from '@openfeature/server-sdk';
import {
  FireweaveClient,
  FireweaveProvider,
  FireweaveRuntime,
  InMemoryAdapter,
} from '@fireweaveai/sdk';

const usePostHog = process.argv.includes('--posthog');

// ---------------------------------------------------------------------------
// 1. Configure a backend adapter.
async function makeAdapter() {
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
const enabled = await flags.getBooleanValue('new-checkout', false, context);
console.log(`new-checkout enabled: ${enabled}`);

// 4. Detailed resolution: value + variant + reason + Fireweave metadata.
const details = await flags.getStringDetails('checkout-theme', 'classic', context);
console.log('checkout-theme details:', {
  value: details.value,
  variant: details.variant,
  reason: details.reason,
  flagMetadata: details.flagMetadata,
});

// Targeting: a user outside the beta cohort falls back to the default.
const fallback = await flags.getStringValue('checkout-theme', 'classic', {
  targetingKey: 'user_01HZXEXAMPLE0000000000002',
});
console.log(`checkout-theme for non-beta user: ${fallback}`);

// 5. Fireweave extensions: releases, signals, exposures.
const fireweave = new FireweaveClient(runtime);
const release = fireweave.releases.setContext({
  stampIds: ['stamp_01HZXEXAMPLE000000000001'],
  rolloutId: 'rollout_01HZXEXAMPLE00000000001',
  surfaces: [{ surfaceId: 'checkout-api', kind: 'node-server' }],
});
console.log('release context set:', release.ok);

fireweave.signals.recordHealth({ name: 'checkout-api', status: 'healthy' });
fireweave.exposures.record({
  targetingKey: context.targetingKey,
  flagKey: 'new-checkout',
  value: enabled,
  variant: enabled ? 'on' : undefined,
});
await fireweave.exposures.flush();
console.log('capabilities:', fireweave.capabilities.get().runtime);

// 6. Clean shutdown (flushes queued telemetry, closes the provider).
await OpenFeature.close();
console.log('shut down cleanly');
