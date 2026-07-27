# Fireweave SDK — Threat Model

**Status:** Phase-4 security review (Agent J, 2026-07-27)
**Scope:** `sdks/node`, `sdks/python`, `sdks/go`, `sdks/java`, `examples/`, `contracts/security/`, `test-server/`
**Method:** source review of every language's safeguard implementations, secret scan of the working tree and all 12 git commits, cross-check against the five `contracts/security/sec-*` fixtures.

Severity-ranked findings with recommended fixes live in [release-blockers.md](release-blockers.md). This document enumerates assets, trust boundaries, and risks with the *current* per-language mitigation status.

---

## 1. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| PostHog project API key (`phc_`) | Caller config (`FireweaveRuntimeConfig.projectApiKey`, `FireweaveConfig.project_api_key`, `posthog.Config.ProjectAPIKey`, `FireweaveConfig.projectApiKey()`) | Medium — write-capable ingestion key |
| PostHog secret/personal keys (`phs_`/`phx_`) | Same config surfaces (`secretApiKey`/`secret_key`/`SecretKey`/`personalApiKey`) | **High** — grants flag-definition read for local evaluation; must never leave the server |
| Evaluation context (person/group attributes) | Per-call; may contain caller-supplied PII (spec `evaluation-context.schema.json` `piiAndRedaction.contextMayContainPii: true`) | High (PII) |
| Flag definitions / payloads | In-memory in the vendor SDK during local evaluation | Medium — may encode unreleased product info |
| Telemetry (exposures, signals, release outcomes) | In-process queues, then PostHog `capture` | Medium |
| Release identity (`rolloutId`/`changeId`/`stampIds`) | `ReleaseContext` state in `FireweaveClient` | Low |

## 2. Trust boundaries

1. **Caller application ↔ Fireweave SDK.** Caller input (contexts, flag keys, release reasons, signal messages) is untrusted for bounds/reserved-key purposes; secrets in config are trusted but must not leak outward.
2. **Fireweave core ↔ vendor PostHog SDK.** Vendor types, vendor error text, and vendor logging must not cross into the public API or outward messages (enforced by `no-vendor-leak.test.ts`, Go `publicapi_test.go`, Java `PublicApiVendorScanTest`).
3. **SDK ↔ network (PostHog `/flags`, `/batch`, `/flags/definitions`).** Egress is constrained by the host allowlist; responses are untrusted JSON.
4. **SDK ↔ process co-tenants.** Concurrent requests in the same process must not observe each other's person/group properties.

## 3. Risk enumeration

### R1 — Secret key leakage into repo, errors, or logs

**Design intent:** `phc_`/`phs_`/`phx_` keys stay server-side; error messages never contain secrets (`contracts/errors.md` rule 2; fixture `sec-secrets-not-in-errors`).

**Verified mitigations:**

- **Repo/history:** a scan for `ph[cxs]_` patterns across the working tree and all 12 commits (`git grep` over `git rev-list --all`) found only obvious placeholders (`phc_TESTKEY…`, `phc_SUPERSECRET…0001`, `phc_EXAMPLE…`, `phc_test…`, zero-padded). No real credentials exist anywhere in the repository or its history. Examples read keys from env vars (`examples/node/index.mjs` `POSTHOG_API_KEY`, `examples/python/service.py` `FIREWEAVE_POSTHOG_KEY`, `examples/go/main.go` `FW_PROJECT_API_KEY`) and every example is server-side; there is no browser/client-side surface in the repo (phase-one is server-only per `docs/adr/0004-server-first.md`).
- **Node:** every `FireweaveError` message passes `redactSecrets()` at construction (`sdks/node/packages/sdk/src/errors.ts` lines 72–85, 107–110); taxonomy default messages are fixed strings.
- **Python:** `FireweaveError.__init__` runs `redact_secrets()` (`sdks/python/src/fireweave/errors.py` lines 116–127, 158–162); config validation raises the fixed string `"invalid configuration"` and explicitly never echoes the key or URL (`config.py` lines 47–69).
- **Go:** `NewError` applies `Redact()` (`sdks/go/fireweave/errors.go` lines 106–111, 152–166); the adapter installs a `silentLogger` because posthog-go's logger may interpolate hosts/keys (`sdks/go/adapters/posthog/posthog.go` lines 556–563), and vendor config-error text is discarded in favor of the fixed message (lines 195–199).
- **Java:** `FireweaveException` sanitizes at construction (`sdks/java/fireweave-sdk/src/main/java/ai/fireweave/sdk/FireweaveException.java` line 47); `FireweaveConfig.toString()` prints `[REDACTED]` for the key (`FireweaveConfig.java` lines 163–167).

