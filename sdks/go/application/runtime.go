package application

import (
	"context"
	"errors"
	"sync"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
)

// State is the runtime lifecycle state.
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
	// domain.DefaultLimits.
	Limits domain.Limits
	// RequireTargetingKey rejects evaluations whose merged context has no
	// targeting key (InvalidContext, TargetingKeyMissing).
	RequireTargetingKey bool
	// GlobalContext is an optional lowest-priority context layer merged
	// beneath every per-call context. It is copied at construction.
	GlobalContext domain.EvaluationContext
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
	limits              domain.Limits
	requireTargetingKey bool
	globalCtx           domain.EvaluationContext

	mu       sync.RWMutex // guards state + fatalErr
	initMu   sync.Mutex   // serializes Initialize
	state    State
	fatalErr *domain.Error
}

// NewRuntime constructs a runtime in the UNINITIALIZED state.
func NewRuntime(adapter BackendAdapter, cfg Config) *Runtime {
	return &Runtime{
		adapter:             adapter,
		limits:              cfg.Limits,
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
func (r *Runtime) InitError() *domain.Error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.fatalErr
}

// Initialize drives UNINITIALIZED -> INITIALIZING -> READY. Configuration
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
		return domain.NewError(domain.KindAlreadyClosed, "", nil)
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
		fwErr := asFireweaveError(err, domain.KindConfiguration)
		if fwErr.Kind == domain.KindConfiguration {
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
// a Decision carrying the caller default, Reason ERROR, and a typed Error.
// Validation runs in the fixed order spec/control-points.md "Validation,
// before any I/O" names — key, default-vs-type, context, lifecycle — and
// degrades to the caller's default on the first failure; only once all four
// pass does this reach the adapter (the one I/O call here).
func (r *Runtime) Evaluate(ctx context.Context, req ResolveRequest) domain.Decision {
	key, keyErr := domain.ValidateControlPointKey(req.FlagKey)
	if keyErr != nil {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, keyErr, nil)
	}

	if _, defErr := domain.ValidateDefaultValue(req.Type, req.DefaultValue); defErr != nil {
		return domain.ErrorDecision(key, req.DefaultValue, defErr, nil)
	}

	merged := domain.MergeContexts(r.globalCtx, req.Context)
	canonical, ctxErr := domain.ValidateContext(merged, r.limits, r.requireTargetingKey)
	if ctxErr != nil {
		return domain.ErrorDecision(key, req.DefaultValue, ctxErr, nil)
	}

	switch r.State() {
	case StateReady, StateStale:
		// proceed
	case StateShutdown:
		return domain.ErrorDecision(key, req.DefaultValue, domain.NewError(domain.KindAlreadyClosed, "", nil), nil)
	default:
		return domain.ErrorDecision(key, req.DefaultValue, domain.NewError(domain.KindNotReady, "", nil), nil)
	}

	req.FlagKey = key
	req.Context = canonical
	d := r.adapter.Resolve(ctx, req)
	if d.FlagKey == "" {
		d.FlagKey = key
	}
	if d.Error != nil {
		if d.Metadata == nil {
			d.Metadata = map[string]any{}
		}
		if _, ok := d.Metadata[domain.MetaErrorKind]; !ok {
			d.Metadata[domain.MetaErrorKind] = string(d.Error.Kind)
		}
		d.Reason = domain.ReasonError
	}
	return d
}

// RegisterTarget registers a user or device so rules can target its durable
// properties. Never throws/panics: this runs in sign-in paths, where a
// targeting concern must not break authentication. Adapters that do not
// implement TargetRegistrar (e.g. the fixture-only inmemory adapter) degrade
// with UnsupportedCapability.
func (r *Runtime) RegisterTarget(ctx context.Context, targetingKey string, opts RegisterTargetOptions) RegisterTargetResult {
	switch r.State() {
	case StateShutdown:
		return RegisterTargetResult{Error: domain.NewError(domain.KindAlreadyClosed, "", nil)}
	case StateUninitialized, StateInitializing, StateError, StateFatal:
		return RegisterTargetResult{Error: domain.NewError(domain.KindNotReady, "", nil)}
	}
	registrar, ok := r.adapter.(TargetRegistrar)
	if !ok {
		return RegisterTargetResult{Error: domain.NewError(domain.KindUnsupportedCapability, "", nil)}
	}
	return registrar.RegisterTarget(ctx, targetingKey, opts)
}

// MarkStale transitions READY -> STALE (adapter signals that flag data is
// being served from an aging cache). Evaluations continue in STALE.
func (r *Runtime) MarkStale() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == StateReady {
		r.state = StateStale
	}
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
		return asFireweaveError(err, domain.KindInternal)
	}
	return nil
}

// asFireweaveError coerces an arbitrary error into a typed *domain.Error,
// defaulting to the given kind. The original error is wrapped as the cause;
// its text is never copied into the safe message.
func asFireweaveError(err error, fallback domain.ErrorKind) *domain.Error {
	var fwErr *domain.Error
	if errors.As(err, &fwErr) {
		return fwErr
	}
	return domain.NewError(fallback, "", err)
}
