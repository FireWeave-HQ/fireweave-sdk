# Migration guides

## From `@fireweaveai/sdk` v2.0 to 2.1 (Node)

**One change is mandatory.** If you imported the direct vendor adapter, switch to `FireweaveRemoteAdapter`. Everything else in v2 still works — this section exists mostly to tell you what you *don't* have to do.

The full step-by-step — including the rename-scoping rules — is in the [Node module README](../sdks/node/packages/sdk/README.md#upgrading-from-v20-to-21). This page is the condensed, cross-language view.

### Required

```ts
// before
import { PostHogAdapter } from '@fireweaveai/sdk/posthog';
const adapter = new PostHogAdapter({
  projectApiKey: process.env.POSTHOG_API_KEY,
  host: process.env.POSTHOG_HOST,
  featureFlagsRequestTimeoutMs: 3000,
});

// after
import { FireweaveRemoteAdapter } from '@fireweaveai/sdk';
const adapter = new FireweaveRemoteAdapter({
  apiUrl: process.env.FW_API_URL,
  apiKey: process.env.FW_PROJECT_API_KEY,
  requestTimeoutMs: 3000,
});
```

| Before | After |
| --- | --- |
| `POSTHOG_HOST` | `FW_API_URL` — your fw-server base URL |
| `POSTHOG_API_KEY` (`phc_…`) | `FW_PROJECT_API_KEY` (`project-api-key_…`) |
| `featureFlagsRequestTimeoutMs` | `requestTimeoutMs` |
| `secretApiKey` / `onlyEvaluateLocally` / `featureFlagsPollingInterval` | no equivalent — see "local evaluation" below |
| `posthog-node` in your `package.json` | remove it, unless you use it for your own analytics |

Also drop `projectApiKey`/`host` from `FireweaveRuntimeConfig` if you set them only to satisfy the old adapter's validation; the remote adapter takes its own options. Keep `host` if you relied on the runtime-level allowlist check.

### Not required — v2 names still work

| v2 | Status in 2.1 |
| --- | --- |
| `client.flags.evaluate/getBooleanValue/…` | works, identical object to `client.controlPoints` |
| `new InMemoryAdapter({ flags })` | unchanged |
| `Decision.flagKey`, `Exposure.flagKey`, `flagMetadata` | unchanged |
| `FlagValueType`, `InMemoryFlagDefinition`, `ExpectedFlagType` | unchanged |
| `capabilities.get().static.features.flags` | still `true` (`controlPoints: true` added beside it) |
| every other v2 export | unchanged — pinned by `test/compat/v2-surface.compat.test.ts` |

Renaming `client.flags` to `client.controlPoints` is cosmetic and can be deferred indefinitely. Set `FW_DEPRECATION_WARNINGS=1` to get one notice per process; the SDK is silent otherwise.

### Type-level changes

`'posthog'` is no longer a member of `BackendAdapter['name']` or `Capabilities['runtime']['backend']`. This affects you only if you wrote a custom adapter declaring `name: 'posthog'` (use `'other'`), or an exhaustive `switch` on `backend` with a `posthog` arm (that arm is now unreachable).

### Local evaluation

v2's vendor adapter could evaluate in-process from polled definitions with a secret key. 2.1 has no equivalent: caching is fw-server's concern, and both shipped adapters report `localEvaluation: false`. If in-process evaluation is load-bearing for you — an air-gapped service, or a hard latency floor below a network hop — stay on v2 for now and tell us; the interface seam for a Fireweave-native cache is deliberately preserved ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)).

### Behavior worth re-checking

