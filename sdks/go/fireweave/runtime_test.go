package fireweave

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stubAdapter is a programmable BackendAdapter for runtime tests.
type stubAdapter struct {
	initErr    error
	closeErr   error
	resolveFn  func(context.Context, ResolveRequest) Decision
	initCalls  atomic.Int64
	closeCalls atomic.Int64
}

func (s *stubAdapter) Initialize(ctx context.Context) error {
	s.initCalls.Add(1)
	return s.initErr
}

func (s *stubAdapter) Resolve(ctx context.Context, req ResolveRequest) Decision {
	if s.resolveFn != nil {
		return s.resolveFn(ctx, req)
	}
	return Decision{Value: true, Variant: "on", Reason: ReasonTargetingMatch}
}

func (s *stubAdapter) Close(ctx context.Context) error {
	s.closeCalls.Add(1)
	return s.closeErr
}

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
	rt := NewRuntime(&stubAdapter{initErr: NewError(KindConfiguration, "", nil)}, Config{})
	err := rt.Initialize(context.Background())
	if !errors.Is(err, ErrConfiguration) {
		t.Fatalf("err = %v", err)
	}
	if rt.State() != StateFatal {
		t.Fatalf("state = %s, want FATAL", rt.State())
	}
	// FATAL is terminal: re-init returns the stored error.
	if err := rt.Initialize(context.Background()); !errors.Is(err, ErrConfiguration) {
		t.Fatalf("re-init err = %v", err)
	}
}

func TestTransientFailureIsRetryable(t *testing.T) {
	adapter := &stubAdapter{initErr: NewError(KindNetwork, "", nil)}
	rt := NewRuntime(adapter, Config{})
	if err := rt.Initialize(context.Background()); !errors.Is(err, ErrNetwork) {
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
	req := ResolveRequest{FlagKey: "f", Type: FlagTypeBoolean, DefaultValue: false,
		Context: NewEvaluationContext("k", nil)}

	rt := NewRuntime(&stubAdapter{}, Config{})
	d := rt.Evaluate(context.Background(), req)
	if d.Error == nil || d.Error.Kind != KindNotReady || d.Value != false {
		t.Fatalf("uninitialized: %+v", d)
	}
	if d.Metadata[MetaErrorKind] != "NotReady" {
		t.Fatalf("metadata = %v", d.Metadata)
	}

	rt = readyRuntime(t, &stubAdapter{})
	if d := rt.Evaluate(context.Background(), req); d.Error != nil {
		t.Fatalf("ready: %+v", d)
	}

	_ = rt.Shutdown(context.Background())
	d = rt.Evaluate(context.Background(), req)
	if d.Error == nil || d.Error.Kind != KindAlreadyClosed {
		t.Fatalf("closed: %+v", d)
	}
	if d.Error.Message != "provider already closed" {
		t.Fatalf("message = %q", d.Error.Message)
	}
}

func TestEvaluateDefaultsNeverThrown(t *testing.T) {
	adapter := &stubAdapter{resolveFn: func(_ context.Context, req ResolveRequest) Decision {
		return ErrorDecision(req.DefaultValue, NewError(KindBackendUnavailable, "", nil), nil)
	}}
	rt := readyRuntime(t, adapter)
	d := rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: FlagTypeString, DefaultValue: "fallback",
		Context: NewEvaluationContext("k", nil),
	})
	if d.Value != "fallback" || d.Reason != ReasonError || d.Error.Kind != KindBackendUnavailable {
		t.Fatalf("decision = %+v", d)
	}
}

func TestEvaluateMergesGlobalContext(t *testing.T) {
	var got EvaluationContext
	adapter := &stubAdapter{resolveFn: func(_ context.Context, req ResolveRequest) Decision {
		got = req.Context
		return Decision{Value: true, Reason: ReasonTargetingMatch}
	}}
	rt := NewRuntime(adapter, Config{GlobalContext: NewEvaluationContext("org_g", map[string]any{"region": "us", "tier": "bronze"})})
	if err := rt.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	rt.Evaluate(context.Background(), ResolveRequest{
		FlagKey: "f", Type: FlagTypeBoolean, DefaultValue: false,
		Context: NewEvaluationContext("", map[string]any{"tier": "gold"}),
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
				FlagKey: "f", Type: FlagTypeBoolean, DefaultValue: false,
				Context: NewEvaluationContext("k", map[string]any{"n": 1}),
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
	adapter := &stubAdapter{resolveFn: func(ctx context.Context, req ResolveRequest) Decision {
		<-release
		return Decision{Value: true, Reason: ReasonTargetingMatch}
	}}
	rt := readyRuntime(t, adapter)

	var wg sync.WaitGroup
	results := make([]Decision, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = rt.Evaluate(context.Background(), ResolveRequest{
				FlagKey: "f", Type: FlagTypeBoolean, DefaultValue: false,
				Context: NewEvaluationContext("k", nil),
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
	// Each racing evaluation either completed against the open adapter or
	// observed AlreadyClosed; nothing panicked or hung.
	for i, d := range results {
		if d.Error != nil && d.Error.Kind != KindAlreadyClosed && d.Error.Kind != KindNotReady {
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
		FlagKey: "f", Type: FlagTypeBoolean, DefaultValue: false,
		Context: NewEvaluationContext("k", nil),
	})
	if d.Error != nil {
		t.Fatalf("stale evaluation failed: %v", d.Error)
	}
}