**Residual risk:** redaction is pattern-based (`ph[cxs]_*`, `Bearer …`, `FW_PROJECT_API_KEY=…`) and case-sensitive; a secret that doesn't match a known shape would pass through a *custom* message. All four languages mitigate this by defaulting to fixed taxonomy messages on every mapped error path. **Low.**

**Required action:** none blocking. See finding L-2 (case-sensitivity) in release-blockers.md.

### R2 — PII leakage through error messages or telemetry

**Design intent:** fixture `sec-pii-redaction-in-messages`; telemetry allowlist + redaction.

**Verified mitigations:**

- All four languages return **fixed canonical messages** on backend-fault paths (`"backend unavailable"`, `"authentication failed"`, …): Node `mapHttpStatus` (`adapters/posthog.ts` 106–112), Python `map_transport_error` (`adapters/posthog.py` 88–112), Go `mapVendorError` — "vendor error text never reaches Message" (`adapters/posthog/posthog.go` 428–474), Java `mapTransport` (`PostHogAdapter.java` 220–251). Context-bound violations use fixed strings that never echo attribute values (Node `context.ts` 139–172, Python `context.py` 165–198, Go `context.go` 130–174, Java `ContextValidator.java` 25–63).
- Telemetry allowlists: **Go** applies a hard-coded key allowlist + string redaction to every telemetry property (`sdks/go/fireweave/telemetry.go`). **Python** drops any signal attribute not in `_SIGNAL_ATTRIBUTE_ALLOWLIST` and redacts string values (`client.py` lines 40–58, 286–294). **Java** signals have a fixed canonical field set and `Signal` sanitizes messages at construction (`Signal.java` line 46); a config allowlist can further filter (`FireweaveConfig.java` 146–149). **Node** redacts string values but its allowlist is **opt-in** (`client.ts` lines 47–50, 207–213) — see finding M-3.

**Divergence:** Node `runtime.ts` line 246 stringifies unknown adapter exceptions into the outward `errorMessage` (`message: redactSecrets(String(err))`). Secret patterns are redacted, but arbitrary vendor error text (URLs, hostnames, response fragments, possibly attribute echoes from third-party code) can pass. Go/Python/Java never copy vendor text into outward messages. **Finding H-2.**

**Residual risk:** evaluation context intentionally flows to PostHog as person properties (that is the product; spec marks `contextMayContainPii: true`). The privacy doc (docs/privacy.md) documents this honestly.

### R3 — SSRF / egress to attacker-chosen hosts

**Design intent:** fixture `sec-endpoint-ssrf-allowlist`: a non-allowlisted host (e.g. `http://169.254.169.254`) must fail initialization as `Configuration`/`PROVIDER_FATAL` with no key echo.

**Verified mitigations:**

- **Node:** `validateConfig` parses the host URL, requires http(s), and enforces exact-hostname allowlist matching *when `allowedHosts` is configured* (`runtime.ts` lines 54–78). Fails to FATAL before any adapter/network activity (`runtime.ts` 170–192).
- **Python:** same semantics in `FireweaveConfig.validate` (`config.py` lines 57–63), `init_fatal=True` → `PROVIDER_FATAL`.
- **Go:** allowlist **on by default** — `defaultAllowedHosts` pins the five PostHog hosts + loopback (`adapters/posthog/posthog.go` lines 49–56, 127–156).
- **Java:** allowlist **on by default** — `DEFAULT_ALLOWED_HOSTS` (`FireweaveConfig.java` lines 18–20, 74–92).

**Residual risk / divergence:** Node and Python enforce the allowlist only when the caller sets one; unset means *any* http(s) host. Go and Java are deny-by-default. The fixture passes in all four languages because it supplies `allowedHosts` explicitly, but the *default posture* diverges. **Finding H-1.** Additionally all languages accept `http://` for non-loopback hosts (needed for the local test-server) — **finding L-3**.

### R4 — Resource exhaustion via oversized/deep evaluation contexts

**Design intent:** ratified bounds (128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB serialized) enforced **before** serialization/network (fixtures `sec-oversized-reject`, `sec-deep-nesting-reject`, `ctx-*` suite, all with `networkCalls: 0`).