1. **`DEFAULT_ALLOWED_HOSTS` changed contents.** Still exported, still the same name — but it now lists Fireweave hosts, not vendor hosts. Code doing `allowedHosts: [...DEFAULT_ALLOWED_HOSTS, 'mine.example']` keeps compiling and no longer permits the old endpoints. That is intended; verify it matches your deployment.
2. **Person properties should move to `registerTarget`.** Attributes you sent on every evaluation can be registered once per login instead ([remote.md](remote.md#two-identity-paths)). Per-request attributes still override stored properties, so this is an optimization, not a cutover — but skipping it entirely means rules that expect stored properties match nobody.
3. **`sdkVersion` is now accurate.** `capabilities.get().static.sdkVersion` returned `0.1.0` in v2 regardless of the package version; it now tracks `package.json` and is pinned by a test.

### Runtimes

2.1 runs on Bun and Deno in addition to Node ([runtimes.md](runtimes.md)). Nothing to do if you are on Node.

## From direct PostHog SDK calls

> **Scope:** the direct-vendor mapping below applies to the **Python, Go, and Java** SDKs, which still ship a vendor adapter that wraps the official SDK. The **Node** SDK removed it in 2.1 ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)) — on Node, evaluation goes through fw-server, so treat the API mapping as accurate and the "wraps the same official SDK" parity argument as no longer applying. Bucketing parity is then fw-server's responsibility rather than the SDK's; validate in staging.

If your server calls `posthog-node` / `posthog` / `posthog-go` feature-flag APIs directly, Fireweave gives you the same evaluation semantics plus: a vendor-neutral call surface (OpenFeature), a never-throw contract, a typed error taxonomy, in-memory testing, and the release-safety extensions.

### API mapping (Node shown; other languages analogous)

