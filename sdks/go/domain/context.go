package domain

import "reflect"

// Reserved attribute keys. "targetingKey" and "kind" are reserved by the
// evaluation-context model; every key under the "fireweave." prefix is
// reserved for SDK-internal use, with exactly two carve-outs: AttrGroups and
// AttrGroupProperties are the canonical context keys for group targeting and
// are the ONLY permitted "fireweave.*" attributes. Every other "fireweave.*"
// key is rejected with InvalidContext.
const (
	ReservedKeyPrefix = "fireweave."
	// AttrGroups is the canonical context key carrying group memberships
	// (map of group type -> group key), e.g. {"organization": "org_123"}.
	AttrGroups = "fireweave.groups"
	// AttrGroupProperties is the canonical context key carrying per-group
	// properties (map of group type -> property map), e.g.
	// {"organization": {"plan": "enterprise"}}.
	AttrGroupProperties = "fireweave.groupProperties"

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

	// hadCyclicInput is true when constructing this context (or a layer
	// merged into it) broke a reference cycle in a caller-supplied
	// Attributes value. Construction itself never crashes or recurses
	// forever on a cyclic input (a cycle is detected via pointer identity
	// and the cyclic branch is replaced with nil instead of being recursed
	// into — see deepCopyValueDetect) — but "did not crash" is a different
	// claim from "is valid". ValidateContext reads this flag FIRST, before
	// any other rule, and fails closed as InvalidContext
	// (spec/control-points.md "Validation, before any I/O"), matching
	// node's WeakSet-based cycle detection in validateContext and java's
	// EvaluationContext.hadCyclicInput().
	hadCyclicInput bool
}

// HadCyclicInput reports whether this context (or a layer merged into it)
// contained a reference cycle that was broken during construction.
func (c EvaluationContext) HadCyclicInput() bool { return c.hadCyclicInput }

// NewEvaluationContext builds a context, deep-copying attributes. A cyclic
// attribute value does not panic or hang: the cyclic branch is replaced with
// nil and HadCyclicInput() reports true.
func NewEvaluationContext(targetingKey string, attributes map[string]any) EvaluationContext {
	out, cyclic := deepCopyMapDetect(attributes, map[uintptr]bool{})
	return EvaluationContext{TargetingKey: targetingKey, Attributes: out, hadCyclicInput: cyclic}
}

// Copy returns a deep copy of the context.
func (c EvaluationContext) Copy() EvaluationContext {
	out, cyclic := deepCopyMapDetect(c.Attributes, map[uintptr]bool{})
	return EvaluationContext{TargetingKey: c.TargetingKey, Attributes: out, hadCyclicInput: c.hadCyclicInput || cyclic}
}

// WithGroups returns a copy of the context with the canonical AttrGroups
// ("fireweave.groups") attribute set. This is the idiomatic typed accessor:
// sugar over the canonical context key, not a separate representation.
func (c EvaluationContext) WithGroups(groups map[string]any) EvaluationContext {
	out := c.Copy()
	if out.Attributes == nil {
		out.Attributes = map[string]any{}
	}
	copied, cyclic := deepCopyMapDetect(groups, map[uintptr]bool{})
	out.Attributes[AttrGroups] = copied
	out.hadCyclicInput = out.hadCyclicInput || cyclic
	return out
}

// WithGroupProperties returns a copy of the context with the canonical
// AttrGroupProperties ("fireweave.groupProperties") attribute set (typed
// sugar; see WithGroups).
func (c EvaluationContext) WithGroupProperties(props map[string]any) EvaluationContext {
	out := c.Copy()
	if out.Attributes == nil {
		out.Attributes = map[string]any{}
	}
	copied, cyclic := deepCopyMapDetect(props, map[uintptr]bool{})
	out.Attributes[AttrGroupProperties] = copied
	out.hadCyclicInput = out.hadCyclicInput || cyclic
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

// deepCopyMap is the cycle-safe convenience wrapper used by call sites that
// do not need to report whether a cycle was found (they only need to not
// crash on one).
func deepCopyMap(m map[string]any) map[string]any {
	out, _ := deepCopyMapDetect(m, map[uintptr]bool{})
	return out
}

// deepCopyMapDetect performs a defensive deep copy of m, breaking any
// reference cycle it finds by identity rather than recursing into it.
//
// Cycle detection is by pointer identity (reflect.Value.Pointer() of the
// map/slice header), tracked in `seen` with backtracking: a container's
// pointer is added before recursing into its entries and removed again
// (via defer) once that subtree finishes, so a value legitimately SHARED by
// two sibling branches — not on the active recursion path — is copied
// correctly rather than flagged as cyclic. Only a genuine cycle (a
// container reachable from itself) reports true.
func deepCopyMapDetect(m map[string]any, seen map[uintptr]bool) (map[string]any, bool) {
	if m == nil {
		return nil, false
	}
	ptr := reflect.ValueOf(m).Pointer()
	if ptr != 0 {
		if seen[ptr] {
			return nil, true
		}
		seen[ptr] = true
		defer delete(seen, ptr)
	}
	out := make(map[string]any, len(m))
	cyclic := false
	for k, v := range m {
		copied, hit := deepCopyValueDetect(v, seen)
		if hit {
			cyclic = true
		}
		out[k] = copied
	}
	return out, cyclic
}

// deepCopyValueDetect is deepCopyMapDetect's sibling for a single attribute
// value: maps recurse via deepCopyMapDetect, slices ([]any) get the same
// identity-tracked treatment, everything else (scalars, nil) passes through
// unchanged.
func deepCopyValueDetect(v any, seen map[uintptr]bool) (any, bool) {
	switch t := v.(type) {
	case map[string]any:
		out, cyclic := deepCopyMapDetect(t, seen)
		if out == nil {
			// A bare `return deepCopyMapDetect(t, seen)` here would convert a
			// nil map[string]any into a non-nil `any` holding a typed nil —
			// the classic Go footgun (an interface is nil only when BOTH its
			// type and value are nil). Returning the untyped nil literal
			// directly keeps a cycle-broken branch genuinely nil to callers
			// comparing it with `== nil`.
			return nil, cyclic
		}
		return out, cyclic
	case []any:
		ptr := reflect.ValueOf(t).Pointer()
		if ptr != 0 {
			if seen[ptr] {
				return nil, true
			}
			seen[ptr] = true
			defer delete(seen, ptr)
		}
		out := make([]any, len(t))
		cyclic := false
		for i, e := range t {
			copied, hit := deepCopyValueDetect(e, seen)
			if hit {
				cyclic = true
			}
			out[i] = copied
		}
		return out, cyclic
	default:
		return v, false
	}
}

// MergeContexts merges layers in ascending priority order (earlier layers
// are overridden by later layers, merge order global -> client ->
// invocation). The targeting key of the highest-priority layer that sets
// one wins. The result is a fresh, cycle-safe copy; hadCyclicInput is the
// logical OR of every layer's own flag (a layer's cycle was already broken
// to nil by ITS OWN construction — see EvaluationContext doc — so the flag,
// not the data, is what survives into the merged result).
func MergeContexts(layers ...EvaluationContext) EvaluationContext {
	out := EvaluationContext{Attributes: map[string]any{}}
	for _, l := range layers {
		if l.TargetingKey != "" {
			out.TargetingKey = l.TargetingKey
		}
		copied, cyclic := deepCopyMapDetect(l.Attributes, map[uintptr]bool{})
		for k, v := range copied {
			out.Attributes[k] = v
		}
		out.hadCyclicInput = out.hadCyclicInput || l.hadCyclicInput || cyclic
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
