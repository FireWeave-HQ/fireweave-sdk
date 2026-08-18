# Java SDK parity plan

Status date: 2026-08-15. Baseline: `master` at the Python parity merge (`feat(python): SDK parity — register_target, control_points, local provider`).

This document is the Agent 1 deliverable. It records what Java must implement, what must stay Java-specific, and what must not be ported. The source of truth is `spec/`, `contracts/`, ADRs, then current Node/Python/Go behavior — never a single language implementation.

## Parity matrix

| Capability | Node | Python | Go | Java current | Java target |
| --- | --- | --- | --- | --- | --- |
| Boolean/string/number/object evaluation | ✅ | ✅ int+float | ✅ via OF + `Flags().Evaluate` | ✅ OF; client helpers only bool/string | ✅ add integer/double/object helpers on `controlPoints()` |
| OpenFeature provider | ✅ | ✅ | ✅ | ✅ `FireweaveProvider` | ✅ keep; add local provider wrapper |
| Control points | ✅ `client.controlPoints` | ✅ `client.control_points` | ❌ `Flags()` only | ❌ flat client methods | ✅ `client.controlPoints()` |
| Flags compatibility aliases | ✅ same object | ✅ same object | N/A | N/A | ✅ `client.flags()` ≡ `controlPoints()`, `@Deprecated` |
| `registerTarget` | ✅ | ✅ | ⏳ | ❌ | ✅ `client.registerTarget` + `runtime.registerTarget` |
| Local adapter | ✅ | ✅ | ⏳ | ❌ | ✅ `FireweaveLocalAdapter` |
| Local provider | ✅ | ✅ | ⏳ | ❌ | ✅ `FireweaveLocalProvider` |
| Remote adapter | ✅ only network adapter | ✅ | ✅ | ✅ | ✅ keep; add register + `groupProperties` |
| `/v1/flags/evaluate` | ✅ | ✅ | ✅ | ✅ | ✅ plus `groupProperties` on the wire |
| `/v1/capture` | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| `/v1/targets/register` | ✅ | ✅ | ⏳ | ❌ | ✅ |
| Exposures | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| Signals | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| Releases | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| Capabilities | ✅ `controlPoints` + `remoteAdapter` | ✅ same | ✅ flags-era | ⚠️ `flags` + `posthogAdapter` only | ✅ add `controlPoints` + `remoteAdapter`; keep `flags` / `posthogAdapter` |
| Guardrails | 🧪 stub | 🧪 stub | 🧪 stub | 🧪 stub | 🧪 stub (unchanged) |
| Context canonicalization | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| Error taxonomy | ✅ 15 kinds | ✅ | ✅ | ✅ | ✅ keep; use retryable bit for register |
| Redaction | ✅ | ✅ | ✅ | ✅ | ✅ keep |
| Lifecycle behavior | ✅ | ✅ | ✅ | ✅ | ✅ gate register like evaluate |
| Thread safety | N/A (event loop) | ✅ locks | ✅ mutexes | ✅ documented | ✅ keep; local captures concurrent |
| Conformance fixtures | 63/65 | 65/65 | 65/65 | 64/65 | 64/65 (same documented integer-range skip) |
| Bun/Deno portability | ✅ ADR-0008 | N/A | N/A | N/A | **do not port** |
| Direct PostHog adapter | ❌ removed ADR-0006 | ✅ escape hatch | ✅ escape hatch | ⚠️ seam only | **keep seam**; do not invent a live vendor client |

## What Java is missing

1. **Control-point vocabulary (ADR-0007).** `FireweaveClient` evaluates on the client itself. Node/Python expose `controlPoints` / `control_points` as the documented namespace and keep `flags` as the identical object.
2. **Target registration.** No client, runtime, or adapter method; no `POST /v1/targets/register`.
3. **Local development substrate.** No `FireweaveLocalAdapter` and no OpenFeature local provider that rewrites `FLAG_NOT_FOUND` → `DEFAULT`.
4. **Typed client helpers** for integer / double / object (OpenFeature already covers all five types).
5. **Capabilities features** `controlPoints` and `remoteAdapter`.
6. **Remote evaluate `groupProperties`.** Node/Python send first-class `groupProperties` on `/v1/flags/evaluate`; Java currently omits them.
7. **Maven Central publication metadata and workflow.** *(Implemented.)* Parent POM now has Central-required metadata, sources/javadoc JARs, GPG (opt-in `-Prelease`), and `org.sonatype.central:central-publishing-maven-plugin:0.11.0`. First upload remains blocked on namespace verification and CI secrets.

