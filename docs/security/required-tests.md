# Fireweave SDK — Required Defensive Test Matrix

**Status:** Phase-4 security review (Agent J, 2026-07-27).
Legend: ✅ exists (file cited) · ⚠️ partial · ❌ missing. "Conformance" = the shared `contracts/security/` fixtures, which all four languages already pass per the fixtures' compatibility blocks (Node 61/63 overall with 2 pre-ratified non-security skips; Python 63/63; Go 63/63 under `-race`; Java 62/63).

## T1 — Secrets never appear in error messages

Auth failure with a real-shaped key in config must yield the fixed message `"authentication failed"` and never contain `phc_`/the key body (fixture `sec-secrets-not-in-errors`).

| Language | Status | Evidence |
|---|---|---|
| Node | ✅ | `test/unit/errors.test.ts` ("redactSecrets strips API keys and bearer tokens", "FireweaveError preserves cause internally, redacts message") + conformance |
| Python | ✅ | `tests/test_errors.py::test_secret_patterns_redacted`, `test_default_messages_are_secret_free` + conformance |
| Go | ✅ | `fireweave/errors_test.go::TestMessagesNeverContainSecrets`, `adapters/posthog/posthog_test.go::TestSecretNeverInErrorMessages` + conformance |
| Java | ✅ | `RedactionTest` (keys, bearer tokens, env assignments), `ErrorTaxonomyTest` + conformance |

## T2 — Redaction pattern coverage (keys, bearer, env var; case variants)

| Language | Status | Notes |
|---|---|---|
| All four | ⚠️ | Lowercase `ph[cxs]_`, `Bearer`, `FW_PROJECT_API_KEY` patterns are tested. **Missing everywhere:** case-variant inputs (`BEARER`, `bearer`), secrets embedded mid-URL (`?api_key=phc_…`), and multi-secret strings in one message. Add table-driven cases per language (see finding L-2). |

## T3 — PII cannot reach `errorMessage`

Backend 500 with `email`/`phone` in context → fixed `"backend unavailable"`, must-not-contain assertions (fixture `sec-pii-redaction-in-messages`).

| Language | Status | Evidence |
|---|---|---|
| All four | ✅ (conformance) | Fixture passes everywhere. **Gap in Node unit coverage:** no unit test pins the `runtime.ts:246` internal-error path (`redactSecrets(String(err))`) against vendor exceptions whose text embeds context values — add one once finding H-2 is fixed. |

## T4 — Context bounds enforced before network

All five bounds (count/key/value/depth/serialized) rejected with `networkCalls: 0` (fixtures `sec-oversized-reject`, `sec-deep-nesting-reject`, `ctx-oversized-*`, `ctx-nesting-depth-exceeded`, `ctx-serialized-size-exceeded`).

| Language | Status | Evidence |
|---|---|---|
| Node | ✅ | `test/unit/context.test.ts` + conformance (`assertNoNetwork` honored) |
| Python | ✅ | `tests/test_context.py` + conformance |
| Go | ✅ | `fireweave/context_test.go` + conformance; `transport.go::FlagsCalls` powers no-network assertions |
| Java | ✅ | `ContextValidatorTest`, `EvaluationContextTest` + conformance |

## T5 — Reserved-key rules (incl. `fireweave.*` carve-out)

| Language | Status | Notes |
|---|---|---|
| All four | ✅ | Rulings 12–14 carve-out landed; fixture `ctx-fireweave-groups-carveout`. Canonical `fireweave.groups` / `fireweave.groupProperties` only; `fireweave.evaluationContexts` rejected (ruling 13). Plain `groups` alias per ruling 19. Disposition: [findings-disposition.md](findings-disposition.md) J-M-4 Fixed. |

## T6 — SSRF / endpoint allowlist

Non-allowlisted host (`http://169.254.169.254`) → FATAL `Configuration`, no key echo (fixture `sec-endpoint-ssrf-allowlist`).

| Language | Status | Evidence |
|---|---|---|
| Node | ✅ | conformance + `test/unit/runtime.test.ts` (allowedHosts cases) |
| Python | ✅ | `tests/test_lifecycle.py::test_ssrf_allowlist_rejects_unlisted_host` + conformance |
| Go | ✅ | adapter config validation tests in `posthog_test.go` + conformance |
| Java | ✅ | `FireweaveRuntimeTest::ssrfAllowlistRejectsUnknownHost` + conformance |
| All | ⚠️ | Default-deny posture landed with J-H-1 (see [findings-disposition.md](findings-disposition.md)). Still missing: IP-literal-in-different-encodings cases (`http://0xa9fea9fe/`, `http://[::ffff:169.254.169.254]/`) — adversarial F-3. |

