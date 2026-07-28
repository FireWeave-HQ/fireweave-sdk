# Fireweave Java SDK

Java implementation of the Fireweave polyglot SDK (OpenFeature-compatible, server-first,
PostHog-backed per ADR-0002). Java 11+ source/target, Maven multi-module.

## Modules

| Module | Contents |
| --- | --- |
| `fireweave-sdk` | Vendor-neutral core: `FireweaveRuntime` (lifecycle state machine), `FireweaveClient` (+ releases / exposures / signals / guardrails / capabilities facades), canonical types (`EvaluationContext`, `Decision`, `JsonValue`, `ErrorKind`/`FireweaveException`), `BackendAdapter` seam, context validation, secret redaction. Zero runtime dependencies. |
| `fireweave-openfeature` | `FireweaveProvider` implementing `dev.openfeature.sdk.FeatureProvider`: all five resolvers, initialize/shutdown, error-code mapping, `targetingKey` → `distinct_id`. |
| `fireweave-adapter-posthog` | `PostHogAdapter` (ADR-0002 semantics) over the internal `PostHogClientApi` seam. **Real vendor binding blocked** — see deviations. |
| `fireweave-testing` | `InMemoryAdapter` (deterministic fixture resolution + in-process fault simulation) and the conformance runner. |

## Build / test / conformance

```bash
cd sdks/java
mvn install                      # build + all unit tests + JUnit conformance run
mvn -pl fireweave-testing exec:java   # standalone conformance runner
#   writes target/compatibility-report.java.json (relative to CWD; pass args to override:
#   -Dexec.args="<contracts-dir> <output-file>")
cd ../../examples/java && mvn -q compile exec:java   # runnable example (offline)
```

## Thread-safety guarantees

- **`FireweaveRuntime`** — fully thread-safe. Lifecycle transitions (`initialize`, `shutdown`)
  are serialized on an internal lock; `evaluate` reads the volatile state without locking, so
  concurrent evaluations never contend. An evaluation racing a shutdown either completes
  normally or returns an `AlreadyClosed` default decision — it never throws.
- **`FireweaveClient`** — fully thread-safe. Exposure queue mutations synchronize on the queue;
  release status uses `ConcurrentHashMap`; extension facades return `ExtensionResult` and never
  throw on the normal path.
- **`FireweaveProvider`** — stateless facade over the runtime; safe for concurrent resolution.
- **Configuration and contexts** (`FireweaveConfig`, `EvaluationContext`, `ContextLimits`,
  `ReleaseContext`, `Signal`, `Decision`, `JsonValue`) are deeply immutable.
- **Adapters** must be safe for concurrent `evaluate` after `initialize` returns (documented on
  `BackendAdapter`); `InMemoryAdapter` and `PostHogAdapter` comply.
- **No static global clients** — everything is constructed and injected explicitly
  (plain constructors + builders; no Spring or any DI framework required).

## Error model

The 15 PascalCase kinds live in `ErrorKind` (validated 1:1 against `contracts/errors.json` by
`ErrorTaxonomyTest`), carried by enum-kinded `FireweaveException`. Defaults are never thrown on
the normal evaluation path; causes are preserved; all messages pass `Redaction` (phc_/phs_/phx_,
`Bearer` tokens, `FW_PROJECT_API_KEY` assignments → `[REDACTED]`). `AlreadyClosed` maps to
OpenFeature `PROVIDER_NOT_READY`.

## Context handling

Merge order (later wins): config global → client → invocation. Ratified bounds enforced before
any adapter/network call: 128 attributes, 256 B keys, 4 KiB values, depth 6, 64 KiB serialized.
`fireweave.*` attribute keys are reserved, with exactly two canonical carve-outs (rulings 12–14):
`fireweave.groups` and `fireweave.groupProperties` are accepted as the primary cross-language
path and promoted into the context's first-class groups/groupProperties fields before
validation; every other `fireweave.*` key is `InvalidContext`. The `EvaluationContext.Builder`
`.group()` / `.groupProperty()` methods are idiomatic sugar over the same canonical
representation. Additional reserved keys are configurable.

## Security defaults