## What should be implemented

### Control points

- Add `FireweaveClient.controlPoints()` returning a thread-safe inner API with:
  - `evaluate(...)`
  - `getBooleanValue` / `getStringValue` / `getIntegerValue` / `getDoubleValue` / `getObjectValue`
- Keep existing client-level `evaluate` / `getBooleanValue` / `getStringValue` as delegates (no break).
- Add `flags()` returning the **same instance** as `controlPoints()`, annotated `@Deprecated` with Javadoc pointing at `controlPoints()`.
- Opt-in one-notice-per-JVM via `FW_DEPRECATION_WARNINGS=1` (java.util.logging), matching ADR-0007. Silent by default.
- Advertise `features.controlPoints: true` beside retained `features.flags: true`.
- Do **not** rename `flagKey`, `FlagType`, wire paths, or OpenFeature resolver names.

### Target registration

Derive the model only from `spec/remote-register-target.schema.json` and Node/Python:

Request fields: `targetingKey` (required), `kind` (`user`|`device`, omit to let the server default), `environment`, `properties`.
Response fields used by SDKs: `ok` (Node/Python do not surface the echoed `targetingKey`).

Semantics:

- Never throw from register (login-path fail-safe).
- Empty targeting key → `{ok:false, InvalidContext / TARGETING_KEY_MISSING}`.
- Closed → `AlreadyClosed`; not ready → `NotReady`.
- Adapters without the capability (in-memory, local, PostHog seam) → `UnsupportedCapability`.
- Remote: `POST /v1/targets/register` with `Authorization: Bearer <key>`.
- Retry **once** when `ErrorKind.retryable()` is true (Network / Timeout / BackendUnavailable / RateLimited / NotReady). Auth failures are not retried.
- Omit unset optional fields rather than sending nulls.
- Do not invent protocol fields. Do not client-strip `fw_` keys (server-authoritative per spec).

### Local development

- `FireweaveLocalAdapter` in `fireweave-sdk`:
  - no network, no credentials
  - `name() == "other"` (`inmemory` belongs to the fixture adapter)
  - `devFlags: Map<String, Boolean>`
  - hit → boolean value, variant `on`/`off`, reason `STATIC`, `enabled` conceptually true
  - miss → `FlagNotFound` (runtime → ERROR decision on the native path)
  - non-boolean typed read of a configured key → `TypeMismatch`
  - features: `localEvaluation`/`localOnly` true, `remoteEvaluation`/`exposureEmission`/`groupAnalytics` false
- `FireweaveLocalProvider` in `fireweave-openfeature`:
  - metadata name `fireweave-local`
  - wires the local adapter through `FireweaveRuntime` + `FireweaveProvider`
  - **one rewrite only:** `FLAG_NOT_FOUND` → caller default, reason `DEFAULT`, variant `default`, no error code
  - `PROVIDER_NOT_READY`, `INVALID_CONTEXT`, `TYPE_MISMATCH`, `PROVIDER_FATAL` pass through
  - process-wide captures + optional echo, matching Node/Python semantics

### Remote protocol audit

Keep `FireweaveRemoteAdapter` as the production path (ADR-0005). Updates:

- implement `/v1/targets/register`
- send `groupProperties` when present
- attach `quotaLimited` metadata when the evaluate response carries it
- do not add retries to evaluate (Node/Python retry register only)
- do not leak the API key in errors (`Redaction` already covers Bearer / `FW_PROJECT_API_KEY`)
- do not reintroduce customer-facing PostHog construction

### OpenFeature

No change to the never-throw/default contract on `FireweaveProvider`. Local provider is a wrapper, not a second evaluation pipeline.

### Maven / release

Coordinates already specified: `ai.fireweave:{fireweave-sdk,fireweave-openfeature,fireweave-adapter-posthog,fireweave-testing}:0.1.0-SNAPSHOT`.

