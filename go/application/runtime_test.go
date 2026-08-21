package application

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/go/domain"
)

// stubAdapter is a programmable BackendAdapter for runtime tests.
type stubAdapter struct {
	initErr    error
	closeErr   error
	resolveFn  func(context.Context, ResolveRequest) domain.Decision
	registerFn func(context.Context, string, RegisterTargetOptions) RegisterTargetResult
	initCalls  atomic.Int64
	closeCalls atomic.Int64
}

func (s *stubAdapter) Initialize(ctx context.Context) error {
	s.initCalls.Add(1)
	return s.initErr
}

func (s *stubAdapter) Resolve(ctx context.Context, req ResolveRequest) domain.Decision {
	if s.resolveFn != nil {
		return s.resolveFn(ctx, req)
	}
	return domain.Decision{FlagKey: req.FlagKey, Value: true, Variant: "on", Reason: domain.ReasonTargetingMatch}
}

func (s *stubAdapter) Close(ctx context.Context) error {
	s.closeCalls.Add(1)
	return s.closeErr
}

func (s *stubAdapter) RegisterTarget(ctx context.Context, targetingKey string, opts RegisterTargetOptions) RegisterTargetResult {
	if s.registerFn != nil {
		return s.registerFn(ctx, targetingKey, opts)
	}
	return RegisterTargetResult{OK: true}
}

var _ TargetRegistrar = (*stubAdapter)(nil)

func readyRuntime(t *testing.T, adapter BackendAdapter) *Runtime {
	t.Helper()
	rt := NewRuntime(adapter, Config{})
	if err := rt.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	return rt
}

func TestLifecycleHappyPath(t *testing.T) {
	rt := NewRuntime(&stubAdapter{}, Config{})
	if rt.State() != StateUninitialized {
		t.Fatalf("initial state = %s", rt.State())
	}
	if err := rt.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.State() != StateReady {
		t.Fatalf("state after init = %s", rt.State())
	}
	if err := rt.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.State() != StateShutdown {
		t.Fatalf("state after shutdown = %s", rt.State())
	}
}

func TestConfigurationFailureIsFatal(t *testing.T) {
	rt := NewRuntime(&stubAdapter{initErr: domain.NewError(domain.KindConfiguration, "", nil)}, Config{})
	err := rt.Initialize(context.Background())
	if !errors.Is(err, domain.ErrConfiguration) {
		t.Fatalf("err = %v", err)
	}
	if rt.State() != StateFatal {
		t.Fatalf("state = %s, want FATAL", rt.State())
	}
	if err := rt.Initialize(context.Background()); !errors.Is(err, domain.ErrConfiguration) {
		t.Fatalf("re-init err = %v", err)
	}
}

func TestTransientFailureIsRetryable(t *testing.T) {
	adapter := &stubAdapter{initErr: domain.NewError(domain.KindNetwork, "", nil)}
	rt := NewRuntime(adapter, Config{})
	if err := rt.Initialize(context.Background()); !errors.Is(err, domain.ErrNetwork) {
		t.Fatalf("err = %v", err)
	}
	if rt.State() != StateError {
		t.Fatalf("state = %s, want ERROR", rt.State())
	}
	adapter.initErr = nil
	if err := rt.Initialize(context.Background()); err != nil {
		t.Fatalf("retry err = %v", err)
	}
	if rt.State() != StateReady {
		t.Fatalf("state = %s, want READY", rt.State())
	}
}

func TestEvaluateGatingByState(t *testing.T) {
	req := ResolveRequest{FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("k", nil)}

	rt := NewRuntime(&stubAdapter{}, Config{})
	d := rt.Evaluate(context.Background(), req)
	if d.Error == nil || d.Error.Kind != domain.KindNotReady || d.Value != false {
		t.Fatalf("uninitialized: %+v", d)
	}
	if d.Metadata[domain.MetaErrorKind] != "NotReady" {
		t.Fatalf("metadata = %v", d.Metadata)
	}

	rt = readyRuntime(t, &stubAdapter{})
	if d := rt.Evaluate(context.Background(), req); d.Error != nil {
		t.Fatalf("ready: %+v", d)
	}

	_ = rt.Shutdown(context.Background())
	d = rt.Evaluate(context.Background(), req)
	if d.Error == nil || d.Error.Kind != domain.KindAlreadyClosed {
		t.Fatalf("closed: %+v", d)
	}
	if d.Error.Message != "provider already closed" {
		t.Fatalf("message = %q", d.Error.Message)
	}
}

