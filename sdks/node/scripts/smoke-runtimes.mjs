/**
 * Cross-runtime smoke: one script, run unchanged on Node, Bun, and Deno.
 *
 *   node scripts/smoke-runtimes.mjs
 *   bun  scripts/smoke-runtimes.mjs
 *   deno run --allow-read --allow-env scripts/smoke-runtimes.mjs
 *
 * Imports use deep RELATIVE paths on purpose, so the script contains no bare
 * specifiers and needs no npm resolution on any runtime. Paths point at the
 * layered dist tree (domain/, application/, infrastructure/) that Task 4's
 * layering pass introduced — a flat `dist/runtime.js` etc. no longer exists.
 * There is no OpenFeature-importing module to exclude here: the OpenFeature
 * provider was retired by ADR-0010 (the v1 cut), so every remaining export
 * this script imports is npm-resolution-free by construction.
 *
 * Asserts the things that actually differ between runtimes: UTF-8 byte counting
 * (TextEncoder, not Buffer), fetch/AbortController availability, and timers.
 * (The old `readEnv` check is gone along with it: spec/modes.md bans env
 * reads outright, so the SDK no longer exposes an env-reading helper at all.)
 */
import { FireweaveRuntime } from '../packages/sdk/dist/application/runtime.js';
import { FireweaveClient } from '../packages/sdk/dist/application/client.js';
import { InMemoryAdapter } from '../packages/sdk/dist/infrastructure/adapters/inmemory.js';
import { FireweaveRemoteAdapter } from '../packages/sdk/dist/infrastructure/adapters/remote.js';
// The dev substrate's ADAPTER only — pure computation, no I/O, no env, so it
// must behave identically on every runtime (ADR-0008).
import { FireweaveLocalAdapter } from '../packages/sdk/dist/infrastructure/adapters/local.js';
import { DEFAULT_CONTEXT_LIMITS } from '../packages/sdk/dist/domain/context.js';
import { canonicalizeContext } from '../packages/sdk/dist/domain/validation.js';
import { DEFAULT_ALLOWED_HOSTS } from '../packages/sdk/dist/infrastructure/hosts.js';
import { isFireweaveError } from '../packages/sdk/dist/domain/errors.js';

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const runtimeName = (() => {
  if (typeof globalThis.Deno !== 'undefined') return `deno ${globalThis.Deno.version.deno}`;
  if (typeof globalThis.Bun !== 'undefined') return `bun ${globalThis.Bun.version}`;
  if (typeof globalThis.process !== 'undefined') return `node ${globalThis.process.versions.node}`;
  return 'unknown runtime';
})();

console.log(`\nfireweave SDK cross-runtime smoke — ${runtimeName}\n`);

// --- platform primitives the SDK relies on ---------------------------------
check('fetch is available', typeof globalThis.fetch === 'function');
check('AbortController is available', typeof globalThis.AbortController === 'function');
check('TextEncoder is available', typeof globalThis.TextEncoder === 'function');
check('URL is available', typeof globalThis.URL === 'function');
check('setTimeout is available', typeof globalThis.setTimeout === 'function');

// --- UTF-8 byte counting (was Buffer.byteLength, now TextEncoder) ----------
// A 4-byte emoji must count as 4 bytes, not 1 character or 2 UTF-16 units.
const oversized = '🔥'.repeat(DEFAULT_CONTEXT_LIMITS.maxValueBytes);
let rejectedOversized = false;
try {
  canonicalizeContext(
    { targetingKey: 'user_42', attributes: { big: oversized } },
    {
      limits: DEFAULT_CONTEXT_LIMITS,
      reservedAttributeKeys: [],
      requireTargetingKey: false,
    },
  );
} catch (err) {
  rejectedOversized = isFireweaveError(err);
}
check('oversized attribute rejected via UTF-8 byte length', rejectedOversized);