Versioning: these changes are additive. Python kept `0.1.0` for the same surfaces. Java stays **`0.1.0`** (Maven `0.1.0-SNAPSHOT` until a release tag drops SNAPSHOT). Do not jump to 2.1.0 because Node did.

Publication uses `org.sonatype.central:central-publishing-maven-plugin` (Central Publisher Portal), not OSSRH. First real upload is blocked until the `ai.fireweave` namespace is verified and CI secrets exist — prepare the repo; do not fake a Central deployment.

## What should remain Java-specific

- Four Maven modules and the `PostHogClientApi` injection seam (ADR-0002 / ADR-0005 Java note; ruling 10 / RB-3).
- Java 11 language floor (`maven.compiler.release=11`).
- OpenFeature integer resolver is 32-bit `int` — documented skip `eval-int-beyond-safe-integer`.
- Synchronous API (no `CompletionStage` evaluation surface).
- `FireweaveConfig` is explicit (no hidden `System.getenv` in core). The demo reads `FW_API_URL` / `FW_PROJECT_API_KEY`.
- Default host allowlist **keeps PostHog hosts** (Java still has a PostHog seam) and **adds** Fireweave hosts so remote URLs validate without a custom allowlist.
- `controlPoints()` / `flags()` methods (JavaBeans), not fields.
- `getIntegerValue` / `getDoubleValue` rather than Node's single `getNumberValue`.
- JUnit 5 + `com.sun.net.httpserver.HttpServer` for remote unit tests (no extra HTTP mock dependency).

## What should not be ported

- Bun / Deno runtime portability, `readEnv()` Deno permission dance, `TextEncoder` vs `Buffer`, `runtime-portability.test.ts` bans on `node:` imports (ADR-0008).
- Absolute ban on the string `posthog` in the published artifact (Node-only after ADR-0006). Java still ships `fireweave-adapter-posthog`.
- Web SDK sync OpenFeature / prefetch / unload beacon (ADR-0009) — different surface.
- A live `com.posthog:posthog-server` client. That artifact is still unpublished; inventing one is not parity.
- Node `AbortSignal` on register options.
- Dropping `client.evaluate(...)` — Java already documented that native Decision API; removing it would be an unnecessary break.

## Expected tests

### Unit — control points

- `controlPoints().getBooleanValue` returns configured values
- `flags() == controlPoints()` (same instance)
- `flags()` silent by default; one log when `FW_DEPRECATION_WARNINGS=1`
- capabilities advertise `controlPoints`, `flags`, `remoteAdapter`

### Unit — target registration

- successful POST with Bearer auth and optional fields
- omitted optional fields are absent from JSON
- missing targeting key
- retryable 503 retried once then success
- 401 not retried
- closed runtime / not-ready adapter
- in-memory / local adapter → `UnsupportedCapability`
- never throws

### Unit — local development

- configured boolean STATIC on/off
- missing key: native path ERROR/`FlagNotFound`; OF path DEFAULT + caller default
- string / integer / double / object defaults on OF path
- type mismatch on a boolean override
- captures + reset
- echo on/off
- lifecycle / shutdown does not rewrite real errors
- OpenFeature client integration

### Unit — remote

- evaluate still Bearer-authenticated
- `groupProperties` serialized when present
- capture unchanged
- register path + response parsing
- secret-free error messages

### Conformance

- existing Java suite must stay 64/65 with the same documented integer-range skip
- discrepancies vs Node/Python/Go: document in `docs/compatibility.md` if intentional

### Demo

- `examples/java` offline `mvn compile exec:java` with no credentials/network
- `--remote` requires env vars and must never print the API key

## Version and publish stance

| Item | Decision |
| --- | --- |
| Java version | remain `0.1.0` / `0.1.0-SNAPSHOT` (additive, matches Python) |
| Breaking changes | none intended |
| Deprecated | `FireweaveClient.flags()` (alias; not scheduled for removal) |
| Maven Central | prepare metadata + workflow; first upload **blocked** on namespace verification + secrets |
| Claim published? | **no** until Central confirms |

## Implementation order

1. Types + adapter/runtime/client APIs
2. Local adapter + local provider
3. Remote register + `groupProperties`
4. Tests
5. Demo
6. Maven/CI/docs
7. Local verify; report publication blockers honestly
