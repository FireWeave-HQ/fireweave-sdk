# Fireweave Java SDK

Java implementation of the Fireweave polyglot SDK. Server-first, Java 11+. Exactly two v1
capabilities (spec/control-points.md "Scope of v1"): control-point evaluation
(`client.controlPoints()`) and target registration (`client.registerTarget()`). Releases,
exposures, signals, capabilities discovery, guardrails, and an OpenFeature provider are out of
v1 scope and are not exposed.

## Install

```xml
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-sdk</artifactId>
  <version>2.3.0</version>
</dependency>
```

Supported Java: **11+** (CI: Temurin 11 and 25). Do not raise the floor without a documented reason.

## Quick start (one line: the start profile)

Most apps need only this ([ADR-0012](../../docs/adr/0012-start-profile.md)). Package
`ai.fireweave.sdk.start` (in the same `fireweave-sdk` artifact) is an opt-in layer over the
unchanged core: one flags class, one call in `main`, then reads from anywhere.

```java
// FireweaveFlags.java: every control point the app reads, with its local value
import ai.fireweave.sdk.start.Flag;
import ai.fireweave.sdk.start.Flags;
import ai.fireweave.sdk.start.Fw;

public final class FireweaveFlags {
    public static final Flags FLAGS = Fw.defineFlags(Map.of(
            "new-checkout", Flag.local(true, "new checkout flow"))); // served only in local mode
}
```

```java
// main(): first thing, after the app's own config loading
public static void main(String[] args) {
    Fw.start(StartOptions.builder().flags(FireweaveFlags.FLAGS).build());
    serve();
}
```

```java
// any call site: the core's nine read methods, unchanged
// @fireweave-controlpoint new-checkout
if (Fw.controlPoints().getBooleanValue("new-checkout", false,
        EvaluationContext.builder().targetingKey(user.id()).build())) { /* … */ }
Fw.identify(user.id(), Map.of("plan", user.plan()));                        // at sign-in
Fw.controlPoints().getBooleanValue("nightly-reindex", false,
        EvaluationContext.builder().targetingKey(Fw.instanceKey()).build()); // server as subject
```

Deployed environments set one variable, `FIREWEAVE_KEY` (the project key, `project-api-key_…`).
Local development needs nothing when `FIREWEAVE_ENV` (or `APP_ENV`) is `development`, `dev`,
`local` or `test`.

### Options and overrides

Every value resolves as: `StartOptions` field, then env var, then legacy name (warns once, read
for all of 2.x), then default. Empty and whitespace-only values count as unset.

