package domain

import "context"

// ResolveRequest carries one flag resolution through the runtime to a
// BackendAdapter. Context has already been merged and validated and is a
// private copy the adapter may read freely.
type ResolveRequest struct {
	FlagKey      string
	Type         FlagType
	DefaultValue any
	Context      EvaluationContext
}

// BackendAdapter is the vendor seam. Implementations:
// infrastructure/adapters/remote (production fw-server path),
// infrastructure/adapters/local (offline development),
// infrastructure/adapters/inmemory (deterministic fixture adapter for
// tests).
//
// This port lives in domain rather than application deliberately: Go
// resolves import dependencies per PACKAGE (unlike node/python/java, whose
// module systems resolve per FILE), and application's composition root
// (application/mode.go) must import the concrete adapter packages to wire
// Init's adapter selection. If the port types lived in application instead,
// every adapter package would need to import application for them — and
// application (via mode.go) importing those same adapter packages back
// would be a package-level import cycle, which Go rejects at compile time.
// Placing the port in domain (imported by everyone, importing nothing
// outside domain) is the Go-idiomatic resolution: this is exactly the kind
// of import-cycle-driven layout adjustment node/java did not need to make.
//
// Implementations must be safe for concurrent use: Resolve may be called
// from many goroutines, potentially concurrently with Close. Every blocking
// method accepts a context.Context and must honor cancellation and
// deadlines.
type BackendAdapter interface {
	// Initialize prepares the adapter (client construction, initial polls).
	// A returned *Error with KindConfiguration is treated as fatal.
	Initialize(ctx context.Context) error
	// Resolve evaluates one flag. Failures are reported inside the
	// Decision (Reason ERROR + typed Error) or, for an adapter whose
	// "unknown key" row is default/DEFAULT rather than an error
	// (spec/modes.md "Behaviour per mode"), as a plain Decision carrying
	// the caller's default with reason DEFAULT — Resolve never panics.
	Resolve(ctx context.Context, req ResolveRequest) Decision
	// Close releases resources. It must be idempotent and must return once
	// ctx is done even if the underlying vendor client would wait longer.
	Close(ctx context.Context) error
}

// RegisterTargetOptions carries the optional fields for
// POST /v1/targets/register (spec/remote-register-target.schema.json).
type RegisterTargetOptions struct {
	// Kind defaults to "user" (TargetKindUser) when empty.
	Kind TargetKind
	// Properties are durable targeting facts: plan, beta membership,
	// region, device model.
	Properties map[string]any
	// Environment is the client-declared environment (production, staging, …).
	Environment string
}

// RegisterTargetResult reports the outcome of registration. OK false means
// the target was NOT registered — rules that depend on its properties will
// not match until a later attempt succeeds. Callers in a login path
// normally ignore this; a careful caller logs it, because a silently
// unregistered target is exactly how targeting rules end up matching
// nobody.
type RegisterTargetResult struct {
	OK    bool
	Error *Error
}

// TargetRegistrar is optionally implemented by adapters that can register a
// target (infrastructure/adapters/local records in-process and traces;
// infrastructure/adapters/remote POSTs to fw-server). Runtime discovers it
// via type assertion; an adapter that does not implement it (e.g. the
// fixture-only inmemory adapter) degrades RegisterTarget with
// UnsupportedCapability — never a panic, since registration sits in
// sign-in paths where a targeting concern must not break authentication.
type TargetRegistrar interface {
	RegisterTarget(ctx context.Context, targetingKey string, opts RegisterTargetOptions) RegisterTargetResult
}
