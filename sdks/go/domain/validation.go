// Validation — pure, total functions per spec/control-points.md "Validation,
// before any I/O" and spec/modes.md "Initialisation validation".
//
// Every read-path validator here (ValidateControlPointKey, ValidateDefaultValue,
// ValidateContext, ValidateTargetingKey) returns the go-idiomatic port of the
// node/java Validated<T> pattern: (T, *Error) — a plain multi-return, not a
// wrapper struct (the plan's own words: the pattern "ports to Go's (T,
// error)"). application.Runtime.Evaluate runs them, in the fixed order the
// spec names — key, default-vs-type, context, lifecycle — and degrades to
// the caller's default on the first failure; it NEVER panics or returns an
// error from a read (spec/control-points.md "Return discipline — never
// throw into a read path").
//
// ValidateInitOptions is the one named exception (spec/modes.md
// "Initialisation validation"): its failure is converted to a returned
// `error` by application.Init, which is Go's "throw" for initialisation.
package domain

import (
	"encoding/json"
	"strings"
)

// ---------------------------------------------------------------------------
// Rule 1 — ValidateControlPointKey (spec/control-points.md "Validation,
// before any I/O": "key — non-empty, <=256 characters, no control characters")
// ---------------------------------------------------------------------------

const maxControlPointKeyLength = 256

func hasControlCharacter(s string) bool {
	for _, r := range s {
		if (r >= 0x00 && r <= 0x1f) || (r >= 0x7f && r <= 0x9f) {
			return true
		}
	}
	return false
}

// ValidateControlPointKey checks key — non-empty, <=256 characters, no
// control characters (spec/control-points.md rule 1, the first check in the
// fixed order).
//
// No taxonomy kind names "malformed key" explicitly (the return-discipline
// table's closest row is "key unknown to the backend" -> FlagNotFound): a
// key that can never identify a flag is treated the same as one the backend
// doesn't recognise, so this maps to FlagNotFound too — the node reference
// implementation's ruled mapping, carried forward unchanged so every
// language SDK copying node as the reference agrees.
func ValidateControlPointKey(key string) (string, *Error) {
	if key == "" {
		return "", NewError(KindFlagNotFound, "control point key must be a non-empty string", nil)
	}
	if len(key) > maxControlPointKeyLength {
		return "", NewError(KindFlagNotFound, "control point key exceeds maximum length", nil)
	}
	if hasControlCharacter(key) {
		return "", NewError(KindFlagNotFound, "control point key contains control characters", nil)
	}
	return key, nil
}

// ---------------------------------------------------------------------------
// Rule 2 — ValidateDefaultValue (spec/control-points.md rule 2: "default vs
// type — getBooleanValue with a non-boolean default is TypeMismatch")
// ---------------------------------------------------------------------------

// MatchesExpectedType reports whether value matches the shape expected
// names. Shared by ValidateDefaultValue (the caller's default, before any
// I/O) and any adapter that chooses to run the same check on a resolved
// value. Number accepts any Go numeric boxing (int/int32/int64/float32/
// float64) — Decision.Value is jsonValue, and a Go caller passing an
// untyped int constant through the general Evaluate(...) form should not
// trip TypeMismatch over which numeric Go type it happened to box as.
// Object accepts both a JSON object (map[string]any) and a JSON array
// ([]any) — an array is still "an object, not a boolean/string/number" in
// the sense getObjectValue cares about. nil never matches any type (a null
// default is not a value of any declared type).
func MatchesExpectedType(value any, expected FlagType) bool {
	if value == nil {
		return false
	}
	switch expected {
	case FlagTypeBoolean:
		_, ok := value.(bool)
		return ok
	case FlagTypeString:
		_, ok := value.(string)
		return ok
	case FlagTypeNumber:
		switch value.(type) {
		case int, int32, int64, float32, float64:
			return true
		default:
			return false
		}
	case FlagTypeObject:
		switch value.(type) {
		case map[string]any, []any:
			return true
		default:
			return false
		}
	default:
		return false
	}
}

// ValidateDefaultValue checks default vs type — e.g. getBooleanValue with a
// non-boolean default is TypeMismatch (spec/control-points.md rule 2,
// checked before any I/O).
func ValidateDefaultValue(expectedType FlagType, defaultValue any) (any, *Error) {
	if !MatchesExpectedType(defaultValue, expectedType) {
		return nil, NewError(KindTypeMismatch, "", nil)
	}
	return defaultValue, nil
}

// ---------------------------------------------------------------------------
// ValidateTargetingKey (spec/control-points.md "Context": targetingKey)
// ---------------------------------------------------------------------------

// ValidateTargetingKey checks: "An SDK MUST NOT invent one: a missing
// targeting key is InvalidContext where the evaluation needs it, never a
// generated anonymous id" (spec/control-points.md "Context"). required is
// call-site policy — the remote adapter always requires one for
// evaluate/registerTarget (spec/remote-protocol.md "Two identity paths");
// the generic context pipeline (ValidateContext) only does when the caller
// opts in (Config.RequireTargetingKey).
func ValidateTargetingKey(targetingKey string, required bool) (string, *Error) {
	if required && targetingKey == "" {
		err := NewError(KindInvalidContext, "targeting key missing", nil)
		err.TargetingKeyMissing = true
		return "", err
	}
	return targetingKey, nil
}

// ---------------------------------------------------------------------------
// Rule 3 — ValidateContext (spec/control-points.md rule 3: "context — depth,
// key count, value size, reserved keys (evaluation-context.schema.json)")
// ---------------------------------------------------------------------------