**Verified mitigations (all four languages enforce pre-network):**

- **Node:** `canonicalizeContext` runs inside `runtime.evaluate` *before* `adapter.resolve` (`context.ts` 131–173; `runtime.ts` 230–242).
- **Python:** `validate_context` runs before `adapter.resolve`; its docstring states "Validation always happens *before* any backend call" (`context.py` 152–198; `runtime.py` 231–249).
- **Go:** `ValidateContext` before `adapter.Resolve` (`context.go` 141–175; `runtime.go` 145–151).
- **Java:** `ContextValidator.validate` before `adapter.evaluate` ("before any adapter/network call", `ContextValidator.java` 7–63; wired in `FireweaveRuntime.evaluate`).

All four also deep-copy caller attribute maps at the boundary so post-call mutation cannot alter what was validated (Node `deepCopyJson`, Python `EvaluationContext.__post_init__` + `MappingProxyType`, Go `deepCopyMap`, Java immutable `JsonValue`s).

**Residual risk:** minor measurement divergence — Node measures each top-level value's JSON size, Python measures string leaves, Go measures strings raw/values marshaled, Java measures string leaves plus canonical serialized size. All satisfy the fixtures; a value that passes in one language could fail in another near the boundary. **Low** (documented divergence, finding L-6 area).

### R5 — Unbounded retries, queues, or shutdown hangs

**Design intent:** retries, queues, and shutdown are bounded; underlying vendor defaults must not leak unbounded behavior.

**Verified per language:**

- **Node:** the adapter constructs posthog-node with `featureFlagsRequestMaxRetries: 0`, `fetchRetryCount: 0`, `flushAt: 100` (`adapters/posthog.ts` 210–217) and hard-caps client shutdown at 2 000 ms (`adapters/posthog.ts` 388–398). *Gap:* `FireweaveRuntimeConfig.shutdownTimeoutMs` exists but is never consumed, and `capabilities.get()` reports a 10 000 ms default that nothing enforces (`client.ts` line 305). Exposure dedup set `seen` grows forever (`client.ts` 135, 152–156).
- **Python:** flag-request timeout is configured (`feature_flags_request_timeout_seconds`, `adapters/posthog.py` 249–253) but retries are left at posthog-python's defaults, and `PostHogAdapter.shutdown(timeout_ms)` **ignores** its timeout argument — it calls the vendor `flush()`/`shutdown()` unbounded (`adapters/posthog.py` 263–274). Exposure dedup clears on flush (`client.py` 237–241) — the best of the four.
- **Go:** exemplary. Retries explicitly pinned (`FeatureFlagRequestMaxRetries: &retries`, default 0), vendor `ShutdownTimeout` set, and `Close` is double-bounded by caller context or `DefaultCloseTimeout` (5 s) with an explicit note that "posthog-go's default is an indefinite wait, which must not leak" (`adapters/posthog/posthog.go` lines 44–47, 183–192, 476–511).
- **Java:** `FireweaveRuntime.shutdown()` is idempotent and never throws, but calls `adapter.shutdown()` with no deadline; `FireweaveConfig.shutdownTimeoutMs` (default 10 000) is not enforced (`FireweaveRuntime.java` 193–205; `PostHogAdapter.java` 325–337). With the seam-injected client, boundedness depends on the injected `close()`. `exposureDedup` key set is never cleared (`PostHogAdapter.java` 62, 255).

**Findings M-1 (shutdown timeouts) and M-2 (dedup growth).**

### R6 — Cross-request state contamination (person/group property mixing)

**Verified per language:**

- **Java:** no `ThreadLocal` anywhere in Fireweave code; the adapter documents "ThreadLocal neutralization — all identity/properties are passed explicitly per call through the seam; the vendor SDK's ThreadLocal request context is never used" (`PostHogAdapter.java` 42–44, confirmed by grep). Runtime state is `volatile` + `synchronized(stateLock)`; `ConcurrencyTest` exercises parallel evaluations and exposure dedup.
- **Python:** no module-level mutable state (`fireweave/__init__.py` exports only); runtime uses an `RLock`; contexts are frozen dataclasses deep-copied at construction (`context.py` 54–67); `tests/test_concurrency.py` covers concurrent evaluation/shutdown/dedup.
- **Go:** package doc asserts and grep confirms no package-level mutable state — all `var`s are immutable tables/patterns (`errors.go` 1–13); runtime uses `sync.RWMutex`; per-call contexts are copied (`MergeContexts` returns fresh copies, `context.go` 71–86); the suite runs under `-race` (63/63 conformance).
- **Node:** single-threaded event loop; no module-level mutable state in `src/`; each evaluation merges into a fresh deep copy (`context.ts` 108–125), so concurrent async requests cannot share attribute maps.

