package inmemory

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/domain"
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

// TestNumberValuePreservesIntegersBeyondSafeInteger is the regression test
// for task-10b item 2 (contracts/evaluation/eval-int-beyond-safe-integer.json):
// convertValue() previously coerced every NUMBER-typed value through
// float64 unconditionally, silently rounding 9007199254740993 (2^53+1) to
// 9007199254740992 — this asserts the exact int64 value survives, both from
// the json.Number shape the real fixture-decode path produces (via
// json.Decoder.UseNumber, internal/conformance/runner.go) and from a plain
// Go int64, while a genuinely fractional value still resolves through the
// float64 path unchanged.
func TestNumberValuePreservesIntegersBeyondSafeInteger(t *testing.T) {
	const huge int64 = 9007199254740993 // 2^53 + 1
	ec := domain.NewEvaluationContext("u", nil)

	a := New(WithFlags(map[string]Flag{
		"fw-big-int-jsonnumber": {Type: domain.FlagTypeNumber, Enabled: true, Variant: "huge", Value: json.Number("9007199254740993")},
		"fw-big-int-int64":      {Type: domain.FlagTypeNumber, Enabled: true, Variant: "huge", Value: huge},
		"fw-fractional":         {Type: domain.FlagTypeNumber, Enabled: true, Variant: "frac", Value: json.Number("2.5")},
	}))

	d := a.Resolve(context.Background(), domain.ResolveRequest{FlagKey: "fw-big-int-jsonnumber", Type: domain.FlagTypeNumber, DefaultValue: 0, Context: ec})
	if got, ok := d.Value.(int64); !ok || got != huge {
		t.Fatalf("json.Number path: want int64(%d), got %T(%v)", huge, d.Value, d.Value)
	}

	d = a.Resolve(context.Background(), domain.ResolveRequest{FlagKey: "fw-big-int-int64", Type: domain.FlagTypeNumber, DefaultValue: 0, Context: ec})
	if got, ok := d.Value.(int64); !ok || got != huge {
		t.Fatalf("int64 path: want int64(%d), got %T(%v)", huge, d.Value, d.Value)
	}

	d = a.Resolve(context.Background(), domain.ResolveRequest{FlagKey: "fw-fractional", Type: domain.FlagTypeNumber, DefaultValue: 0, Context: ec})
	if got, ok := d.Value.(float64); !ok || got != 2.5 {
		t.Fatalf("fractional path: want float64(2.5), got %T(%v)", d.Value, d.Value)
	}
}

// TestIncludePayloadAttachesSortedKeyJSON is the regression test for
// task-10b item 5 (contracts/evaluation/eval-payload-attached.json): go's
// EvaluateOptions was an empty struct with no includePayload equivalent, so
// fireweave.payload was never attached. Asserts the sorted-key JSON string
// shape matches node's stableStringify output exactly, that it is omitted
// when IncludePayload is false, and omitted when the flag has no payload at
// all even if IncludePayload is true.
func TestIncludePayloadAttachesSortedKeyJSON(t *testing.T) {
	ec := domain.NewEvaluationContext("u", nil)
	a := New(WithFlags(map[string]Flag{
		"fw-payload": {
			Type: domain.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true,
			Payload: map[string]any{"rolloutId": "rollout_1", "maxRetries": json.Number("2")},
		},
		"fw-no-payload": {Type: domain.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true},
	}))

	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-payload", Type: domain.FlagTypeBoolean, DefaultValue: false, Context: ec, IncludePayload: true,
	})
	want := `{"maxRetries":2,"rolloutId":"rollout_1"}`
	if got, _ := d.Metadata[domain.MetaPayload].(string); got != want {
		t.Fatalf("payload metadata = %q, want %q", got, want)
	}

	d = a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-payload", Type: domain.FlagTypeBoolean, DefaultValue: false, Context: ec, IncludePayload: false,
	})
	if _, ok := d.Metadata[domain.MetaPayload]; ok {
		t.Fatalf("payload metadata must be absent when IncludePayload is false, got %+v", d.Metadata)
	}

	d = a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-no-payload", Type: domain.FlagTypeBoolean, DefaultValue: false, Context: ec, IncludePayload: true,
	})
	if _, ok := d.Metadata[domain.MetaPayload]; ok {
		t.Fatalf("payload metadata must be absent when the flag has no payload, got %+v", d.Metadata)
	}
}

// TestIncludePayloadPassesThroughRawStringVerbatim is the regression test
// for the task-10b review-round finding: a payload that already arrives as
// a raw JSON string (spec/remote-evaluate.schema.json's payload field is
// unconstrained jsonValue; node's ports.ts documents this shape explicitly:
// "object or pre-serialized JSON string") must be exposed VERBATIM, not
// re-serialized — convertValue's original json.Marshal-always approach
// would double-encode it ("\"already {\\\"json\\\": true}\"" instead of the
// original string), a divergence from node (runtime.ts) and python
// (runtime.py), which both special-case this with the same ternary.
func TestIncludePayloadPassesThroughRawStringVerbatim(t *testing.T) {
	ec := domain.NewEvaluationContext("u", nil)
	const raw = `{"already": "serialized", "b": 1}`
	a := New(WithFlags(map[string]Flag{
		"fw-string-payload": {Type: domain.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true, Payload: raw},
	}))

	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-string-payload", Type: domain.FlagTypeBoolean, DefaultValue: false, Context: ec, IncludePayload: true,
	})
	if got, _ := d.Metadata[domain.MetaPayload].(string); got != raw {
		t.Fatalf("payload metadata = %q, want verbatim %q (must not be re-serialized/double-encoded)", got, raw)
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
