package inmemory

import (
	"context"
	"sync"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
)

func TestDeterministicResolution(t *testing.T) {
	v := int64(3)
	a := New(WithFlags(map[string]Flag{
		"fw-on":  {Type: fireweave.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true, Version: &v},
		"fw-off": {Type: fireweave.FlagTypeBoolean, Enabled: false, Variant: "off", Value: false},
	}))
	ctx := context.Background()
	ec := fireweave.NewEvaluationContext("u", nil)

	d := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-on", Type: fireweave.FlagTypeBoolean, DefaultValue: false, Context: ec})
	if d.Value != true || d.Reason != fireweave.ReasonTargetingMatch || d.Metadata[fireweave.MetaFlagVersion] != int64(3) {
		t.Fatalf("on = %+v", d)
	}

	d = a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-off", Type: fireweave.FlagTypeBoolean, DefaultValue: true, Context: ec})
	if d.Value != false || d.Reason != fireweave.ReasonDisabled {
		t.Fatalf("off = %+v", d)
	}

	d = a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "nope", Type: fireweave.FlagTypeBoolean, DefaultValue: true, Context: ec})
	if d.Error == nil || d.Error.Kind != fireweave.KindFlagNotFound || d.Value != true {
		t.Fatalf("missing = %+v", d)
	}

	d = a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-on", Type: fireweave.FlagTypeString, DefaultValue: "x", Context: ec})
	if d.Error == nil || d.Error.Kind != fireweave.KindTypeMismatch {
		t.Fatalf("mismatch = %+v", d)
	}
}

func TestMatchConditions(t *testing.T) {
	a := New(WithFlags(map[string]Flag{
		"fw-m": {Type: fireweave.FlagTypeString, Enabled: true, Variant: "hit", Value: "hit",
			MatchTargetingKey: "u1", MatchAttributes: map[string]any{"tier": "gold"}},
	}))
	ctx := context.Background()

	hit := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-m", Type: fireweave.FlagTypeString, DefaultValue: "miss",
		Context: fireweave.NewEvaluationContext("u1", map[string]any{"tier": "gold"})})
	if hit.Value != "hit" {
		t.Fatalf("hit = %+v", hit)
	}
	miss := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-m", Type: fireweave.FlagTypeString, DefaultValue: "miss",
		Context: fireweave.NewEvaluationContext("u1", map[string]any{"tier": "bronze"})})
	if miss.Value != "miss" || miss.Reason != fireweave.ReasonDefault {
		t.Fatalf("miss = %+v", miss)
	}
}

func TestTelemetrySink(t *testing.T) {
	a := New()
	ctx := context.Background()
	_ = a.EnqueueTelemetry(ctx, fireweave.TelemetryEvent{Name: "$fw_exposure", DistinctID: "u"})
	if len(a.PendingTelemetry()) != 1 || len(a.DeliveredTelemetry()) != 0 {
		t.Fatal("enqueue should buffer")
	}
	_ = a.FlushTelemetry(ctx)
	if len(a.PendingTelemetry()) != 0 || len(a.DeliveredTelemetry()) != 1 {
		t.Fatal("flush should deliver")
	}
}

func TestConcurrentUse(t *testing.T) {
	a := New(WithFlags(map[string]Flag{
		"fw": {Type: fireweave.FlagTypeBoolean, Enabled: true, Value: true},
	}))
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = a.Resolve(context.Background(), fireweave.ResolveRequest{
				FlagKey: "fw", Type: fireweave.FlagTypeBoolean, DefaultValue: false,
				Context: fireweave.NewEvaluationContext("u", nil),
			})
			_ = a.EnqueueTelemetry(context.Background(), fireweave.TelemetryEvent{Name: "e"})
			_ = a.FlushTelemetry(context.Background())
		}()
	}
	wg.Wait()
	if a.ResolveCount() != 32 {
		t.Fatalf("resolve count = %d", a.ResolveCount())
	}
}