**Residual risk (accepted, documented):** the Node and Go adapters recover `/flags` response metadata via an interception layer **keyed by `distinct_id`**; concurrent evaluations *for the same distinct_id* may observe each other's flag *metadata* (never person/group properties) — documented in-source as best-effort with identical values in practice (`sdks/go/adapters/posthog/posthog.go` 13–17, `transport.go` 36–41; Node `adapters/posthog.ts` 120–122). **Low.**

### R7 — Malicious or malformed flag payloads (injection / prototype pollution)

**Verified:**

- Payload values are treated as plain data in every language: Node `JSON.parse` only (`adapters/posthog.ts` 183–193), Python `json.loads` best-effort (`adapters/posthog.py` 189–196), Go `json.Unmarshal` into typed values (`adapters/posthog/posthog.go` 387–425), Java Jackson via the `JsonValue` model. A repo-wide grep found **no** `eval`, `new Function`, `vm.*`, `exec`, `pickle`, or `ScriptEngine` usage in any SDK source.
- Node object merging is shallow assignment per top-level key into fresh objects (`context.ts` `mergeContexts`/`deepCopyJson`) — there is no recursive merge into pre-existing objects, so the classic prototype-pollution gadget (deep merge into `Object.prototype`) does not exist. Residual nit: bracket-assigning a caller-supplied `"__proto__"` key mutates the *copy's own* prototype rather than storing the property (silent attribute loss; no global pollution) — **finding L-1** recommends null-prototype objects.

### R8 — Sensitive data persisted to disk

**Verified:** grep across all four SDK source trees found no file writes, no cache files, no temp-file usage in production code paths. The only `Files.write` is in the Java **conformance test harness** report writer (`fireweave-testing/.../ConformanceRunner.java` line 118 — test-scope module). Flag definitions/local-eval state live in vendor SDK memory only; nothing Fireweave persists to disk by default. **Mitigated.**

### R9 — Transport security downgrade

**Verified:** no language touches TLS verification — grep for `rejectUnauthorized`, `InsecureSkipVerify`, `verify=False`, `NODE_TLS`, `trustAll`, custom `SSLContext` found nothing in `sdks/` or `examples/`. All four use their ecosystem HTTP stacks with default certificate verification (Node `fetch`/undici, posthog-python → `requests`, Go `http.DefaultTransport`, Java the injected client's stack). Proxies therefore follow ecosystem defaults (`HTTPS_PROXY` env in Node/Go/Python ecosystems). `http://` scheme is accepted for the local test-server; see finding L-3 for the https-by-default-for-non-loopback recommendation.

### R10 — Supply chain

**Verified pins:** Node `posthog-node 5.46.1` + `@openfeature/server-sdk 1.22.0` exact in `sdks/node/package.json` with `package-lock.json` committed (peer ranges `^1.22.0`/`^5.46.1`, posthog optional). Python `posthog==7.31.0` exact, `openfeature-sdk>=0.10,<0.11` range in `pyproject.toml`; **no lockfile** (core has zero runtime deps, extras pinned). Go `posthog-go v1.22.0`, `open-feature/go-sdk v1.17.2` in `go.mod` + `go.sum`. Java `dev.openfeature:sdk 1.15.1`, `jackson-databind 2.17.1` in `sdks/java/pom.xml` (Maven versions are exact; no vendor PostHog artifact — blocked binding documented in `fireweave-adapter-posthog/pom.xml` and ledger ruling 10). Informative requirements for Agent K's pipeline are listed in release-blockers.md §Supply-chain.

## 4. What demonstrably works

Stated plainly, with evidence: no secrets exist in the repo or its git history; all four languages construct errors from fixed taxonomy messages with pattern redaction as a second layer and preserve causes internally only (Node `Error.cause`, Python `__cause__`, Go `Unwrap()`, Java `getCause()`); all four enforce the ratified context bounds before any network call with zero network calls on rejection; all four validate hosts against an allowlist when one is present (Go/Java by default); no SDK disables TLS verification, evaluates payload code, or persists anything to disk; and the five `contracts/security/sec-*` fixtures report `pass` for every language in their compatibility blocks.
