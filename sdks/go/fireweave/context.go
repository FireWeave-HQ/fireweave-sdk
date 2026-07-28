package fireweave

import (
	"encoding/json"
	"strings"
)

// Reserved attribute keys. "targetingKey" and "kind" are reserved by the
// OpenFeature context model; every key under the "fireweave." prefix is
// reserved for SDK-internal use, with exactly two ratified carve-outs
// (orchestrator rulings 12–14): AttrGroups and AttrGroupProperties are the
// canonical context keys for group targeting and are the ONLY permitted
// "fireweave.*" attributes. Every other "fireweave.*" key is rejected with
// InvalidContext.
const (
	ReservedKeyPrefix = "fireweave."
	// AttrGroups is the canonical context key carrying group memberships
	// (map of group type → group key), e.g.
	// {"organization": "org_123"}. It maps to the vendor "groups" payload
	// field and is never treated as a person property.
	AttrGroups = "fireweave.groups"
	// AttrGroupProperties is the canonical context key carrying per-group
	// properties (map of group type → property map), e.g.
	// {"organization": {"plan": "enterprise"}}. It maps to the vendor
	// "group_properties" payload field and is never treated as a person
	// property.
	AttrGroupProperties = "fireweave.groupProperties"
	// ReservedInvalidContextKey is an internal sentinel attribute injected by
	// the provider's context-guard hook when reserved-key misuse is detected
	// before the Go OpenFeature SDK flattens (and thereby destroys evidence
	// of) the conflict. Its presence always fails validation.
	ReservedInvalidContextKey = "fireweave.invalidContext"

	attrTargetingKey = "targetingKey"
	attrKind         = "kind"
)

// EvaluationContext is Fireweave's structured evaluation context. The
// TargetingKey maps to the vendor distinct_id / cohort id. Attributes may
// nest maps and lists up to the configured depth bound. Contexts are treated
// as immutable: constructors and accessors deep-copy.
type EvaluationContext struct {
	TargetingKey string
	Attributes   map[string]any
}

// NewEvaluationContext builds a context, deep-copying attributes.
func NewEvaluationContext(targetingKey string, attributes map[string]any) EvaluationContext {
	return EvaluationContext{
		TargetingKey: targetingKey,
		Attributes:   deepCopyMap(attributes),
	}
}

// Copy returns a deep copy of the context.
func (c EvaluationContext) Copy() EvaluationContext {
	return EvaluationContext{TargetingKey: c.TargetingKey, Attributes: deepCopyMap(c.Attributes)}
}

// WithGroups returns a copy of the context with the canonical AttrGroups
// ("fireweave.groups") attribute set. This is the idiomatic typed accessor
// ratified by ruling 14: it is sugar over the canonical context key, not a
// separate representation.
func (c EvaluationContext) WithGroups(groups map[string]any) EvaluationContext {
	out := c.Copy()
	if out.Attributes == nil {
		out.Attributes = map[string]any{}
	}
	out.Attributes[AttrGroups] = deepCopyMap(groups)
	return out
}

// WithGroupProperties returns a copy of the context with the canonical
// AttrGroupProperties ("fireweave.groupProperties") attribute set (typed
// sugar per ruling 14; see WithGroups).
func (c EvaluationContext) WithGroupProperties(props map[string]any) EvaluationContext {
	out := c.Copy()
	if out.Attributes == nil {
		out.Attributes = map[string]any{}
	}
	out.Attributes[AttrGroupProperties] = deepCopyMap(props)
	return out
}

// Groups returns a copy of the canonical AttrGroups attribute (nil when
// unset or not a map).
func (c EvaluationContext) Groups() map[string]any {
	g, _ := c.Attributes[AttrGroups].(map[string]any)
	return deepCopyMap(g)
}

// GroupProperties returns a copy of the canonical AttrGroupProperties
// attribute (nil when unset or not a map).
func (c EvaluationContext) GroupProperties() map[string]any {
	g, _ := c.Attributes[AttrGroupProperties].(map[string]any)
	return deepCopyMap(g)
}

func deepCopyMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = deepCopyValue(v)
	}
	return out
}

func deepCopyValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return deepCopyMap(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = deepCopyValue(e)
		}
		return out
	default:
		return v
	}
}

