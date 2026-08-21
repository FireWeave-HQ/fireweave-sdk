package domain

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateControlPointKey(t *testing.T) {
	if _, err := ValidateControlPointKey(""); err == nil || err.Kind != KindFlagNotFound {
		t.Errorf("empty key: got %v, want FlagNotFound", err)
	}
	if _, err := ValidateControlPointKey(strings.Repeat("k", 257)); err == nil || err.Kind != KindFlagNotFound {
		t.Errorf("too long: got %v, want FlagNotFound", err)
	}
	if _, err := ValidateControlPointKey("bad\x00key"); err == nil || err.Kind != KindFlagNotFound {
		t.Errorf("control char: got %v, want FlagNotFound", err)
	}
	if v, err := ValidateControlPointKey("good-key"); err != nil || v != "good-key" {
		t.Errorf("valid key: got (%q, %v)", v, err)
	}
}

func TestValidateDefaultValue(t *testing.T) {
	cases := []struct {
		expected FlagType
		value    any
		wantOK   bool
	}{
		{FlagTypeBoolean, true, true},
		{FlagTypeBoolean, "nope", false},
		{FlagTypeString, "s", true},
		{FlagTypeString, 1, false},
		{FlagTypeNumber, 1.5, true},
		{FlagTypeNumber, 5, true},
		{FlagTypeNumber, "5", false},
		{FlagTypeObject, map[string]any{"a": 1}, true},
		{FlagTypeObject, []any{1, 2}, true},
		{FlagTypeObject, "not-an-object", false},
		{FlagTypeBoolean, nil, false},
	}
	for _, tc := range cases {
		_, err := ValidateDefaultValue(tc.expected, tc.value)
		gotOK := err == nil
		if gotOK != tc.wantOK {
			t.Errorf("ValidateDefaultValue(%s, %#v) ok=%v, want %v (err=%v)", tc.expected, tc.value, gotOK, tc.wantOK, err)
		}
		if !tc.wantOK && err.Kind != KindTypeMismatch {
			t.Errorf("expected TypeMismatch, got %s", err.Kind)
		}
	}
}

func TestValidateBounds(t *testing.T) {
	limits := DefaultLimits()

	t.Run("attribute count", func(t *testing.T) {
		attrs := map[string]any{}
		for i := 0; i < 129; i++ {
			attrs[fmt.Sprintf("a%03d", i)] = i
		}
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context exceeds maximum attribute count" {
			t.Errorf("got %v, want attribute-count violation", err)
		}
	})

	t.Run("key size", func(t *testing.T) {
		attrs := map[string]any{strings.Repeat("K", 257): "x"}
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context key exceeds maximum size" {
			t.Errorf("got %v, want key-size violation", err)
		}
	})

	t.Run("value size", func(t *testing.T) {
		attrs := map[string]any{"blob": strings.Repeat("B", 4097)}
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "context value exceeds maximum size" {
			t.Errorf("got %v, want value-size violation", err)
		}
	})

	t.Run("nesting depth", func(t *testing.T) {
		deep := any(true)
		for i := 0; i < 8; i++ {
			deep = map[string]any{"d": deep}
		}
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: map[string]any{"deep": deep}}, limits, false)
		if err == nil || err.Message != "context exceeds maximum nesting depth" {
			t.Errorf("got %v, want depth violation", err)
		}
	})

	t.Run("serialized size", func(t *testing.T) {
		attrs := map[string]any{}
		for i := 0; i < 20; i++ {
			attrs["p"+string(rune('a'+i))] = strings.Repeat("X", 4000)
		}
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, limits, false)
		if err == nil || err.Message != "serialized context exceeds maximum size" {
			t.Errorf("got %v, want serialized-size violation", err)
		}
	})

	t.Run("depth six allowed", func(t *testing.T) {
		v := any(true)
		for i := 0; i < 5; i++ {
			v = map[string]any{"d": v}
		}
		if _, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: map[string]any{"v": v}}, limits, false); err != nil {
			t.Errorf("depth 6 should be allowed, got %v", err)
		}
	})
}

func TestValidateReservedKeys(t *testing.T) {
	cases := []map[string]any{
		{"targetingKey": "dup"},
		{"kind": "user"},
		{"fireweave.anything": 1},
		{"fireweave.evaluationContexts": []any{"a"}},
		{AttrGroups: "not-a-map"},
		{AttrGroupProperties: []any{"x"}},
	}
	for _, attrs := range cases {
		_, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, DefaultLimits(), false)
		if err == nil || err.Kind != KindInvalidContext {
			t.Errorf("attrs %v: got %v, want InvalidContext", attrs, err)
		}
	}
}

func TestValidateFireweaveGroupsCarveOut(t *testing.T) {
	attrs := map[string]any{
		AttrGroups:          map[string]any{"organization": "org_1"},
		AttrGroupProperties: map[string]any{"organization": map[string]any{"plan": "enterprise"}},
		"email_domain":      "example.com",
	}
	if _, err := ValidateContext(EvaluationContext{TargetingKey: "k", Attributes: attrs}, DefaultLimits(), false); err != nil {
		t.Fatalf("canonical carve-out keys must validate, got %v", err)
	}
}

func TestValidateTargetingKeyRequired(t *testing.T) {
	_, err := ValidateContext(EvaluationContext{Attributes: map[string]any{"plan": "pro"}}, DefaultLimits(), true)
	if err == nil || !err.TargetingKeyMissing {
		t.Fatalf("got %v, want TargetingKeyMissing error", err)
	}
	if err.Message != "targeting key missing" {
		t.Errorf("message = %q", err.Message)
	}
	if _, e := ValidateContext(EvaluationContext{Attributes: map[string]any{"plan": "pro"}}, DefaultLimits(), false); e != nil {
		t.Errorf("not required: got %v, want nil", e)
	}
}

func TestValidateInitOptions(t *testing.T) {
	cases := []struct {
		name           string
		mode           Mode
		apiKey, apiURL string
		wantOK         bool
	}{
		{"mode absent", "", "", "", false},
		{"mode unrecognised", Mode("bogus"), "", "", false},
		{"remote missing apiKey", ModeRemote, "", "https://app-server.fireweave.ai", false},
		{"remote missing apiUrl", ModeRemote, "project-api-key_test", "", false},
		{"remote blank apiKey", ModeRemote, "   ", "https://app-server.fireweave.ai", false},
		{"remote ok", ModeRemote, "project-api-key_test", "https://app-server.fireweave.ai", true},
		{"local with apiKey", ModeLocal, "project-api-key_test", "", false},
		{"local with apiUrl", ModeLocal, "", "https://app-server.fireweave.ai", false},
		{"local with both", ModeLocal, "project-api-key_test", "https://app-server.fireweave.ai", false},
		{"local ok", ModeLocal, "", "", true},
		{"local blank not supplied", ModeLocal, "  ", "  ", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateInitOptions(tc.mode, tc.apiKey, tc.apiURL)
			gotOK := err == nil
			if gotOK != tc.wantOK {
				t.Errorf("got ok=%v (err=%v), want %v", gotOK, err, tc.wantOK)
			}
			if !tc.wantOK && err.Kind != KindConfiguration {
				t.Errorf("expected Configuration, got %s", err.Kind)
			}
		})
	}
}