- **Host allowlist (default-on, canonical cross-language list):** `app.posthog.com`,
  `us.posthog.com`, `eu.posthog.com`, `us.i.posthog.com`, `eu.i.posthog.com` + loopback
  (`localhost`, `127.0.0.1`, `::1`). https is required off-loopback (http on loopback only);
  self-hosted instances must be explicitly allowlisted via `allowedHosts` (or the explicit
  `"*"` opt-out, which still enforces https). An empty allowlist denies every host.
- **Bounded shutdown:** `FireweaveRuntime.shutdown()` closes the adapter on a daemon thread and
  waits at most `shutdownTimeoutMs` (default 10 000 ms); on expiry it records a `Timeout`
  `lastError` and returns — a wedged vendor client can never hang process exit.
- **Exposure dedup clear-on-flush:** `PostHogAdapter`'s exposure dedup set is scoped to one
  flush window (`BackendAdapter.onExposuresFlushed()` clears it), so it cannot grow unbounded.

## Deviations & blockers (for orchestrator arbitration)

1. **`dev.openfeature:sdk` pinned 1.21.0 → built against 1.15.1.** 1.15.1 is the newest version
   on Maven Central (verified 2026-07-27 via search.maven.org). No API gaps encountered for the
   features used.
2. **Java PostHog is seam only / not production-ready.** `com.posthog:posthog-server` does not
   exist on Maven Central (verified 2026-07-27; only Android/`posthog` 3.x and prohibited legacy
   `com.posthog.java:posthog` 1.2.0). Fireweave does not bind unpublished packages.
   `PostHogAdapter` is tested against the Fireweave-owned `PostHogClientApi` injection seam;
   `PostHogAdapter.create(config)` returns `UnsupportedCapability` (API keys alone cannot create
   a live PostHog-backed client). Prefer `InMemoryAdapter` until upstream publishes a server SDK.
3. **Fault fixtures run twice** (Phase 5 close-out of the original "stub not runnable"
   deviation): deterministically in-process via `InMemoryAdapter` (delay compares against the
   configured timeout — no sleeping) in `ConformanceTest`, AND against the real HTTP stub
   (`test-server/implementation/server.mjs`, spawned as a child node process) through the
   `PostHogClientApi` seam's test HTTP client in `HttpFaultConformanceTest` — real sockets,
   timeouts, status codes, truncated bodies, malformed JSON, connection-refused. 8 of 9 fault
   fixtures are HTTP-drivable; `fault-stale-cache` remains adapter-simulated only because
   local-eval definitions staleness (last-good definitions after a failed poll) lives behind
   the seam, which exposes snapshot `ageMs` but no definitions-poll surface — the vendor client
   owning that lifecycle is unpublished (deviation 2). Annotated per-row in the report message.
4. **`ctx-reserved-keys-rejected`** is exercised through the Fireweave detailed API instead of
   the OF client: the Java OpenFeature SDK stores the targeting key in the attribute map, so an
   OF context cannot carry a literal `targetingKey` attribute distinct from the targeting key.
   Annotated in the conformance report message.
5. **groupId `ai.fireweave`** remains a working assumption pending Maven Central namespace
   verification (decision brief risk 4). DO NOT PUBLISH.

## Known limitations (documented per fixtures)

- **Long-clamp:** the Java OF integer resolver is 32-bit `Integer`. Integral flag values outside
  `Integer` range resolve as `TYPE_MISMATCH` + default (never silent truncation). Cross-language
  integer reliability is documented to 2^53−1; `eval-int-beyond-safe-integer` is
  skipped-with-documented-limitation for Java (as the fixture declares).
- **Stale remote cache:** the vendor Java SDK caches per-user remote flag results up to 5
  minutes and keeps last-good local definitions after failed polls. `PostHogAdapter` surfaces
  snapshot age: stale results resolve with reason `STALE` + `fireweave.fromCache` metadata and
  flip `isStale()`, which the runtime reflects as lifecycle `STALE` — stale data is never
  reported fresh.
- Detailed metadata enrichment (`fireweave.vendorFlagId`, `fireweave.reasonCode`) is emitted
  only when the vendor response carries **both** a flag id and a condition index — inferred from
  the fixture matrix (`eval-detailed-fields` emits them; `eval-multivariate-string` and
  `eval-payload-attached`, each having only one of the two, do not). Flagging for arbitration:
  an explicit rule in `contracts/README.md` would remove the inference.