// MergeContexts merges layers in ascending priority order (earlier layers
// are overridden by later layers, per the OpenFeature merge order
// global → transaction → client → invocation). The targeting key of the
// highest-priority layer that sets one wins. The result is a fresh copy.
func MergeContexts(layers ...EvaluationContext) EvaluationContext {
	out := EvaluationContext{Attributes: map[string]any{}}
	for _, l := range layers {
		if l.TargetingKey != "" {
			out.TargetingKey = l.TargetingKey
		}
		for k, v := range l.Attributes {
			out.Attributes[k] = deepCopyValue(v)
		}
	}
	return out
}

// Limits are the ratified evaluation-context bounds
// (spec/evaluation-context.schema.json).
type Limits struct {
	MaxAttributes      int // maximum top-level attribute count
	MaxKeyBytes        int // maximum attribute key size in bytes
	MaxValueBytes      int // maximum single attribute value size in bytes
	MaxNestingDepth    int // maximum nesting depth of an attribute value
	MaxSerializedBytes int // maximum serialized (JSON) context size in bytes
}

// DefaultLimits returns the canonical bounds: 128 attributes, 256 B keys,
// 4 KiB values, depth 6, 64 KiB serialized.
func DefaultLimits() Limits {
	return Limits{
		MaxAttributes:      128,
		MaxKeyBytes:        256,
		MaxValueBytes:      4096,
		MaxNestingDepth:    6,
		MaxSerializedBytes: 65536,
	}
}

func (l Limits) withDefaults() Limits {
	d := DefaultLimits()
	if l.MaxAttributes <= 0 {
		l.MaxAttributes = d.MaxAttributes
	}
	if l.MaxKeyBytes <= 0 {
		l.MaxKeyBytes = d.MaxKeyBytes
	}
	if l.MaxValueBytes <= 0 {
		l.MaxValueBytes = d.MaxValueBytes
	}
	if l.MaxNestingDepth <= 0 {
		l.MaxNestingDepth = d.MaxNestingDepth
	}
	if l.MaxSerializedBytes <= 0 {
		l.MaxSerializedBytes = d.MaxSerializedBytes
	}
	return l
}

// Canonical validation messages (fixed strings; never interpolate user data).
const (
	msgTargetingKeyMissing = "targeting key missing"
	msgInvalidContext      = "invalid evaluation context"
	msgTooManyAttributes   = "context exceeds maximum attribute count"
	msgKeyTooLarge         = "context key exceeds maximum size"
	msgValueTooLarge       = "context value exceeds maximum size"
	msgTooDeep             = "context exceeds maximum nesting depth"
	msgSerializedTooLarge  = "serialized context exceeds maximum size"
)

// ValidateContext checks a merged context against the bounds and reserved
// key rules. It returns nil when valid, otherwise an InvalidContext error
// whose message never contains attribute values (no PII leakage).
func ValidateContext(c EvaluationContext, limits Limits, requireTargetingKey bool) *Error {
	limits = limits.withDefaults()

	if requireTargetingKey && c.TargetingKey == "" {
		err := NewError(KindInvalidContext, msgTargetingKeyMissing, nil)
		err.TargetingKeyMissing = true
		return err
	}
	for k, v := range c.Attributes {
		if k == attrTargetingKey || k == attrKind {
			return NewError(KindInvalidContext, msgInvalidContext, nil)
		}
		if strings.HasPrefix(k, ReservedKeyPrefix) {
			// Ratified carve-out (rulings 12–14): fireweave.groups and
			// fireweave.groupProperties are the only permitted fireweave.*
			// keys, and both must carry map values.
			if k != AttrGroups && k != AttrGroupProperties {
				return NewError(KindInvalidContext, msgInvalidContext, nil)
			}
			if _, ok := v.(map[string]any); !ok {
				return NewError(KindInvalidContext, msgInvalidContext, nil)
			}
		}
	}
	if len(c.Attributes) > limits.MaxAttributes {
		return NewError(KindInvalidContext, msgTooManyAttributes, nil)
	}
	for k, v := range c.Attributes {
		if len(k) > limits.MaxKeyBytes {
			return NewError(KindInvalidContext, msgKeyTooLarge, nil)
		}
		if valueSize(v) > limits.MaxValueBytes {
			return NewError(KindInvalidContext, msgValueTooLarge, nil)
		}
		if depthOf(v) > limits.MaxNestingDepth {
			return NewError(KindInvalidContext, msgTooDeep, nil)
		}
	}
	if serializedSize(c) > limits.MaxSerializedBytes {
		return NewError(KindInvalidContext, msgSerializedTooLarge, nil)
	}
	return nil
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
// enclosing map or list adds one level.
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
