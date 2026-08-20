package inmemory

import (
	"context"
	"sync"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
)

func TestDeterministicResolution(t *testing.T) {
	v := int64(3)
	a := New(WithFlags(map[string]Flag{
		"fw-on":  {Type: domain.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true, Version: &v},
		"fw-off": {Type: domain.FlagTypeBoolean, Enabled: false, Variant: "off", Value: false},
	}))
	ctx := context.Background()
	ec := domain.NewEvaluationContext("u", nil)

	d := a.Resolve(ctx, domain.ResolveRequest{FlagKey: "fw-on", Type: domain.FlagTypeBoolean, DefaultValue: false, Context: ec})
	if d.Value != true || d.Reason != domain.ReasonTargetingMatch || d.Metadata[domain.MetaFlagVersion] != int64(3) {
		t.Fatalf("on = %+v", d)
	}

	d = a.Resolve(ctx, domain.ResolveRequest{FlagKey: "fw-off", Type: domain.FlagTypeBoolean, DefaultValue: true, Context: ec})
	if d.Value != false || d.Reason != domain.ReasonDisabled {
		t.Fatalf("off = %+v", d)
	}

	d = a.Resolve(ctx, domain.ResolveRequest{FlagKey: "nope", Type: domain.FlagTypeBoolean, DefaultValue: true, Context: ec})
	if d.Error == nil || d.Error.Kind != domain.KindFlagNotFound || d.Value != true {
		t.Fatalf("missing = %+v", d)
	}

	d = a.Resolve(ctx, domain.ResolveRequest{FlagKey: "fw-on", Type: domain.FlagTypeString, DefaultValue: "x", Context: ec})
	if d.Error == nil || d.Error.Kind != domain.KindTypeMismatch {
		t.Fatalf("mismatch = %+v", d)
	}
}

func TestMatchConditions(t *testing.T) {
	a := New(WithFlags(map[string]Flag{
		"fw-m": {Type: domain.FlagTypeString, Enabled: true, Variant: "hit", Value: "hit",
			MatchTargetingKey: "u1", MatchAttributes: map[string]any{"tier": "gold"}},
	}))
	ctx := context.Background()

	hit := a.Resolve(ctx, domain.ResolveRequest{FlagKey: "fw-m", Type: domain.FlagTypeString, DefaultValue: "miss",
		Context: domain.NewEvaluationContext("u1", map[string]any{"tier": "gold"})})
	if hit.Value != "hit" {
		t.Fatalf("hit = %+v", hit)
	}
	miss := a.Resolve(ctx, domain.ResolveRequest{FlagKey: "fw-m", Type: domain.FlagTypeString, DefaultValue: "miss",
		Context: domain.NewEvaluationContext("u1", map[string]any{"tier": "bronze"})})
	if miss.Value != "miss" || miss.Reason != domain.ReasonDefault {
		t.Fatalf("miss = %+v", miss)
	}
}

func TestFromCacheReportsStaleReason(t *testing.T) {
	a := New(WithFlags(map[string]Flag{
		"fw-stale": {Type: domain.FlagTypeBoolean, Enabled: true, Value: true, FromCache: true},
	}))
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-stale", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Reason != domain.ReasonStale || d.Metadata[domain.MetaFromCache] != true {
		t.Fatalf("stale = %+v", d)
	}
}

func TestConcurrentUse(t *testing.T) {
	a := New(WithFlags(map[string]Flag{
		"fw": {Type: domain.FlagTypeBoolean, Enabled: true, Value: true},
	}))
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = a.Resolve(context.Background(), domain.ResolveRequest{
				FlagKey: "fw", Type: domain.FlagTypeBoolean, DefaultValue: false,
				Context: domain.NewEvaluationContext("u", nil),
			})
		}()
	}
	wg.Wait()
	if a.ResolveCount() != 32 {
		t.Fatalf("resolve count = %d", a.ResolveCount())
	}
}

// inmemory implements no RegisterTarget — degrades UnsupportedCapability
// via Runtime's optional-interface discovery (asserted at the Runtime
// layer; here we just confirm the adapter itself does not satisfy
// domain.TargetRegistrar).
func TestInmemoryDoesNotImplementTargetRegistrar(t *testing.T) {
	var a any = New()
	if _, ok := a.(domain.TargetRegistrar); ok {
		t.Fatal("the fixture inmemory adapter must not implement TargetRegistrar")
	}
}
