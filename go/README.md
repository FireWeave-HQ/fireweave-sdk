# Fireweave Go SDK

Go module: `github.com/FireWeave-HQ/fireweave-sdk/go` (Go 1.25).

Exactly two v1 capabilities (spec/control-points.md "Scope of v1"): control
points (`Client.ControlPoints()`, the nine methods) and target registration
(`Client.RegisterTarget`). Releases, exposures, signals, capabilities
discovery, guardrails, and any OpenFeature provider are out of v1 scope and
are not exposed.

## Package layout

| Package | Responsibility |
| --- | --- |
| `domain` | Pure, dependency-free types and validators: the typed 15-kind error model, `Decision`/`FlagType`/`Reason`, `EvaluationContext` (merge + cycle-safe deep copy), the `BackendAdapter` port (see below for why it lives here rather than in `application`), and the pure validators (`ValidateControlPointKey`, `ValidateDefaultValue`, `ValidateContext`, `ValidateTargetingKey`, `ValidateInitOptions`). Imports nothing beyond the Go standard library. |
| `application` | The runtime engine (`Runtime`: lifecycle state machine, context merge/validation, evaluation pipeline) and the public `Client` surface (`ControlPoints`, `RegisterTarget`, `InvokeCapability`). `application/mode.go` is the sole composition root — the only file that imports concrete `infrastructure/adapters/*` packages — and hosts `Init`, the single SDK entry point. |
| `infrastructure/adapters/inmemory` | Deterministic, fixture-driven `BackendAdapter` for unit tests and the conformance harness. No target registration. |
| `infrastructure/adapters/local` | The local-development `BackendAdapter` (`Init`'s `Mode: local`): an in-process boolean seed map (reason `STATIC` on a hit, `DEFAULT` on a miss — never an error), plus `RegisterTarget` recording + a `[fireweave:local]` trace line. |
| `infrastructure/adapters/remote` | The production `BackendAdapter` (`Init`'s `Mode: remote`, ADR-0005): speaks only the Fireweave remote protocol to fw-server (`POST /v1/flags/evaluate`, `POST /v1/targets/register`) over `Authorization: Bearer <apiKey>`. No vendor SDK, key, or host in this process; which backend fw-server forwards to is fw-server's concern. |
| `fireweave` | The public façade: re-exports the above via type aliases and a thin `Init` wrapper, so callers only ever import this one package. Also hosts the layering/surface/init guard tests (this package sits at the same nesting depth as `domain`/`application`, mirroring where the java reference keeps its equivalent guard tests). |
| `internal/conformance`, `cmd/conformance`, `conformance` | Pre-existing, broken conformance-harness scaffolding predating the v1 relayer (references deleted `posthog`/`openfeature` packages) — Task 10 territory, deliberately untouched by this relayer. |

### Why `BackendAdapter` lives in `domain`, not `application`

Node and java file the adapter port under `application/ports.ts` /
`application/BackendAdapter.java` without creating an import cycle, because
their module systems resolve dependencies per **file**: the composition
root (`mode.ts` / `Fireweave.java`) imports the concrete adapter file, and
the adapter file imports the port file — two different files, no cycle.

Go resolves dependencies per **package** (one directory = one package;
every file in it shares the same import graph node). `application/mode.go`
(the composition root) must import `infrastructure/adapters/local` and
`infrastructure/adapters/remote` to wire `Init`'s adapter selection. If the
port types lived in `application` instead, every adapter package would need
to import `application` for them — and `application` importing those same
adapter packages back (via `mode.go`) would be a package-level import
cycle, which Go rejects at compile time. Placing the port in `domain`
(imported by everyone, importing nothing outside `domain`) is the
Go-idiomatic resolution — the layering itself is unchanged (domain →
application → infrastructure), only where the *port interface* is declared
moves down one layer. See `domain/adapter.go`'s doc comment and the
architecture guard tests in `fireweave/architecture_guard_test.go`.

## Concurrency guarantees

- `Runtime` and `Client` are safe for concurrent use by any number of
  goroutines. `Initialize` is serialized (the adapter initializes once);
  `Evaluate` holds only a read lock on lifecycle state, so evaluations run
  in parallel; `Shutdown` is idempotent, and evaluations racing a shutdown
  either complete or observe a typed `AlreadyClosed` default decision.
- `EvaluationContext` and `Decision` are treated as immutable after
  construction; the SDK deep-copies context attributes at API boundaries.
  The deep copy is cycle-safe: a caller-supplied `map[string]any`/`[]any`
  attribute value that references itself is detected by pointer identity
  (with backtracking, so a value legitimately shared by two sibling
  attributes is not a false positive) and the cyclic branch is replaced
  with `nil` rather than recursing forever — construction never panics.
  `EvaluationContext.HadCyclicInput()` reports the break, and
  `ValidateContext` checks it FIRST, before any other rule, failing closed
  as `InvalidContext`.
- No package holds package-level mutable state.
- Every blocking adapter method (`Initialize`, `Resolve`, `Close`,
  `RegisterTarget`) takes a `context.Context` and honors cancellation and
  deadlines. The public `Client.ControlPoints()` methods and
  `Client.RegisterTarget` do not take a caller-supplied `context.Context` —
  the descriptor-pinned arity in `conformance/surface/control-points.surface.json`
  has no room for one (only `key`, `default`, `context?` — the evaluation
  context, not a cancellation token); internally they call the runtime with
  `context.Background()`, and the remote adapter's own configured request
  timeout bounds the HTTP call.

## Modes (spec/modes.md)

```go
import "github.com/FireWeave-HQ/fireweave-sdk/go/fireweave"

// Local (offline, in-process seed map; may be empty):
client, err := fireweave.Init(fireweave.Options{
    Mode:  fireweave.ModeLocal,
    Local: &fireweave.LocalOptions{ControlPoints: map[string]bool{"new-checkout": true}},
})

// Remote (production, fw-server):
client, err := fireweave.Init(fireweave.Options{
    Mode:   fireweave.ModeRemote,
    APIKey: "project-api-key_…",
    APIURL: "https://app-server.fireweave.ai",
})
```

`Mode` is required and never inferred; `Init` returns a non-nil error (kind
`Configuration`) for every row of the initialisation-validation table
(mode absent/unrecognised, remote missing credentials, apiUrl failing the
SSRF host allowlist, local combined with credentials). Reads on the
returned `*Client` never return an error and never panic — failures
degrade to the caller's default with `Decision.Reason == "ERROR"`.

An unknown control point diverges deliberately by mode: local misses
resolve `default`/`DEFAULT` (not an error); remote misses resolve
`default`/`ERROR`/`FlagNotFound`.

### SSRF host allowlist (remote mode)

`infrastructure/adapters/remote.DefaultAllowedHosts` is the canonical
Fireweave production/staging hosts plus loopback — used when
`Options.AllowedHosts` is not set. This is deliberately **not** derived
from the configured `APIURL`'s own hostname (that would make the default
permissive by construction); a self-hosted fw-server must list its own
host explicitly, or pass `AllowedHosts: []string{"*"}` to opt out.

## Verification

```sh
go build ./domain/... ./application/... ./infrastructure/... ./fireweave/...
go vet ./domain/... ./application/... ./infrastructure/... ./fireweave/...
go test ./domain/... ./application/... ./infrastructure/... ./fireweave/...
```

`internal/conformance`, `cmd/conformance`, and `conformance` are excluded
above: they are pre-existing, broken scaffolding (deleted `posthog`/
`openfeature` package references) that predates the v1 relayer and is
Task 10's rewrite target, not this package's.
