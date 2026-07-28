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

## Fireweave-specific idioms

- **`fireweave.WithIncludePayload(ctx)`** — OpenFeature has no
  per-invocation provider options, so payload attachment is requested
  through the Go `context.Context`. Marking the context makes the
  evaluation attach the flag's JSON payload as the `fireweave.payload`
  flag-metadata entry (a JSON-string serialization):

  ```go
  ctx = fireweave.WithIncludePayload(ctx)
  details, _ := ofClient.BooleanValueDetails(ctx, "my-flag", false, evalCtx)
  payload := details.FlagMetadata["fireweave.payload"]
  ```

- **`$`-prefixed attribute stripping** — context attributes whose key
  starts with `$` (e.g. `$process_person_profile`) are PostHog vendor
  directives. The PostHog adapter forwards them to the vendor request but
  strips them from `person_properties`; they are never transmitted as
  person data and never appear in the resolved Fireweave context.

- **Group targeting (canonical keys)** — `fireweave.groups` and
  `fireweave.groupProperties` are the canonical evaluation-context keys
  for group targeting (orchestrator rulings 12–14) and the only permitted
  `fireweave.*` context keys; anything else under that prefix is rejected
  with `InvalidContext`. The typed
  `EvaluationContext.WithGroups`/`WithGroupProperties`/`Groups`/`GroupProperties`
  accessors are idiomatic sugar over exactly these keys. The plain
  `groups`/`groupProperties` spellings remain supported as a documented
  pre-canon alias (canonical keys win when both are present).

- **Host allowlist & schemes** — the default endpoint allowlist is the
  canonical cross-language list (`app.posthog.com`, `us.posthog.com`,
  `eu.posthog.com`, `us.i.posthog.com`, `eu.i.posthog.com`, plus loopback).
  `https` is required for non-loopback hosts; plain `http` is allowed on
  loopback only. Self-hosted endpoints require an explicit
  `Config.AllowedHosts` entry.

- **Exposure dedup lifecycle** — exposure dedup sets (both the
  `Exposures` extension seen-set and the PostHog `$feature_flag_called`
  gate) clear on every flush, so dedup state is bounded by the flush
  window instead of growing for the process lifetime.

- **Capabilities** — `client.Capabilities().Get()` returns the structured
  static/runtime capability matrix per `spec/capabilities.schema.json`
  (ruling 18); `client.Capabilities().Operations()` lists the flat
  extension-operation names accepted by `Invoke`.

## Verification

```sh
go build ./... && go vet ./... && go test -race ./...
go run ./cmd/conformance -contracts ../../contracts -out compatibility-report.go.json
```

By default fault fixtures run against an injected fake `http.RoundTripper`
(hermetic, no network). To exercise the fault suite over real HTTP against
the deterministic test-server stub, start it and set
`FIREWEAVE_TEST_SERVER_URL`:

```sh
node ../../test-server/implementation/server.mjs --port 3901 &
FIREWEAVE_TEST_SERVER_URL=http://127.0.0.1:3901 \
  go run ./cmd/conformance -contracts ../../contracts -out compatibility-report.go.json
```

Fault modes the stub control plane supports (401/429/500, invalid JSON,
delay/timeout, quota-limited) then run over a live loopback connection;
`networkError`/`offline` (connection reset / refused) remain on the fake
transport, and `fault-stale-cache` remains simulated on the in-memory
adapter.
