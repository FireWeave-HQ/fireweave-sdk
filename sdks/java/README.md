# Fireweave Java SDK

Java implementation of the Fireweave polyglot SDK. Server-first, Java 11+. Exactly two v1
capabilities (spec/control-points.md "Scope of v1"): control-point evaluation
(`client.controlPoints()`) and target registration (`client.registerTarget()`). Releases,
exposures, signals, capabilities discovery, guardrails, and an OpenFeature provider are out of
v1 scope and are not exposed.

**These artifacts are not on Maven Central yet.** Coordinates below are the intended public
GAV; install from a repository checkout until a Central publication is confirmed.

## Coordinates (unpublished)

| groupId | artifactId | version |
| --- | --- | --- |
| `ai.fireweave` | `fireweave-sdk` | `0.1.0-SNAPSHOT` |
| `ai.fireweave` | `fireweave-openfeature` | `0.1.0-SNAPSHOT` |
| `ai.fireweave` | `fireweave-adapter-posthog` | `0.1.0-SNAPSHOT` (seam only) |
| `ai.fireweave` | `fireweave-testing` | `0.1.0-SNAPSHOT` |

```xml
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-openfeature</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

Install from this repo:

```bash
cd sdks/java
mvn install
```

Supported Java: **11+** (CI: Temurin 11 and 25). Do not raise the floor without a documented reason.

## Modules

| Module | Contents |
| --- | --- |
| `fireweave-sdk` | `Fireweave.init` (the entry point), `FireweaveRuntime`, `FireweaveClient` (`controlPoints()`/`flags()`, `registerTarget`), `FireweaveRemoteAdapter`, `FireweaveLocalAdapter`, canonical types — relayered into `ai.fireweave.sdk.{domain,application,infrastructure}`. Zero runtime dependencies. |
| `fireweave-openfeature` | `FireweaveProvider` (all five resolvers) and `FireweaveLocalProvider` (offline OpenFeature). |
| `fireweave-adapter-posthog` | `PostHogAdapter` over `PostHogClientApi`. **Not a live vendor client** — `create(config)` is `UnsupportedCapability`. |
| `fireweave-testing` | `InMemoryAdapter` and the conformance runner. |

## Direct client (control points)

Classes live under `ai.fireweave.sdk.{domain,application,infrastructure.adapters}` — there is no
facade re-export package, so import from the layer each type lives in (e.g.
`ai.fireweave.sdk.application.FireweaveClient`, `ai.fireweave.sdk.domain.EvaluationContext`,
`ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter`).

The single entry point (spec/modes.md):

```java
FireweaveClient client = Fireweave.init(InitOptions.local(Map.of("new-checkout", true)));

boolean enabled = client.controlPoints()
    .getBooleanValue("new-checkout", false,
        EvaluationContext.builder().targetingKey("user_42").build());

client.close();
```

Or construct the runtime directly:

```java
FireweaveRuntime runtime = new FireweaveRuntime(
    FireweaveConfig.builder().build(),
    new FireweaveLocalAdapter(Map.of("new-checkout", true)));
runtime.initialize();
FireweaveClient client = new FireweaveClient(runtime);
```

`client.flags()` is the same object as `client.controlPoints()` (ADR-0007). It is `@Deprecated` in
Javadoc only and is not scheduled for removal — it logs one notice per process, unconditionally
(no env gate; the SDK reads no environment variables, spec/modes.md).

## OpenFeature

```java
FireweaveRuntime runtime = new FireweaveRuntime(
    FireweaveConfig.builder().build(),
    new FireweaveLocalAdapter(Map.of("new-checkout", true)));
OpenFeatureAPI.getInstance()
    .setProviderAndWait("app", new FireweaveProvider(runtime));
boolean enabled = OpenFeatureAPI.getInstance().getClient("app")
    .getBooleanValue("new-checkout", false, new MutableContext("user_42"));
OpenFeatureAPI.getInstance().shutdown();
```

The OpenFeature parameter is still `flagKey` — that name is fixed by the OpenFeature specification.

## Local development

No credentials, no network. `FireweaveLocalAdapter` seeds a `Map<String, Boolean>`: a present key
resolves with reason `STATIC`; an unknown key resolves to the **caller's default** with reason
`DEFAULT` — never an error, and never a throw (spec/modes.md "Behaviour per mode" — deliberately
divergent from remote mode's unknown-key row, `default`/`ERROR`/`FlagNotFound`).

```java
FireweaveClient client = Fireweave.init(InitOptions.local(Map.of("new-checkout", true)));
```

`registerTarget` in local mode records the target in-process and traces one `[fireweave:local]`
line (via an injectable `Consumer<String>` sink, `InitOptions.Builder#log`) instead of reaching
fw-server; recorded targets are readable back via `FireweaveLocalAdapter#getRegisteredTargets()`.