// ValidateContext checks a merged context against the cyclic-input flag
// (checked FIRST, before any other rule — a cyclic context fails CLOSED as
// InvalidContext, matching node's WeakSet-based validateContext ordering
// and java's ratified fix), then the bounds and reserved-key rules. It
// returns the (unchanged) context when valid, otherwise an InvalidContext
// error whose message never contains attribute values (no PII leakage).
func ValidateContext(c EvaluationContext, limits Limits, requireTargetingKey bool) (EvaluationContext, *Error) {
	if c.hadCyclicInput {
		return EvaluationContext{}, NewError(KindInvalidContext, "context contains a circular reference", nil)
	}

	limits = limits.withDefaults()

	if requireTargetingKey && c.TargetingKey == "" {
		err := NewError(KindInvalidContext, "targeting key missing", nil)
		err.TargetingKeyMissing = true
		return EvaluationContext{}, err
	}
	for k, v := range c.Attributes {
		if k == attrTargetingKey || k == attrKind {
			return EvaluationContext{}, NewError(KindInvalidContext, "invalid evaluation context", nil)
		}
		if strings.HasPrefix(k, ReservedKeyPrefix) {
			// Carve-out: fireweave.groups and fireweave.groupProperties are
			// the only permitted fireweave.* keys, and both must carry map
			// values.
			if k != AttrGroups && k != AttrGroupProperties {
				return EvaluationContext{}, NewError(KindInvalidContext, "invalid evaluation context", nil)
			}
			if _, ok := v.(map[string]any); !ok {
				return EvaluationContext{}, NewError(KindInvalidContext, "invalid evaluation context", nil)
			}
		}
	}
	if len(c.Attributes) > limits.MaxAttributes {
		return EvaluationContext{}, NewError(KindInvalidContext, "context exceeds maximum attribute count", nil)
	}
	for k, v := range c.Attributes {
		if len(k) > limits.MaxKeyBytes {
			return EvaluationContext{}, NewError(KindInvalidContext, "context key exceeds maximum size", nil)
		}
		if valueSize(v) > limits.MaxValueBytes {
			return EvaluationContext{}, NewError(KindInvalidContext, "context value exceeds maximum size", nil)
		}
		if depthOf(v) > limits.MaxNestingDepth {
			return EvaluationContext{}, NewError(KindInvalidContext, "context exceeds maximum nesting depth", nil)
		}
	}
	if serializedSize(c) > limits.MaxSerializedBytes {
		return EvaluationContext{}, NewError(KindInvalidContext, "serialized context exceeds maximum size", nil)
	}
	return c, nil
}

func valueSize(v any) int {
	if s, ok := v.(string); ok {
		return len(s)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

// depthOf reports the nesting depth of a value: scalars are depth 1, each
// enclosing map or list adds one level. Safe on the outputs of
// deepCopyMapDetect/deepCopyValueDetect, which are guaranteed acyclic by
// construction (a detected cycle is replaced with nil, never recursed
// into), so no cycle guard is needed here.
func depthOf(v any) int {
	switch t := v.(type) {
	case map[string]any:
		max := 0
		for _, e := range t {
			if d := depthOf(e); d > max {
				max = d
			}
		}
		return 1 + max
	case []any:
		max := 0
		for _, e := range t {
			if d := depthOf(e); d > max {
				max = d
			}
		}
		return 1 + max
	default:
		return 1
	}
}

func serializedSize(c EvaluationContext) int {
	b, err := json.Marshal(map[string]any{
		"targetingKey": c.TargetingKey,
		"attributes":   c.Attributes,
	})
	if err != nil {
		return 0
	}
	return len(b)
}

// ---------------------------------------------------------------------------
// ValidateInitOptions (spec/modes.md "Initialisation validation")
// ---------------------------------------------------------------------------

func isBlank(s string) bool { return strings.TrimSpace(s) == "" }

// ValidateInitOptions checks the initialisation-validation table
// (spec/modes.md), the rows representable at this layer:
//   - mode absent or unrecognised — Mode is a plain string type in Go (not a
//     closed enum), so BOTH halves of this row are reachable and checked,
//     unlike java's closed Mode enum where "unrecognised" cannot occur.
//   - mode == ModeRemote with apiKey or apiURL missing/blank
//   - mode == ModeLocal with credentials supplied (a config half-migrated
//     from remote to local reads as neither, silently — reject it instead)
//
// The table's remaining row ("apiUrl fails the host allowlist") is
// intentionally NOT checked here — that runs downstream, when the remote
// adapter's own Initialize brings it up (mirrors node's validateInitOptions
// module doc: host-allowlist checking is infrastructure's job, which this
// pure domain-layer function must not depend on).
//
// There is no meaningful success value to report (mirrors java's
// Validated<Boolean> dummy TRUE), so this returns only *Error; nil means ok.
func ValidateInitOptions(mode Mode, apiKey, apiURL string) *Error {
	if mode != ModeLocal && mode != ModeRemote {
		return NewError(KindConfiguration, `mode is required and must be "local" or "remote"`, nil)
	}
	if mode == ModeRemote {
		if isBlank(apiKey) || isBlank(apiURL) {
			return NewError(KindConfiguration, `mode "remote" requires apiKey and apiUrl`, nil)
		}
		return nil
	}
	if !isBlank(apiKey) || !isBlank(apiURL) {
		return NewError(KindConfiguration,
			`mode "local" must not be combined with apiKey/apiUrl — the caller means one or the other`, nil)
	}
	return nil
}