## T7 — Bounded retries / queues / shutdown

| Language | Status | Notes |
|---|---|---|
| Node | ⚠️ | Adapter options pin retries to 0 (asserted implicitly by integration tests) but nothing tests `shutdownTimeoutMs` (it's unused — finding M-1) or dedup-set growth (M-2). ❌ add: shutdown-completes-within-deadline test with a hanging vendor client; dedup memory-bound test. |
| Python | ⚠️ | `tests/test_lifecycle.py` covers idempotent shutdown; ❌ add: shutdown honors `timeout_ms` with a hanging vendor client (currently would fail — M-1). |
| Go | ✅ | `posthog_test.go` covers Close deadline (`DefaultCloseTimeout`); race-tested. |
| Java | ⚠️ | `FireweaveRuntimeTest` covers idempotency; ❌ add: bounded shutdown with a hanging injected client (`shutdownTimeoutMs` unenforced — M-1). |

## T8 — Concurrency / state isolation

| Language | Status | Evidence |
|---|---|---|
| Node | ⚠️ | Single-threaded; interleaved-async evaluation tests exist in `runtime.test.ts`; ❌ add an explicit test that two in-flight evaluations with different contexts can't observe each other's attributes (guards future refactors). |
| Python | ✅ | `tests/test_concurrency.py` (concurrent evaluation, shutdown idempotency, exposure dedup under threads) |
| Go | ✅ | `TestConcurrentEvaluation`, `TestConcurrentInitializeRunsAdapterOnce`, `TestClientConcurrentSafety`, whole suite under `-race` |
| Java | ✅ | `ConcurrencyTest::concurrentEvaluationsAreConsistent`, `concurrentExposureRecordingKeepsDedupInvariant` |

## T9 — No vendor types / no vendor text leaks

| Language | Status | Evidence |
|---|---|---|
| Node | ✅ | `test/unit/no-vendor-leak.test.ts` |
| Go | ✅ | `adapters/posthog/publicapi_test.go` (reflective API scan) |
| Java | ✅ | `PublicApiVendorScanTest` |
| Python | ⚠️ | No dedicated public-API scan test; adapter returns only `FlagResolution` by construction. ❌ add a symbol-scan test for parity. |

## T10 — Structured payloads are plain data

| Language | Status | Notes |
|---|---|---|
| All four | ✅ (conformance) | `eval-object-success`, `eval-payload-attached` exercise JSON-only parsing. ❌ add Node unit case: payload containing `"__proto__"`/`"constructor"` keys round-trips as inert data (ties to L-1). |

## T11 — Telemetry allowlist & redaction

| Language | Status | Evidence |
|---|---|---|
| Python | ✅ | `test_client_extensions.py::test_allowlist_drops_unknown_attributes`, `test_record_error_redacts_message`, `test_fail_reason_redacted` |
| Go | ✅ | `client_test.go::TestTelemetrySanitizerAllowlistAndRedaction`, `TestSignalsRecordAndRedact`, `TestReleaseFailRedactsReason` |
| Java | ✅ | `FireweaveClientExtensionsTest::telemetryAllowlistFiltersSignalAttributes` |
| Node | ⚠️ | Redaction tested (`client.test.ts`); allowlist only tested in opt-in form. ❌ add default-allowlist test once M-3 lands. |

## T12 — Nothing persisted to disk

| Language | Status | Notes |
|---|---|---|
| All four | ❌ | Verified by review (threat-model §R8) but untested. Add a CI guard (lint rule or grep check) forbidding file-write APIs in `sdks/*/src` production paths — cheap and durable. |

## Summary of missing tests to file with implementation owners

1. **All:** case-variant and embedded-secret redaction table tests (T2).
2. **Node/Python/Java:** bounded-shutdown-with-hanging-client tests (T7, blocked on fixing M-1).
3. **All:** default-deny allowlist posture test + encoded-IP SSRF variants (T6, blocked on H-1 for Node/Python).
4. **Node/Go/Java:** `fireweave.groups`/`fireweave.groupProperties` carve-out tests (T5, blocked on M-4 decision).
5. **Node:** `__proto__` payload/context inertness test (T10/L-1); dedup-set bound test (T7/M-2); default telemetry allowlist test (T11/M-3).
6. **Python:** public-API vendor-type scan (T9).
7. **All:** CI guard against file-write APIs in production source (T12).