## Remote configuration

```java
FireweaveConfig config = FireweaveConfig.builder()
    .host(System.getenv("FW_API_URL"))
    .projectApiKey(System.getenv("FW_PROJECT_API_KEY"))
    .build();
FireweaveRuntime runtime = new FireweaveRuntime(config, new FireweaveRemoteAdapter());
runtime.initialize();

client.registerTarget("user_42", RegisterTargetOptions.builder()
    .kind(TargetKind.USER)
    .property("plan", JsonValue.of("pro"))
    .build()); // never throws; check result.ok()
```

Auth: `Authorization: Bearer <FW_PROJECT_API_KEY>`. Endpoints: `POST /v1/flags/evaluate`, `/v1/capture`, `/v1/targets/register`.

## Lifecycle

`runtime.initialize()` then evaluate; `client.close()` / `runtime.shutdown()` is idempotent and bounded by `shutdownTimeoutMs` (default 10s). Evaluations after shutdown return defaults with `AlreadyClosed` and never throw.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Configuration` on init | Missing `mode`; missing/blank `apiKey`/`apiUrl` for `mode=REMOTE`; credentials supplied for `mode=LOCAL`; host not allowlisted; non-https off-loopback |
| `registerTarget` → `UnsupportedCapability` | Neither built-in adapter degrades this way today — local records+traces, remote posts to fw-server. A custom `BackendAdapter` without the capability is the only source. |
| `FLAG_NOT_FOUND`/`ERROR` in production, `DEFAULT` on a laptop | Expected: the divergent unknown-key row is per-mode by design (spec/modes.md), not provider-specific. |
| Secrets in logs | Messages pass `Redaction` (`phc_`/`phs_`/`phx_`, `Bearer`, `FW_PROJECT_API_KEY`). If you see a raw key, that is a bug. |
| Demo cannot resolve `ai.fireweave:*` | From `examples/java`, the reactor compiles the SDK modules from this repo. You do not need Maven Central. |

## Build / test / demo

```bash
cd sdks/java
mvn clean verify                 # unit tests + Javadoc/sources JARs (unsigned)
mvn -pl fireweave-testing exec:java   # conformance runner

cd ../../examples/java
mvn -q compile exec:java         # offline demo (builds SDK modules from this repo)
```

Remote demo: `FW_PROJECT_API_KEY=… FW_API_URL=… mvn -q compile exec:java -Dexec.args="--remote"`.

## Thread-safety

- **`FireweaveRuntime`** — fully thread-safe. Lifecycle transitions are serialized; `evaluate` / `registerTarget` never throw to callers.
- **`FireweaveClient`** — fully thread-safe. `controlPoints()` is a stateless facade over the runtime.
- **`FireweaveProvider` / `FireweaveLocalProvider`** — safe for concurrent resolution.
- Configuration and contexts are deeply immutable.
- **No static global clients** except local-provider capture buffers (test/dev observability).

## Error model

The 15 PascalCase kinds live in `ErrorKind`. Evaluation never throws; `registerTarget` never throws. `AlreadyClosed` maps to OpenFeature `PROVIDER_NOT_READY`.

## Security defaults

- **Host allowlist (default-on):** Fireweave hosts (`app-server.fireweave.ai`, `staging-app-server.fireweave.ai`), PostHog hosts (Java still ships a PostHog seam), plus loopback. https required off-loopback.
- **Bounded shutdown** (default 10s) as before. v1 reads are side-effect free (spec/control-points.md "Side effects") — there is no exposure queue or dedup window to clear.

## Deviations & blockers

1. **`dev.openfeature:sdk` 1.15.1** — newest on Central; decision brief pinned 1.21.0.
2. **Java PostHog is seam only.** Prefer `FireweaveRemoteAdapter` for production.
3. **`ai.fireweave` Maven Central namespace** is not verified. Publication workflows fail closed without secrets. Do not treat the GAV as published.
4. **Long-clamp:** OF integer resolver is 32-bit `int`. Fixture `eval-int-beyond-safe-integer` is skipped-with-documented-limitation.