func TestEvaluateDefaultsNeverThrown(t *testing.T) {
	adapter := &stubAdapter{resolveFn: func(_ context.Context, req ResolveRequest) domain.Decision {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindBackendUnavailable, "", nil), nil)
	}}
	rt := readyRuntime(t, adapter)
	d := rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: domain.FlagTypeString, DefaultValue: "fallback",
		Context: domain.NewEvaluationContext("k", nil),
	})
	if d.Value != "fallback" || d.Reason != domain.ReasonError || d.Error.Kind != domain.KindBackendUnavailable {
		t.Fatalf("decision = %+v", d)
	}
}

func TestEvaluateValidationOrder(t *testing.T) {
	// Validation runs key -> default-vs-type -> context -> lifecycle,
	// stopping at the first failure (spec/control-points.md "Validation,
	// before any I/O"). None of these should ever reach the adapter.
	rt := readyRuntime(t, &stubAdapter{resolveFn: func(context.Context, ResolveRequest) domain.Decision {
		t.Fatal("adapter must not be reached when an earlier validation rule fails")
		return domain.Decision{}
	}})

	// 1. malformed key
	d := rt.Evaluate(context.Background(), ResolveRequest{FlagKey: "", Type: domain.FlagTypeBoolean, DefaultValue: false})
	if d.Error == nil || d.Error.Kind != domain.KindFlagNotFound {
		t.Errorf("empty key: %+v", d)
	}
	// 2. default vs type
	d = rt.Evaluate(context.Background(), ResolveRequest{FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: "not-a-bool"})
	if d.Error == nil || d.Error.Kind != domain.KindTypeMismatch {
		t.Errorf("bad default: %+v", d)
	}
	// 3. context (cyclic)
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	d = rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("u", map[string]any{"loop": cyclic}),
	})
	if d.Error == nil || d.Error.Kind != domain.KindInvalidContext {
		t.Errorf("cyclic context: %+v", d)
	}
}

func TestCyclicContextFailsClosedEndToEnd(t *testing.T) {
	rt := readyRuntime(t, &stubAdapter{})
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	d := rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("u", map[string]any{"loop": cyclic}),
	})
	if d.Value != false {
		t.Fatalf("value = %v, want the caller default", d.Value)
	}
	if d.Reason != domain.ReasonError || d.Error == nil || d.Error.Kind != domain.KindInvalidContext {
		t.Fatalf("decision = %+v, want ERROR/InvalidContext", d)
	}
}

func TestEvaluateMergesGlobalContext(t *testing.T) {
	var got domain.EvaluationContext
	adapter := &stubAdapter{resolveFn: func(_ context.Context, req ResolveRequest) domain.Decision {
		got = req.Context
		return domain.Decision{FlagKey: req.FlagKey, Value: true, Reason: domain.ReasonTargetingMatch}
	}}
	rt := NewRuntime(adapter, Config{GlobalContext: domain.NewEvaluationContext("org_g", map[string]any{"region": "us", "tier": "bronze"})})
	if err := rt.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("", map[string]any{"tier": "gold"}),
	})
	if got.TargetingKey != "org_g" || got.Attributes["tier"] != "gold" || got.Attributes["region"] != "us" {
		t.Fatalf("merged context = %+v", got)
	}
}

func TestShutdownIdempotentAndClosesOnce(t *testing.T) {
	adapter := &stubAdapter{}
	rt := readyRuntime(t, adapter)
	for i := 0; i < 3; i++ {
		if err := rt.Shutdown(context.Background()); err != nil {
			t.Fatalf("shutdown %d: %v", i, err)
		}
	}
	if n := adapter.closeCalls.Load(); n != 1 {
		t.Fatalf("adapter closed %d times, want 1", n)
	}
}

