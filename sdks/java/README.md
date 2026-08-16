# Fireweave Java SDK

Java implementation of the Fireweave polyglot SDK. OpenFeature-compatible, server-first,
Java 11+. Control-point evaluation, target registration, and a local development provider
sit alongside releases / exposures / signals.

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
| `fireweave-sdk` | `FireweaveRuntime`, `FireweaveClient` (`controlPoints()`, `registerTarget`, releases / exposures / signals / guardrails / capabilities), `FireweaveRemoteAdapter`, `FireweaveLocalAdapter`, canonical types. Zero runtime dependencies. |
| `fireweave-openfeature` | `FireweaveProvider` (all five resolvers) and `FireweaveLocalProvider` (offline OpenFeature). |
| `fireweave-adapter-posthog` | `PostHogAdapter` over `PostHogClientApi`. **Not a live vendor client** — `create(config)` is `UnsupportedCapability`. |
| `fireweave-testing` | `InMemoryAdapter` and the conformance runner. |

## Direct client (control points)

```java
FireweaveRuntime runtime = new FireweaveRuntime(
    FireweaveConfig.builder().build(),
    new FireweaveLocalAdapter(Map.of("new-checkout", true)));
runtime.initialize();
FireweaveClient client = new FireweaveClient(runtime);

boolean enabled = client.controlPoints()
    .getBooleanValue("new-checkout", false,
        EvaluationContext.builder().targetingKey("user_42").build());

client.close();
```

`client.flags()` is the same object as `client.controlPoints()` (ADR-0007). It is `@Deprecated` in Javadoc only and is not scheduled for removal. Set `FW_DEPRECATION_WARNINGS=1` to log one notice per JVM.

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

No credentials, no network. Unknown keys resolve to the **caller's default** with reason `DEFAULT` on the OpenFeature path (native `runtime.evaluate` still reports `FlagNotFound` as ERROR, matching production backends).

```java
FireweaveLocalProvider provider = FireweaveLocalProvider.create(
    Map.of("new-checkout", true));
OpenFeatureAPI.getInstance().setProviderAndWait(provider);
```

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
| `Configuration` / `PROVIDER_FATAL` on init | Missing `host` + `projectApiKey` on the remote adapter; non-https off-loopback; host not allowlisted |
| `registerTarget` → `UnsupportedCapability` | In-memory or local adapter (no `/v1/targets/register`). Use `FireweaveRemoteAdapter`. |
| `FLAG_NOT_FOUND` in production, `DEFAULT` on a laptop | Expected: only `FireweaveLocalProvider` rewrites unknown keys. |
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
- **Bounded shutdown** and **exposure dedup clear-on-flush** as before.

## Deviations & blockers

1. **`dev.openfeature:sdk` 1.15.1** — newest on Central; decision brief pinned 1.21.0.
2. **Java PostHog is seam only.** Prefer `FireweaveRemoteAdapter` for production.
3. **`ai.fireweave` Maven Central namespace** is not verified. Publication workflows fail closed without secrets. Do not treat the GAV as published.
4. **Long-clamp:** OF integer resolver is 32-bit `int`. Fixture `eval-int-beyond-safe-integer` is skipped-with-documented-limitation.
