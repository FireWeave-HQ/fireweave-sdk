# Migration guides

## From direct PostHog SDK calls

If your server calls `posthog-node` / `posthog` / `posthog-go` feature-flag APIs directly, Fireweave gives you the same PostHog evaluation (it wraps the same official SDK — no behavior re-implementation) plus: a vendor-neutral call surface (OpenFeature), a never-throw contract, a typed error taxonomy, in-memory testing, and the release-safety extensions.

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