func TestConcurrentInitializeRunsAdapterOnce(t *testing.T) {
	adapter := &stubAdapter{}
	rt := NewRuntime(adapter, Config{})
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = rt.Initialize(context.Background())
		}()
	}
	wg.Wait()
	if n := adapter.initCalls.Load(); n != 1 {
		t.Fatalf("adapter initialized %d times, want 1", n)
	}
	if rt.State() != StateReady {
		t.Fatalf("state = %s", rt.State())
	}
}

func TestConcurrentEvaluation(t *testing.T) {
	rt := readyRuntime(t, &stubAdapter{})
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d := rt.Evaluate(context.Background(), ResolveRequest{
				FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
				Context: domain.NewEvaluationContext("k", map[string]any{"n": 1}),
			})
			if d.Error != nil {
				t.Errorf("unexpected error: %v", d.Error)
			}
		}()
	}
	wg.Wait()
}

func TestShutdownDuringEvaluation(t *testing.T) {
	release := make(chan struct{})
	adapter := &stubAdapter{resolveFn: func(ctx context.Context, req ResolveRequest) domain.Decision {
		<-release
		return domain.Decision{FlagKey: req.FlagKey, Value: true, Reason: domain.ReasonTargetingMatch}
	}}
	rt := readyRuntime(t, adapter)

	var wg sync.WaitGroup
	results := make([]domain.Decision, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = rt.Evaluate(context.Background(), ResolveRequest{
				FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
				Context: domain.NewEvaluationContext("k", nil),
			})
		}(i)
	}
	time.Sleep(10 * time.Millisecond)
	done := make(chan error, 1)
	go func() { done <- rt.Shutdown(context.Background()) }()
	close(release)
	wg.Wait()
	if err := <-done; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	for i, d := range results {
		if d.Error != nil && d.Error.Kind != domain.KindAlreadyClosed && d.Error.Kind != domain.KindNotReady {
			t.Errorf("result %d: unexpected error %v", i, d.Error)
		}
	}
}

func TestMarkStaleKeepsEvaluating(t *testing.T) {
	rt := readyRuntime(t, &stubAdapter{})
	rt.MarkStale()
	if rt.State() != StateStale {
		t.Fatalf("state = %s", rt.State())
	}
	d := rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("k", nil),
	})
	if d.Error != nil {
		t.Fatalf("stale evaluation failed: %v", d.Error)
	}
}

func TestRegisterTargetGatedByLifecycleAndDegradesWhenUnsupported(t *testing.T) {
	rt := NewRuntime(&stubAdapter{}, Config{})
	res := rt.RegisterTarget(context.Background(), "u1", RegisterTargetOptions{})
	if res.OK || res.Error == nil || res.Error.Kind != domain.KindNotReady {
		t.Fatalf("pre-init: %+v", res)
	}

	rt = readyRuntime(t, &stubAdapter{})
	res = rt.RegisterTarget(context.Background(), "u1", RegisterTargetOptions{})
	if !res.OK {
		t.Fatalf("ready: %+v", res)
	}

	// An adapter with no TargetRegistrar implementation degrades typed,
	// never panics.
	adapterNoRegistrar := &resolveOnlyAdapter{}
	rt2 := readyRuntime(t, adapterNoRegistrar)
	res = rt2.RegisterTarget(context.Background(), "u1", RegisterTargetOptions{})
	if res.OK || res.Error == nil || res.Error.Kind != domain.KindUnsupportedCapability {
		t.Fatalf("no-registrar adapter: %+v", res)
	}

	_ = rt.Shutdown(context.Background())
	res = rt.RegisterTarget(context.Background(), "u1", RegisterTargetOptions{})
	if res.OK || res.Error == nil || res.Error.Kind != domain.KindAlreadyClosed {
		t.Fatalf("closed: %+v", res)
	}
}

// resolveOnlyAdapter implements BackendAdapter but NOT TargetRegistrar.
type resolveOnlyAdapter struct{}

func (resolveOnlyAdapter) Initialize(ctx context.Context) error { return nil }
func (resolveOnlyAdapter) Resolve(ctx context.Context, req ResolveRequest) domain.Decision {
	return domain.Decision{FlagKey: req.FlagKey, Value: req.DefaultValue, Reason: domain.ReasonDefault}
}
func (resolveOnlyAdapter) Close(ctx context.Context) error { return nil }

var _ BackendAdapter = resolveOnlyAdapter{}
