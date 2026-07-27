# Fireweave Go SDK

Go module: `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` (Go 1.25).

## Package layout

| Package | Responsibility |
| --- | --- |
| `fireweave` | Shared runtime (lifecycle state machine, context merge/validation, typed 15-kind error model) and the FireweaveClient extensions (Releases, Exposures, Signals, Guardrails stub, Capabilities, telemetry allowlist/redaction). |
| `openfeature` | OpenFeature `FeatureProvider` (+ `ContextAwareStateHandler`) over the runtime; reserved-key guard hook; canonical error-code mapping. |
| `adapters/inmemory` | Deterministic fixture-driven `BackendAdapter` + `TelemetrySink` for tests and conformance. |
| `adapters/posthog` | `BackendAdapter` over `posthog-go v1.22.0` (ADR-0002): snapshot API only, remote/local-eval modes, exposure dedup gate, quota-limited detection, deadline-bounded `Close`. No vendor types in the exported API (asserted by `TestNoVendorTypesInPublicAPI`). |
| `internal/conformance` | Fixture loader, normative comparator, and runner for the `contracts/` suite. |
| `cmd/conformance` | `go run`-able conformance command emitting the compatibility report. |
| `conformance` | `go test` harness entry (`harness_test.go`, per contracts/harness.md). |

## Concurrency guarantees

- `Runtime` and `Client` are safe for concurrent use by any number of
  goroutines. `Initialize` is serialized (the adapter initializes once);
  `Evaluate` holds only a read lock on lifecycle state, so evaluations run
  in parallel; `Shutdown` is idempotent, and evaluations racing a shutdown
  either complete or observe a typed `AlreadyClosed` default decision.
- Value types (`EvaluationContext`, `Decision`, `Error`) are immutable
  after construction; the SDK deep-copies at API boundaries.
- No package holds package-level mutable state.
- Every blocking call takes a `context.Context` and honors cancellation
  and deadlines — including `Close` on the PostHog adapter, which never
  inherits posthog-go's indefinite-wait default.

## Verification

```sh
go build ./... && go vet ./... && go test -race ./...
go run ./cmd/conformance -contracts ../../contracts -out compatibility-report.go.json
```
