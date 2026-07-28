# Using Fireweave via OpenFeature

All flag evaluation goes through the standard OpenFeature client. Fireweave supplies a provider (`FireweaveProvider`, metadata name `"fireweave"`) per language; everything in this document is **OpenFeature standard** behavior unless labeled otherwise. Compliance floor: OpenFeature specification **v0.8.0** (ADR-0003).

- Node: `@openfeature/server-sdk` 1.22.0
- Python: `openfeature-sdk` >= 0.10, < 0.11 (pre-1.0; see [compatibility.md](compatibility.md))
- Go: `github.com/open-feature/go-sdk` v1.17.2
- Java: `dev.openfeature:sdk` 1.15.1

## Registering the provider

The provider wraps a `FireweaveRuntime` (Node/Python/Java) or a `fireweave.Client` (Go). Registration initializes the shared runtime.

```js
// Node — [OpenFeature standard]
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));
```

By default the Node provider uses `lazyReady: true` **[Fireweave extension]**: `initialize()` returns immediately, initialization proceeds in the background, and evaluations return the default with `PROVIDER_NOT_READY` (plus `fireweave.errorKind` metadata) until the runtime is READY. Pass `lazyReady: false` to make `setProviderAndWait` actually wait.

```python
# Python
api.set_provider(FireweaveProvider(runtime))                 # sync init
# FireweaveProvider(runtime, backend_required=True) makes init fail fatally
# when the backend config is missing/invalid (PROVIDER_FATAL).
```

```go
// Go — the provider wraps the Fireweave *Client*, not the runtime directly.
client := fireweave.NewClient(fireweave.NewRuntime(adapter, fireweave.Config{}))
err := of.SetProviderAndWait(fwprovider.NewProvider(client))
```

```java
// Java
OpenFeatureAPI.getInstance().setProviderAndWait("my-domain", new FireweaveProvider(runtime));
```

## Typed resolvers

| Getter | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| Boolean | `getBooleanValue/Details` | `get_boolean_value/details` | `Boolean / BooleanValueDetails` | `getBooleanValue/Details` |
| String | `getStringValue/Details` | `get_string_value/details` | `String / StringValueDetails` | `getStringValue/Details` |
| Number | `getNumberValue/Details` (one `number` type) | `get_integer_*` and `get_float_*` | `Int / Float …` | `getIntegerValue/Details` and `getDoubleValue/Details` |
| Object | `getObjectValue/Details` | `get_object_value/details` | `ObjectValueDetails` | `getObjectValue/Details` |

Numeric caveats (pre-declared conformance limitations — see [compatibility.md](compatibility.md)):

- **Node** exposes a single `number` resolver; integers beyond 2^53−1 are not lossless.
- **Java**'s integer resolver is 32-bit `int`; integral flag values outside `Integer` range resolve as `TYPE_MISMATCH` + default (never silent truncation).
- Cross-language integer reliability is guaranteed within ±(2^53−1).

A type mismatch between the stored flag value and the requested getter returns the **default value** with `errorCode = TYPE_MISMATCH`. Evaluation never throws (spec §1.4.10): every failure mode returns your default with an error code.

## Detailed resolution

The `*Details` getters return value, `variant`, `reason`, `errorCode`/`errorMessage`, and `flagMetadata`:

```js
const details = await client.getStringDetails('checkout-theme', 'classic', context);
// details.value        'midnight'
// details.variant      'midnight'
// details.reason       'TARGETING_MATCH' | 'DISABLED' | 'STALE' | 'ERROR' | ...
// details.flagMetadata { 'fireweave.flagVersion': 4, ... }
```

`flagMetadata` keys under the `fireweave.*` namespace are **[Fireweave extension]** enrichment — scalar-only per the OpenFeature contract, never required to read the flag value:

| Key | Meaning |
| --- | --- |
| `fireweave.flagVersion` | Flag definition version reported by the backend |
| `fireweave.errorKind` | Canonical Fireweave error kind on error decisions ([concepts.md](concepts.md#error-taxonomy)) |
| `fireweave.quotaLimited` | `true` when the backend was quota-limited ([posthog.md](posthog.md#quota-behavior)) |
| `fireweave.fromCache` | `true` when served from a last-good/stale cache |
| `fireweave.vendorFlagId`, `fireweave.reasonCode` | Vendor diagnostics; emitted **only** when the backend reports both a flag id and a matched condition index |
| `fireweave.payload` | Flag payload as a sorted-key JSON *string*; only when payload attachment is enabled (`includePayload` provider option) |

## Evaluation context

Identity is caller-owned: set `targetingKey` to a stable identifier (it maps 1:1 to the PostHog `distinct_id`; see [identity.md](identity.md)). Non-reserved attributes become person properties on PostHog-backed evaluation.

The OpenFeature SDK merges context layers per spec §3.2.3 — later wins:

```
API (global)  →  transaction  →  client  →  invocation  →  before-hook output
```

Fireweave does not re-merge; the provider receives the merged context. Context bounds are enforced before any network call **[Fireweave extension]**: max 128 attributes, 256-byte keys, 4-KiB values, nesting depth 6, 64-KiB serialized context. Violations return the default with `INVALID_CONTEXT`; a missing `targetingKey` (when required) returns `TARGETING_KEY_MISSING`.

Reserved keys: `targetingKey`, `kind`, and the `fireweave.*` namespace are reserved attribute names. Group targeting uses dedicated context carriers — the exact spelling currently differs per language; see [identity.md](identity.md#groups).

Transaction context (spec §3.3) is an **[Experimental]** OpenFeature feature: usable where your OpenFeature SDK ships it, but no Fireweave API depends on it.

## Domains

Providers are safe to bind to multiple OpenFeature domains; provider state lives in the shared runtime, which is domain-agnostic:

```js
await OpenFeature.setProviderAndWait('checkout', provider);   // domain-scoped
const flags = OpenFeature.getClient('checkout');
```

Do not share one runtime across conflicting credential sets — use one runtime per backend project. The Node `initialize(context, domain?)` draft parameter is accepted and ignored; Fireweave does not declare `domainScoped` **[Experimental — not declared]**.

## Hooks

Standard OpenFeature hooks work unmodified. The provider ships an **empty provider-hook list**; telemetry/logging hooks are opt-in and yours to register.

Policy (ADR-0003):

- **Allowed**: before-hooks that enrich the standard evaluation context; observability hooks (logging/OTel) that read evaluation details; reading `fireweave.*` flagMetadata in after-hooks.
- **Never required**: no Fireweave feature requires a hook or a proprietary hook hint. Everything on the extension surface is callable via `FireweaveClient` with zero hooks registered ([extensions.md](extensions.md)).

## Events and provider status

The SDK you register with synthesizes `PROVIDER_READY` / `PROVIDER_ERROR` from the provider's `initialize` outcome (shipped OpenFeature behavior). Status mapping from the Fireweave lifecycle is described in [lifecycle.md](lifecycle.md). The runtime signals meaningful definition refreshes and staleness through its state (STALE → OpenFeature `STALE`).

## Tracking

OpenFeature spec §6 tracking is **[Planned — not implemented]** in all four languages. Record exposures and outcome signals through the Fireweave extension APIs instead ([extensions.md](extensions.md)).

## Side effects of evaluation

Whether an evaluation may emit a `$feature_flag_called`-style exposure event is controlled by adapter configuration / per-call options, not by the OpenFeature call site. **Phase-one portable default is side-effect-free:** Node and Python PostHog adapters use side-effect-free snapshot reads (exposures flow through the explicit `exposures` API); Go emits vendor exposure events only when `SendExposureEvents: true` or `EvaluateOptions.SendExposure` arms the gate. See [extensions.md](extensions.md#exposures), [posthog.md](posthog.md), and ADR-0001 §6/§23 errata.
