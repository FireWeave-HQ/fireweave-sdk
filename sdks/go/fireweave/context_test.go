package fireweave

import (
	"fmt"
	"strings"
	"testing"
)

func TestMergeOrderLaterLayersWin(t *testing.T) {
	global := NewEvaluationContext("org_1", map[string]any{"tier": "bronze", "region": "us"})
	client := NewEvaluationContext("", map[string]any{"tier": "silver"})
	invocation := NewEvaluationContext("", map[string]any{"tier": "gold"})

	merged := MergeContexts(global, client, invocation)
	if merged.TargetingKey != "org_1" {
		t.Errorf("targetingKey = %q, want org_1", merged.TargetingKey)
	}
	if merged.Attributes["tier"] != "gold" {
		t.Errorf("tier = %v, want gold (invocation wins)", merged.Attributes["tier"])
	}
	if merged.Attributes["region"] != "us" {
		t.Errorf("region = %v, want us (global preserved)", merged.Attributes["region"])
	}
}

func TestContextImmutabilityViaCopy(t *testing.T) {
	src := map[string]any{"nested": map[string]any{"a": 1}}
	c := NewEvaluationContext("k", src)
	c.Attributes["nested"].(map[string]any)["a"] = 99
	if src["nested"].(map[string]any)["a"] != 1 {
		t.Error("constructor must deep-copy: mutation leaked to source map")
	}

	cp := c.Copy()
	cp.Attributes["nested"].(map[string]any)["a"] = 7
	if c.Attributes["nested"].(map[string]any)["a"] != 99 {
		t.Error("Copy must deep-copy nested maps")
	}
}

func TestValidateBounds(t *testing.T) {
	limits := DefaultLimits()

	t.Run("attribute count", func(t *testing.T) {
		attrs := map[string]any{}
		for i := 0; i < 129; i++ {
			attrs[fmt.Sprintf("a%03d", i)] = i
		}
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context exceeds maximum attribute count" {
			t.Errorf("got %v, want attribute-count violation", err)
		}
	})

	t.Run("key size", func(t *testing.T) {
		attrs := map[string]any{strings.Repeat("K", 257): "x"}
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context key exceeds maximum size" {
			t.Errorf("got %v, want key-size violation", err)
		}
	})

	t.Run("value size", func(t *testing.T) {
		attrs := map[string]any{"blob": strings.Repeat("B", 4097)}
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context value exceeds maximum size" {
			t.Errorf("got %v, want value-size violation", err)
		}
	})

	t.Run("nesting depth", func(t *testing.T) {
		deep := any(true)
		for i := 0; i < 8; i++ {
			deep = map[string]any{"d": deep}
		}
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: map[string]any{"deep": deep}}, limits, false)
		if err == nil || err.Message != "context exceeds maximum nesting depth" {
			t.Errorf("got %v, want depth violation", err)
		}
	})

	t.Run("serialized size", func(t *testing.T) {
		attrs := map[string]any{}
		for i := 0; i < 20; i++ {
			attrs["p"+string(rune('a'+i))] = strings.Repeat("X", 4000)
		}
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "serialized context exceeds maximum size" {
			t.Errorf("got %v, want serialized-size violation", err)
		}
	})

	t.Run("depth six allowed", func(t *testing.T) {
		v := any(true)
		for i := 0; i < 5; i++ {
			v = map[string]any{"d": v}
		}
		if err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: map[string]any{"v": v}}, limits, false); err != nil {
			t.Errorf("depth 6 should be allowed, got %v", err)
		}
	})
}

func TestValidateReservedKeys(t *testing.T) {
	cases := []map[string]any{
		{"targetingKey": "dup"},
		{"kind": "user"},
		{"fireweave.anything": 1},
		{ReservedInvalidContextKey: true},
	}
	for _, attrs := range cases {
		err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, DefaultLimits(), false)
		if err == nil || err.Kind != KindInvalidContext {
			t.Errorf("attrs %v: got %v, want InvalidContext", attrs, err)
		}
	}
}

func TestValidateTargetingKeyRequired(t *testing.T) {
	err := ValidateContext(EvaluationContext{Attributes: map[string]any{"plan": "pro"}}, DefaultLimits(), true)
	if err == nil || !err.TargetingKeyMissing {
		t.Fatalf("got %v, want TargetingKeyMissing error", err)
	}
	if err.Message != "targeting key missing" {
		t.Errorf("message = %q", err.Message)
	}
	if e := ValidateContext(EvaluationContext{Attributes: map[string]any{"plan": "pro"}}, DefaultLimits(), false); e != nil {
		t.Errorf("not required: got %v, want nil", e)
	}
}
