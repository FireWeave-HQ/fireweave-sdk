package domain

import (
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

func TestGroupsTypedSugarMapsToCanonicalKeys(t *testing.T) {
	base := NewEvaluationContext("user_1", map[string]any{"tier": "pro"})
	groups := map[string]any{"organization": "org_1"}
	props := map[string]any{"organization": map[string]any{"plan": "enterprise"}}

	c := base.WithGroups(groups).WithGroupProperties(props)

	// The sugar writes exactly the canonical keys.
	if got, ok := c.Attributes[AttrGroups].(map[string]any); !ok || got["organization"] != "org_1" {
		t.Fatalf("WithGroups must set %s, attrs = %v", AttrGroups, c.Attributes)
	}
	if _, ok := c.Attributes[AttrGroupProperties].(map[string]any); !ok {
		t.Fatalf("WithGroupProperties must set %s, attrs = %v", AttrGroupProperties, c.Attributes)
	}
	// Accessors read back the canonical keys.
	if g := c.Groups(); g["organization"] != "org_1" {
		t.Errorf("Groups() = %v", g)
	}
	if gp := c.GroupProperties(); gp["organization"] == nil {
		t.Errorf("GroupProperties() = %v", gp)
	}
	// Sugar output validates and originals are not aliased.
	if _, err := ValidateContext(c, DefaultLimits(), false); err != nil {
		t.Fatalf("sugar-built context must validate, got %v", err)
	}
	groups["organization"] = "mutated"
	if g := c.Groups(); g["organization"] != "org_1" {
		t.Error("WithGroups must deep-copy its input")
	}
	if base.Attributes[AttrGroups] != nil {
		t.Error("WithGroups must not mutate the receiver")
	}
}

// --- cycle safety (identity set with backtracking; maps AND slices) ---

func TestSelfReferentialMapDoesNotCrashConstruction(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	ctx := NewEvaluationContext("u", map[string]any{"plan": "pro", "loop": cyclic})

	if ctx.Attributes["plan"] != "pro" {
		t.Fatalf("sibling data must survive untouched, got %v", ctx.Attributes["plan"])
	}
	loop, ok := ctx.Attributes["loop"].(map[string]any)
	if !ok {
		t.Fatalf("loop attribute should still be a map, got %T", ctx.Attributes["loop"])
	}
	if loop["self"] != nil {
		t.Errorf("cyclic branch should be replaced with nil, got %v", loop["self"])
	}
	if !ctx.HadCyclicInput() {
		t.Error("HadCyclicInput() should report true")
	}
}

func TestSelfReferentialSliceDoesNotCrashConstruction(t *testing.T) {
	cyclic := make([]any, 1)
	cyclic[0] = cyclic
	ctx := NewEvaluationContext("u", map[string]any{"loop": cyclic})

	loop, ok := ctx.Attributes["loop"].([]any)
	if !ok || len(loop) != 1 {
		t.Fatalf("loop attribute should be a 1-element slice, got %#v", ctx.Attributes["loop"])
	}
	if loop[0] != nil {
		t.Errorf("cyclic branch should be replaced with nil, got %v", loop[0])
	}
	if !ctx.HadCyclicInput() {
		t.Error("HadCyclicInput() should report true")
	}
}

func TestSharedNonCyclicReferenceIsNotTreatedAsACycle(t *testing.T) {
	shared := map[string]any{"x": 1}
	ctx := NewEvaluationContext("u", map[string]any{"a": shared, "b": shared})

	a, _ := ctx.Attributes["a"].(map[string]any)
	b, _ := ctx.Attributes["b"].(map[string]any)
	if a["x"] != float64(1) && a["x"] != 1 {
		t.Errorf("a.x = %v", a["x"])
	}
	if b["x"] != float64(1) && b["x"] != 1 {
		t.Errorf("b.x = %v", b["x"])
	}
	// No false positive: two siblings referencing the same object is legal
	// sharing, not a cycle — the identity-tracked seen-set backtracks after
	// each subtree completes, so a shared reference visited a second time
	// (not on the active recursion path) is copied correctly rather than
	// flagged.
	if ctx.HadCyclicInput() {
		t.Error("shared-but-acyclic reference must not be flagged as cyclic")
	}
	if _, err := ValidateContext(ctx, DefaultLimits(), false); err != nil {
		t.Fatalf("shared-but-acyclic context must validate, got %v", err)
	}
}

func TestCyclicContextFailsClosedViaValidateContext(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	ctx := NewEvaluationContext("u", map[string]any{"loop": cyclic})

	_, err := ValidateContext(ctx, DefaultLimits(), false)
	if err == nil {
		t.Fatal("expected a validation error")
	}
	if err.Kind != KindInvalidContext {
		t.Errorf("kind = %s, want InvalidContext", err.Kind)
	}
	if !strings.Contains(err.Message, "circular reference") {
		t.Errorf("message = %q, want it to mention a circular reference", err.Message)
	}
}

func TestCyclicContextFailsClosedThroughMerge(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	invocation := NewEvaluationContext("u", map[string]any{"loop": cyclic})
	merged := MergeContexts(NewEvaluationContext("u", map[string]any{"tier": "gold"}), EvaluationContext{}, invocation)

	if !merged.HadCyclicInput() {
		t.Fatal("merge must propagate a layer's cyclic flag")
	}
	_, err := ValidateContext(merged, DefaultLimits(), false)
	if err == nil || err.Kind != KindInvalidContext {
		t.Fatalf("got %v, want InvalidContext", err)
	}
}

func TestCycleCheckRunsBeforeAnyOtherContextRule(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	ctx := NewEvaluationContext("u", map[string]any{"loop": cyclic, "fireweave.notAllowed": "x"})

	_, err := ValidateContext(ctx, DefaultLimits(), false)
	if err == nil || !strings.Contains(err.Message, "circular reference") {
		t.Fatalf("got %v, want the circular-reference message to win over the reserved-key violation", err)
	}
}