| Option | Env var | Default | What it does |
| --- | --- | --- | --- |
| `flags` | — | none | Local values per control point (`Fw.defineFlags`, keys checked with the core's key rule). Ignored in remote mode. |
| `mode` | — | inferred | `Mode.REMOTE` or `Mode.LOCAL`. Overrides inference. Remote without a key is a start error; local ignores a key (one warning). |
| `environment` | `FIREWEAVE_ENV`, `APP_ENV` | — | Environment name used for inference when there is no key and no `mode`. Pass your own, e.g. a deploy-stage setting. `NODE_ENV` and `FW_ENV` are not read. |
| `url` | `FIREWEAVE_URL` (legacy `FW_API_URL`, `FW_ATTEST_URL`) | from the SDK build | A `-staging.N` artifact calls `staging-app-server.fireweave.ai`; any other version (including `-SNAPSHOT`) calls `app-server.fireweave.ai`. Set it for a self-hosted or local fw-server: https is required except on localhost, credentials, a query or a fragment are refused, and the allowlist becomes that host plus loopback. |
| `key` | `FIREWEAVE_KEY` (legacy `FW_PROJECT_API_KEY`) | — | Project key. Pass it to read from your own secret store. Browser keys, analytics vendor keys and org/CLI tokens are rejected at start, naming the source, never the value. |
| `instanceId` | `FIREWEAVE_INSTANCE_ID` | `inst_` + hash of the host name | Value of `Fw.instanceKey()`: the same FNV-1a hash node and Go use, so one host gives one key in every SDK. Nothing is written to disk. Set it when replicas share a host name. |
| `env` | — | the process | `Function<String, String>` (or a `Map`) read instead of `System.getenv`: tests, or Spring's `env::getProperty`. Return null for unset; apply no defaults. |
| `log` | — | `System.getLogger("ai.fireweave")` | `Consumer<String>` for `[fireweave]` lines: warnings, the local-mode line and the local `registerTarget` trace. The default logs warnings at WARNING and the rest at INFO. |

The channel comes from the artifact itself: Maven filters `ai/fireweave/sdk/start/build.properties`
with the project version at build time. `Fw.sdkVersion()` and `Fw.sdkChannel()` report it
(`(devel)` and production when the resource was never filtered).

**Mode rule.** `mode` wins. Otherwise: a key means remote. No key and a development environment
name means local. Anything else (including no environment name at all) is a `Configuration`
`FireweaveException` from `Fw.start` naming `FIREWEAVE_KEY`, so a deploy that forgot its key fails
instead of silently serving defaults.

**Reads never throw.** If start failed, reads return your default (`*Details` return an `ERROR`
decision carrying the start error). `Fw.start` is synchronous and does no network I/O; a second
call with the same configuration is a no-op, and a different one throws a `Configuration` error
naming the fields that differ. A read before `Fw.start` starts FireWeave from the environment
alone (once, on that read), so call `Fw.start` first in `main`. `Fw.client()` is one
`FireweaveClient` for the life of the process, safe to capture before `Fw.start` and to inject;
shut down with `Fw.shutdown()` (never `client().close()`), after which reads serve defaults until
a new `Fw.start`. No JVM shutdown hook is registered: servlet apps call `Fw.shutdown()` in
`contextDestroyed`.

**Debugging.** `Fw.status()` reports the state, mode and why (`option`, `key` or `environment`),
channel, SDK version, fw-server host, endpoint source, key source, environment name, flag count,
the start error and `lastErrorKind`. It never contains the key, so it is safe to log:

```java
logger.info("fireweave: " + Fw.status());
```

Reads never fail, so a key fw-server refuses would otherwise look like a rollout at 0%. When
fw-server rejects the key (401 `Authentication`, 403 `Authorization`), rate-limits it (429
`RateLimited`) or cannot be reached (`Network`, `Timeout`, `BackendUnavailable`), the start
profile logs one line per kind for the life of the process through your `log` sink, naming the
key's source (for example `FIREWEAVE_KEY`) or the fw-server host and never the key, and
`Fw.status().lastErrorKind()` reports the latest of them. To check the key on purpose, for example
in a readiness probe or a deploy smoke test, call `Fw.verify()`: one synchronous evaluation round
trip that never throws and returns `ok()` or the `errorKind()` (`Authentication` for a wrong or
revoked key; `Configuration` in local mode or after a failed start):

```java
VerifyResult v = Fw.verify();
if (!v.ok()) {
    logger.warn("FireWeave key check failed: " + v.errorKind() + " (" + v.message() + ")");
}
```

## Modules

| Module | Contents |
| --- | --- |
| `fireweave-sdk` | `Fireweave.init` (the entry point), `FireweaveRuntime`, `FireweaveClient` (`controlPoints()`/`flags()`, `registerTarget`), `FireweaveRemoteAdapter`, `FireweaveLocalAdapter`, canonical types — layered into `ai.fireweave.sdk.{domain,application,infrastructure}`. Zero runtime dependencies. |
| `fireweave-testing` | `InMemoryAdapter` and the conformance runner (not published — `central.skipPublishing=true`). |

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
Javadoc only and is not scheduled for removal. Silent at runtime — no log line, no env gate —
because the SDK reads no environment variables regardless (spec/modes.md); the deprecation is
conveyed by Javadoc only.

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
```

Auth: `Authorization: Bearer <FW_PROJECT_API_KEY>`. Endpoints: `POST /v1/flags/evaluate`, `/v1/targets/register`.

## Lifecycle

`runtime.initialize()` then evaluate; `client.close()` / `runtime.shutdown()` is idempotent and bounded by `shutdownTimeoutMs` (default 10s). Evaluations after shutdown return defaults with `AlreadyClosed` and never throw.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Configuration` on init | Missing `mode`; missing/blank `apiKey`/`apiUrl` for `mode=REMOTE`; credentials supplied for `mode=LOCAL`; host not allowlisted; non-https off-loopback |
| `registerTarget` → `UnsupportedCapability` | Neither built-in adapter degrades this way today — local records+traces, remote posts to fw-server. A custom `BackendAdapter` without the capability is the only source. |
| `FLAG_NOT_FOUND`/`ERROR` in production, `DEFAULT` on a laptop | Expected: the divergent unknown-key row is per-mode by design (spec/modes.md), not provider-specific. |
| Secrets in logs | Messages pass `Redaction`, which implements `rules.redaction` in `contracts/errors.json`: bearer tokens, URL userinfo, the values of `FIREWEAVE_KEY`, `FIREWEAVE_BROWSER_KEY` and `FW_PROJECT_API_KEY`, and key-shaped values (`project-api-key_`, `fw_public_`, `fw_ingest_pub_`, `fw_org_`, `cli_at_`, `phc_`/`phx_`/`phs_`) become `[REDACTED]`; a variable name alone stays. If you see a raw key, that is a bug. |
| Demo cannot resolve `ai.fireweave:*` | From `examples/java`, the reactor compiles the SDK modules from this repo. You do not need Maven Central. |

## Build / test / demo

```bash
cd sdks/java
mvn clean verify                 # unit tests + Javadoc/sources JARs (unsigned)
mvn -pl fireweave-testing exec:java   # conformance runner

cd ../../examples/java
mvn -q compile exec:java         # offline demo (builds SDK modules from this repo)
```

Remote demo: `mvn -q compile exec:java -Dexec.args="--remote"` (defaults to the local
`test-server` stub; set `FW_API_URL`/`FW_PROJECT_API_KEY` for a real fw-server instead).

## Thread-safety

- **`FireweaveRuntime`** — fully thread-safe. Lifecycle transitions are serialized; `evaluate` / `registerTarget` never throw to callers.
- **`FireweaveClient`** — fully thread-safe. `controlPoints()` is a stateless facade over the runtime.
- Configuration and contexts are deeply immutable.
- **No static global clients** in the core. The opt-in start profile (`ai.fireweave.sdk.start`) is
  the one exception: it holds one process-wide client, with transitions serialized and lock-free
  reads once started.

## Error model

The 15 PascalCase kinds live in `ErrorKind`. Evaluation never throws; `registerTarget` never throws.

## Security defaults

- **Host allowlist (default-on):** Fireweave hosts (`app-server.fireweave.ai`,
  `staging-app-server.fireweave.ai`), plus loopback. https required off-loopback.
  `FireweaveConfig.DEFAULT_ALLOWED_HOSTS` also still lists five legacy PostHog hostnames — a
  documented pre-existing scope exclusion from the v1 relayer (see that constant's doc comment),
  not a live vendor integration; there is no `fireweave-adapter-posthog` module or PostHog client
  in this SDK.
- **Bounded shutdown** (default 10s). v1 reads are side-effect free (spec/control-points.md "Side effects") — there is no exposure queue or dedup window to clear.

## Deviations & blockers

1. **Long-clamp:** Java's default Long-via-double path cannot losslessly represent integers beyond 2^53-1, so fixture `eval-int-beyond-safe-integer` is skipped-with-documented-limitation.
