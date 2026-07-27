package fireweave

import (
	"context"
	"errors"
	"sync"
)

// State is the runtime lifecycle state (docs/architecture.md).
type State string

const (
	StateUninitialized State = "UNINITIALIZED"
	StateInitializing  State = "INITIALIZING"
	StateReady         State = "READY"
	StateStale         State = "STALE"
	StateError         State = "ERROR"
	StateFatal         State = "FATAL"
	StateShutdown      State = "SHUTDOWN"
)

// Config configures a Runtime.
type Config struct {
	// Limits bounds evaluation contexts; zero fields fall back to
	// DefaultLimits.
	Limits Limits
	// RequireTargetingKey rejects evaluations whose merged context has no
	// targeting key (TARGETING_KEY_MISSING at the OpenFeature boundary).
	RequireTargetingKey bool
	// GlobalContext is an optional lowest-priority context layer merged
	// beneath every per-call context. It is copied at construction.
	GlobalContext EvaluationContext
}

// Runtime is the shared Fireweave engine: it owns the lifecycle state
// machine, gates evaluations on state, merges and validates contexts, and
// delegates resolution to a BackendAdapter.
//
// Concurrency guarantees:
//   - All methods are safe for concurrent use by multiple goroutines.
//   - Initialize is serialized; concurrent callers observe a single adapter
//     initialization (subsequent calls on a READY runtime are no-ops).
//   - Evaluate takes only a read lock on lifecycle state; adapter Resolve
//     calls run without any runtime lock, so evaluations proceed in
//     parallel.
//   - Shutdown is idempotent. Evaluations racing with Shutdown either
//     complete against the still-open adapter or observe SHUTDOWN and
//     return an AlreadyClosed default decision. After Shutdown returns, all
//     new evaluations return AlreadyClosed.
type Runtime struct {
	adapter             BackendAdapter
	limits              Limits
	requireTargetingKey bool
	globalCtx           EvaluationContext

	mu       sync.RWMutex // guards state + fatalErr
	initMu   sync.Mutex   // serializes Initialize
	state    State
	fatalErr *Error
}

// NewRuntime constructs a runtime in the UNINITIALIZED state.
func NewRuntime(adapter BackendAdapter, cfg Config) *Runtime {
	return &Runtime{
		adapter:             adapter,
		limits:              cfg.Limits.withDefaults(),
		requireTargetingKey: cfg.RequireTargetingKey,
		globalCtx:           cfg.GlobalContext.Copy(),
		state:               StateUninitialized,
	}
}

// State returns the current lifecycle state.
func (r *Runtime) State() State {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state
}

// Adapter returns the backend adapter the runtime was built with.
func (r *Runtime) Adapter() BackendAdapter { return r.adapter }

// InitError returns the fatal initialization error, if any.
func (r *Runtime) InitError() *Error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.fatalErr
}

// Initialize drives UNINITIALIZED → INITIALIZING → READY. Configuration
// failures land in FATAL; other failures land in ERROR (retryable via a
// subsequent Initialize). Initialize after Shutdown returns AlreadyClosed.
// Concurrent calls are serialized and the adapter is initialized once.
func (r *Runtime) Initialize(ctx context.Context) error {
	r.initMu.Lock()
	defer r.initMu.Unlock()

	r.mu.Lock()
	switch r.state {
	case StateShutdown:
		r.mu.Unlock()
		return NewError(KindAlreadyClosed, "", nil)
	case StateReady, StateStale:
		r.mu.Unlock()
		return nil
	case StateFatal:
		err := r.fatalErr
		r.mu.Unlock()
		return err
	}
	r.state = StateInitializing
	r.mu.Unlock()

	err := r.adapter.Initialize(ctx)

	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		fwErr := asFireweaveError(err, KindConfiguration)
		if fwErr.Kind == KindConfiguration {
			r.state = StateFatal
			r.fatalErr = fwErr
		} else {
			r.state = StateError
		}
		return fwErr
	}
	r.state = StateReady
	return nil
}

// Evaluate resolves a flag. It never returns an error: failures surface as
// a Decision carrying the caller default, Reason ERROR, and a typed Error
// (OpenFeature default semantics).
func (r *Runtime) Evaluate(ctx context.Context, req ResolveRequest) Decision {
	switch r.State() {
	case StateReady, StateStale:
		// proceed
	case StateShutdown:
		return ErrorDecision(req.DefaultValue, NewError(KindAlreadyClosed, "", nil), nil)
	default:
		return ErrorDecision(req.DefaultValue, NewError(KindNotReady, "", nil), nil)
	}

	merged := MergeContexts(r.globalCtx, req.Context)
	if vErr := ValidateContext(merged, r.limits, r.requireTargetingKey); vErr != nil {
		return ErrorDecision(req.DefaultValue, vErr, nil)
	}

	req.Context = merged
	d := r.adapter.Resolve(ctx, req)
	if d.Error != nil {
		if d.Metadata == nil {
			d.Metadata = map[string]any{}
		}
		if _, ok := d.Metadata[MetaErrorKind]; !ok {
			d.Metadata[MetaErrorKind] = string(d.Error.Kind)
		}
		d.Reason = ReasonError
	}
	return d
}

// MarkStale transitions READY → STALE (adapter signals that flag data is
// being served from an aging cache). Evaluations continue in STALE.
func (r *Runtime) MarkStale() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == StateReady {
		r.state = StateStale
	}
}

// Flush drains adapter-buffered telemetry when the adapter supports it.
func (r *Runtime) Flush(ctx context.Context) error {
	if sink, ok := r.adapter.(TelemetrySink); ok {
		return sink.FlushTelemetry(ctx)
	}
	return nil
}

// Shutdown transitions to SHUTDOWN and closes the adapter exactly once.
// Additional calls are no-ops returning nil (idempotent shutdown).
func (r *Runtime) Shutdown(ctx context.Context) error {
	r.mu.Lock()
	if r.state == StateShutdown {
		r.mu.Unlock()
		return nil
	}
	r.state = StateShutdown
	r.mu.Unlock()

	if err := r.adapter.Close(ctx); err != nil {
		return asFireweaveError(err, KindInternal)
	}
	return nil
}

// asFireweaveError coerces an arbitrary error into a typed *Error,
// defaulting to the given kind. The original error is wrapped as the cause;
// its text is never copied into the safe message.
func asFireweaveError(err error, fallback ErrorKind) *Error {
	var fwErr *Error
	if errors.As(err, &fwErr) {
		return fwErr
	}
	return NewError(fallback, "", err)
}
