# Fireweave Error Taxonomy

Canonical error kinds for Fireweave providers. Language SDKs map these to OpenFeature resolution errors; the **client evaluation API never throws** — abnormal execution returns the caller-supplied **default value** with `reason=ERROR` and `errorCode` set (OpenFeature spec §1.4.10).

Machine-readable twin: [`errors.json`](./errors.json).

## Global rules

1. **Defaults do not throw.** Providers may throw/raise internally (Node/Python/Java) or set `ResolutionError` (Go); the OpenFeature SDK converts to default-valued details. Fireweave public facades that wrap the client MUST preserve this.
2. **No secrets in messages.** Never include API keys (`phc_`, `phx_`, `phs_`), bearer tokens, `FW_PROJECT_API_KEY` values, Authorization headers, or raw credential env contents in `errorMessage`, logs, or extension signals.
3. **Stable `kind` strings** below are Fireweave-canonical; `openFeatureErrorCode` is what appears in evaluation details.
4. **Retryable** means a later identical call *may* succeed without config change. **Transient** vs **permanent** classifies failure durability for adapters and signals.

## Error catalog

| kind | OF `errorCode` | retryable | class | When |
| --- | --- | --- | --- | --- |
| `NotReady` | `PROVIDER_NOT_READY` | yes | transient | Evaluation before successful init / during cold-start gate |
| `FlagNotFound` | `FLAG_NOT_FOUND` | no | permanent | Flag absent from snapshot / definitions (includes quota-empty as not-found → default) |
| `TypeMismatch` | `TYPE_MISMATCH` | no | permanent | Stored type ≠ requested typed getter |
| `InvalidContext` | `INVALID_CONTEXT` or `TARGETING_KEY_MISSING` | no | permanent | Bad/oversized context; missing targeting key when required |
| `Authentication` | `GENERAL` | no | permanent | 401 / invalid project or secret key |
| `Authorization` | `GENERAL` | no | permanent | 403 / key lacks flag permission |
| `RateLimited` | `GENERAL` | yes | transient | HTTP 429 from the backend (still serve defaults; `/flags` `quotaLimited` is `FlagNotFound`, see quota note) |
| `Timeout` | `GENERAL` | yes | transient | Flag-request or init deadline exceeded |
| `Network` | `GENERAL` | yes | transient | DNS/connect/reset/TLS transport failure |
| `BackendUnavailable` | `GENERAL` | yes | transient | 5xx / upstream unavailable |
| `MalformedResponse` | `PARSE_ERROR` | no | permanent* | Non-JSON or schema-invalid `/flags` or definitions body |
| `UnsupportedCapability` | `GENERAL` | no | permanent | Extension/capability not implemented in this SDK build |
| `Configuration` | `PROVIDER_FATAL` (init) / `GENERAL` (runtime) | no | permanent | Invalid host, mutually exclusive options, missing required config |
| `AlreadyClosed` | `PROVIDER_NOT_READY` | no | permanent | Call after shutdown / close (Fireweave kind preserved in `flagMetadata["fireweave.errorKind"]`) |
| `Internal` | `GENERAL` | no† | permanent | Unexpected invariant violation |

\* Malformed payloads are treated permanent for a given response; a later poll may succeed — adapters MAY retry the **transport** but MUST NOT invent flag values.  
† `Internal` is not retryable by default; operators may restart the process.

### OpenFeature code coverage

All eight OF codes are reachable:

| OF code | Fireweave kind(s) |
| --- | --- |
| `PROVIDER_NOT_READY` | `NotReady`, `AlreadyClosed` (post-shutdown) |
| `PROVIDER_FATAL` | `Configuration` (init-fatal path) |
| `FLAG_NOT_FOUND` | `FlagNotFound` |
| `PARSE_ERROR` | `MalformedResponse` |
| `TYPE_MISMATCH` | `TypeMismatch` |
| `TARGETING_KEY_MISSING` | `InvalidContext` (subtype when targeting key required/missing) |
| `INVALID_CONTEXT` | `InvalidContext` |
| `GENERAL` | `Authentication`, `Authorization`, `RateLimited`, `Timeout`, `Network`, `BackendUnavailable`, `UnsupportedCapability`, `Internal`, non-fatal `Configuration` |

Fireweave may attach `flagMetadata["fireweave.errorKind"]` with the canonical `kind` for diagnostics (never secrets).

### `InvalidContext` subtype selection

- Missing required `targetingKey` → OF `TARGETING_KEY_MISSING`.
- All other context violations (type, reserved keys misuse, size/depth/count bounds) → OF `INVALID_CONTEXT`.

### Quota limiting note

PostHog `/flags?v=2` may return HTTP 200 with `quotaLimited: ["feature_flags"]` and empty `flags`. Evaluation MUST return the **default** with `FlagNotFound` / `FLAG_NOT_FOUND` and set `flagMetadata["fireweave.quotaLimited"] = true`. Do not treat as outage/`BackendUnavailable`.

### Message guidelines

Safe examples:

- `"flag not found"`
- `"provider not ready"`
- `"authentication failed"`
- `"context exceeds maximum nesting depth"`

Forbidden examples:

- `"invalid key phc_abc…"`
- `"Authorization: Bearer …"`
- Full response bodies that may embed PII from flag definitions