const smallContext = canonicalizeContext(
  { targetingKey: 'user_42', attributes: { plan: 'pro', emoji: '🔥' } },
  { limits: DEFAULT_CONTEXT_LIMITS, reservedAttributeKeys: [], requireTargetingKey: false },
);
check('context canonicalization preserves attributes', smallContext.attributes.plan === 'pro');
check('multi-byte attribute values survive', smallContext.attributes.emoji === '🔥');

// --- control-point evaluation through the in-memory adapter ----------------
const runtime = new FireweaveRuntime(
  new InMemoryAdapter({
    flags: {
      'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
    },
  }),
);
await runtime.initialize();
check('runtime reaches READY', runtime.getState() === 'READY');

const client = new FireweaveClient(runtime);
const decision = await client.controlPoints.evaluate('new-checkout', 'boolean', false, {
  targetingKey: 'user_42',
});
check('control point evaluates to true', decision.value === true, `got ${decision.value}`);
check('decision carries TARGETING_MATCH', decision.reason === 'TARGETING_MATCH', decision.reason);

// --- the deprecated alias still works on every runtime ----------------------
check('client.flags aliases client.controlPoints', client.flags === client.controlPoints);
const viaAlias = await client.flags.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});
check('evaluation through the deprecated alias works', viaAlias === true);

// --- invokeCapability (v1's only extension-style surface) -------------------
// SUPPORTED_CAPABILITIES is frozen empty in v1 (releases/exposures/signals/
// capabilities discovery are all cut, ADR-0010): every capability string
// degrades UnsupportedCapability, never throws.
const capResult = client.invokeCapability('releases.teleport', {});
check(
  'invokeCapability degrades UnsupportedCapability (v1 has no supported capabilities)',
  capResult.ok === false && capResult.errorKind === 'UnsupportedCapability' && capResult.degraded === true,
);

// --- remote adapter config validation (no network) -------------------------
check('default allowlist names no vendor', !DEFAULT_ALLOWED_HOSTS.some((h) => /posthog/i.test(h)));

const unconfigured = new FireweaveRemoteAdapter({ apiUrl: '', apiKey: '' });
let configErrorKind = null;
try {
  await unconfigured.initialize();
} catch (err) {
  configErrorKind = isFireweaveError(err) ? err.kind : 'non-fireweave';
}
check('remote adapter rejects empty config as Configuration', configErrorKind === 'Configuration');

const badScheme = new FireweaveRemoteAdapter({
  apiUrl: 'http://app-server.fireweave.ai',
  apiKey: 'project-api-key_smoke',
});
let schemeErrorKind = null;
try {
  await badScheme.initialize();
} catch (err) {
  schemeErrorKind = isFireweaveError(err) ? err.kind : 'non-fireweave';
}
check('plain http on a non-loopback host is refused', schemeErrorKind === 'Configuration');

// --- dev substrate (FireweaveLocalAdapter) ---------------------------------
// Pure computation, no I/O and no env, so it must behave identically on every
// runtime. Exercised here because the harness's DEV branch is the code path a
// developer actually runs on a laptop — including a Bun or Deno one.
const devRuntime = new FireweaveRuntime(
  new FireweaveLocalAdapter({ devFlags: { 'fw-dogfood': true } }),
);
await devRuntime.initialize();

const devOn = await devRuntime.evaluate('fw-dogfood', 'boolean', false, {
  targetingKey: 'user_42',
});
check('devFlags override resolves STATIC', devOn.value === true && devOn.reason === 'STATIC');

const devMiss = await devRuntime.evaluate('fw-unconfigured', 'boolean', false, {
  targetingKey: 'user_42',
});
check('unconfigured control point carries the call-site default', devMiss.value === false);

const devFeatures = new FireweaveLocalAdapter().features();
check(
  'local adapter reports a non-networked backend',
  devFeatures.localOnly === true && devFeatures.remoteEvaluation === false,
);
await devRuntime.shutdown();

await runtime.shutdown();
check('runtime reaches SHUTDOWN', runtime.getState() === 'SHUTDOWN');

// --- result ----------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed on ${runtimeName}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  throw new Error(`cross-runtime smoke failed on ${runtimeName}`);
}
console.log(`all checks passed on ${runtimeName}\n`);