| Direct posthog-node | Fireweave / OpenFeature |
| --- | --- |
| `client.isFeatureEnabled(key, distinctId)` | `ofClient.getBooleanValue(key, false, { targetingKey: distinctId })` |
| `client.getFeatureFlag(key, distinctId)` (variant string) | `ofClient.getStringValue(key, 'control', { targetingKey: distinctId })` or `getStringDetails(...).variant` |
| `client.getFeatureFlagPayload(key, distinctId)` | Object flag: `ofClient.getObjectValue(key, {}, ctx)`; or enable `includePayload` on the provider and read `flagMetadata['fireweave.payload']` (JSON string) |
| `evaluateFlags(distinctId, { personProperties })` | Context attributes: `{ targetingKey, plan: 'pro', … }` |
| `groups` / `groupProperties` options | Group carriers in context — per-language spelling in [identity.md](identity.md#groups) |
| `client.capture(...)` for exposure/analytics events | Evaluation-path exposures per adapter policy; explicit `fireweave.exposures.record/flush` ([extensions.md](extensions.md#exposures)). General analytics capture stays on your PostHog SDK |
| `client.shutdown()` | `OpenFeature.close()` (see [lifecycle.md](lifecycle.md)) |

### Behavior changes to expect

1. **No exceptions from flag reads.** Direct SDK calls can reject/throw on transport errors; Fireweave always returns your default with an `errorCode`. Audit call sites that relied on try/catch around flag reads — inspect `*Details().errorCode` instead.
2. **Identity is explicit and required.** Missing `distinct_id` becomes a `TARGETING_KEY_MISSING` default resolution instead of vendor-specific behavior ([identity.md](identity.md)).
3. **Deprecated per-flag endpoints are not used.** Fireweave evaluates via the `/flags?v=2` snapshot API exclusively. If you relied on legacy per-flag call behavior, validate targeting parity in staging.
4. **Quota limiting is not an outage.** Empty quota-limited snapshots resolve as `FLAG_NOT_FOUND` + `fireweave.quotaLimited: true` metadata ([posthog.md](posthog.md#quota-behavior)).
5. **Exposure events may stop flowing implicitly.** Current adapter defaults favor side-effect-free reads (Node/Python; Go behind `SendExposureEvents`). If your funnels depend on `$feature_flag_called`, enable exposure emission or record exposures explicitly — check `capabilities.get().runtime.features.exposureEmission`.
6. **Keep your analytics capture path.** Fireweave replaces flag evaluation, not event capture. You can inject your existing PostHog client into the adapter (advanced init) so flags and analytics share one connection — Fireweave will not shut down an injected client.

### Incremental path

Register the Fireweave provider, migrate call sites getter-by-getter, and compare results in logs (the `*Details` getters carry `variant`/`reason` for diffing). Old and new paths can coexist against the same PostHog project — flag definitions and bucketing are identical because the underlying evaluator is the same official SDK.

## From another OpenFeature provider (LaunchDarkly, flagd, GO Feature Flag, …)

Your application code — every `getBooleanValue`/`getStringDetails` call site, hooks, domains — **does not change**. That's the point of OpenFeature. What changes:

1. **Provider registration** — one place per service:

```js
// before: await OpenFeature.setProviderAndWait(new SomeOtherProvider(config));
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));
```

2. **Flag data must exist in PostHog.** Recreate flags (keys, variants, targeting rules, payloads) in PostHog; there is no automatic importer. Keep flag keys identical so call sites don't change.
3. **Targeting semantics differ by vendor.** Percentage bucketing hashes differently — a user in the 10% cohort with vendor A may not be with PostHog. For in-flight ramps, plan a cutover (complete the ramp, or re-ramp after switching), don't assume cohort continuity.
4. **Context attribute names** map to PostHog person properties; rules referencing vendor-specific attributes (e.g. LaunchDarkly's `kind`/multi-contexts) need re-expression as person/group properties. `kind` is a reserved attribute name in Fireweave — rename it.
5. **flagMetadata namespaces differ** — vendor-prefixed metadata keys become `fireweave.*` keys ([openfeature.md](openfeature.md#detailed-resolution)).
6. **Events/status**: Fireweave synthesizes READY/ERROR from initialize like other shipped providers; if you consumed vendor-specific streaming-update events, PostHog local eval refreshes by polling (default 30 s), so `CONFIG_CHANGED`-driven logic sees coarser granularity.
7. **Test doubles**: swap vendor test fixtures for Fireweave's `InMemoryAdapter` ([testing.md](testing.md)) — your OpenFeature-level test assertions stay unchanged.

Rollback is symmetric: keep the old provider wiring behind a config switch until you trust the cutover; because call sites are provider-agnostic, switching back is one registration line.

## From `@fireweaveai/deploy-sdk` (proprietary)

The deploy-attestation wire contract (boot beacon / stamp liveness, `FW_ATTEST_URL` / `FW_PROJECT_API_KEY` env vars) is carried by `releases.setContext` + `releases.start` in this SDK ([extensions.md](extensions.md#releases)) — re-specified for compatibility, not code-copied. The long-term relationship between the two packages is an open company decision (ADR-0001 §9); for new services prefer this SDK.

Control-point evaluation has now moved here in full. deploy-sdk keeps release engineering — attestation, OTel wiring, flag-anchor scanning, `isProd()`, the eject codemod — and both of its local providers are deprecated with a one-notice-per-process warning pointing at the replacements below. They still work; nothing is removed.

### Server dev provider → `makeFireweaveLocalProvider()`

```ts
// before — @fireweaveai/deploy-sdk/flags
import { FireweaveLocalProvider } from '@fireweaveai/deploy-sdk/flags';
return new FireweaveLocalProvider({ echo: true, devFlags: { 'my-feature': true } });

// after — @fireweaveai/sdk ≥ 2.1.0
import { makeFireweaveLocalProvider } from '@fireweaveai/sdk';
return makeFireweaveLocalProvider({ echo: true, devFlags: { 'my-feature': true } });
```

Options are identical (`devFlags`, `echo`, `now`), and `getFwLocalCaptures()` / `resetFwLocalCaptures()` keep their names.

**What changes underneath.** The deploy-sdk class was a standalone provider that bypassed the runtime. The replacement is a `FireweaveLocalAdapter` behind the ordinary `FireweaveRuntime`, so the DEV branch of a harness now inherits the same lifecycle gating and context canonicalization as its PROD branch — which is the point, since dev/prod skew in the harness is what the harness exists to prevent.

**One behaviour difference, deliberate.** Reading a `devFlags` key as a string or number now yields `TYPE_MISMATCH` instead of silently returning the default. `devFlags` is `Record<string, boolean>`, so such a read is a call-site mistake, and surfacing it is the point. Unconfigured keys are unaffected: they still resolve to the caller's default with reason `DEFAULT`, never as an error.

### Browser → `@fireweaveai/web-sdk`

`@fireweaveai/deploy-sdk/flags/web` → `@fireweaveai/web-sdk` ([ADR-0009](adr/0009-browser-control-points.md)).

```ts
// before
import {
  makeFireweaveRemoteWebProvider,
  resolveFireweaveWebCredentials,
} from '@fireweaveai/deploy-sdk/flags/web';
const provider = makeFireweaveRemoteWebProvider(import.meta.env);

// after — credentials are passed IN; the SDK reads no environment at all
import { FireweaveRemoteWebAdapter, FireweaveWebProvider, FireweaveWebRuntime }
  from '@fireweaveai/web-sdk';
import { resolveFireweaveWebCredentials } from '@fireweaveai/deploy-sdk/flags/web';

const creds = resolveFireweaveWebCredentials(import.meta.env);
const runtime = new FireweaveWebRuntime(new FireweaveRemoteWebAdapter(creds), {
  globalContext: { targetingKey: 'anonymous' },
});
const provider = new FireweaveWebProvider(runtime);
```

| deploy-sdk `flags/web` | `@fireweaveai/web-sdk` |
| --- | --- |
| `makeFireweaveRemoteWebProvider(env)` | `new FireweaveWebProvider(new FireweaveWebRuntime(new FireweaveRemoteWebAdapter({ apiUrl, apiKey })))` |
| `FireweaveLocalWebProvider` | `FireweaveLocalWebAdapter` behind the same runtime |
| `provider.reloadFlags(key)` | `runtime.setContext({ targetingKey: key })` — returns the control points whose decisions moved |
| `fireweaveRegisterTarget(creds, …)` | `client.identify(key, { properties })` — registers **and** re-prefetches |
| `resolveFireweaveWebCredentials(env)` | **stays in deploy-sdk.** `PUBLIC_FW_*` is a build convention, not a wire concern |
| `initFwTelemetry`, `registerFwWebFlagHooks`, `isProd` | **stay in deploy-sdk** — release engineering, not control points |

**Three behaviour changes worth reading before you switch.**

1. **A timed-out prefetch is now visible.** deploy-sdk raced the prefetch against a 5s ceiling and resolved silently, so a failed boot was indistinguishable from a successful one where every control point happened to be off. The runtime now enters `STALE` and serves defaults with `reason: 'STALE'`. Still fail-open — boot is never blocked — but no longer fail-silent. Under a progressive rollout this is the difference between "the ramp is at 0%" and "the SDK never reached the server".
2. **No environment reads.** The package never touches `import.meta.env`, `process`, or `Deno.env`. Keep using `resolveFireweaveWebCredentials` from deploy-sdk and pass the result in.
3. **Secret key shapes are refused at construction.** `phc_`/`phs_`/`phx_` throw `FireweaveError('Configuration')` before any request is made.

**Before production**, note the credential caveat in [ADR-0009](adr/0009-browser-control-points.md): a browser key is public by construction and is currently the whole authorization boundary, so a scoped `fw_public_…` key family plus per-key rate limiting is required platform work.

**No `flags` alias here.** `client.controlPoints` is the only name on the web client. The server SDK carries `client.flags` for v2 compatibility; this package has no v2 to be compatible with, so it starts with the current vocabulary and nothing to migrate off.
