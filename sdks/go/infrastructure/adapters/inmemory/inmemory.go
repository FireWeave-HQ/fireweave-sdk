// Package inmemory provides a deterministic, fixture-driven BackendAdapter
// used by unit tests and the conformance harness. It performs no I/O and
// implements no target registration (RegisterTarget degrades with
// UnsupportedCapability via Runtime's optional-interface discovery,
// mirroring node's InMemoryAdapter).
package inmemory

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"sync/atomic"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
)

// Flag is one deterministic flag definition, mirroring the shape used by
// contracts/ fixtures (given.flags).
type Flag struct {
	Type    domain.FlagType
	Enabled bool
	Variant string
	Value   any

	// Vendor-style reason/metadata fields.
	ReasonCode     string
	ConditionIndex *int
	Version        *int64
	VendorID       *int64

	// OverrideReason forces the normalized reason (e.g. SPLIT).
	OverrideReason domain.Reason
	// FromCache marks the flag as served from a stale definitions cache;
	// resolutions carry reason STALE and fireweave.fromCache metadata.
	FromCache bool

	// Optional deterministic match conditions. All configured conditions
	// must hold; a non-matching flag resolves to the caller default with
	// reason DEFAULT.
	MatchTargetingKey string
	MatchAttributes   map[string]any
	MatchGroups       map[string]any
	MatchPerson       map[string]any
}

// Adapter is a deterministic in-memory BackendAdapter. Safe for concurrent
// use.
type Adapter struct {
	mu      sync.RWMutex
	flags   map[string]Flag
	initErr error

	resolveCount atomic.Int64
	lastCtx      atomic.Pointer[domain.EvaluationContext]
}

// Option configures the adapter.
type Option func(*Adapter)

// WithFlags seeds the flag table.
func WithFlags(flags map[string]Flag) Option {
	return func(a *Adapter) {
		for k, f := range flags {
			a.flags[k] = f
		}
	}
}

// WithInitError makes Initialize fail with the given error.
func WithInitError(err error) Option {
	return func(a *Adapter) { a.initErr = err }
}

// New builds an adapter.
func New(opts ...Option) *Adapter {
	a := &Adapter{flags: map[string]Flag{}}
	for _, o := range opts {
		o(a)
	}
	return a
}

// SetFlags replaces the flag table (used by provider-replacement tests).
func (a *Adapter) SetFlags(flags map[string]Flag) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.flags = map[string]Flag{}
	for k, f := range flags {
		a.flags[k] = f
	}
}

// Initialize implements domain.BackendAdapter.
func (a *Adapter) Initialize(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return domain.NewError(domain.KindTimeout, "", err)
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.initErr
}

// Close implements domain.BackendAdapter; it is a no-op.
func (a *Adapter) Close(ctx context.Context) error { return nil }

// ResolveCount reports how many Resolve calls reached the adapter.
func (a *Adapter) ResolveCount() int64 { return a.resolveCount.Load() }

// LastContext returns a copy of the most recently resolved context.
func (a *Adapter) LastContext() (domain.EvaluationContext, bool) {
	p := a.lastCtx.Load()
	if p == nil {
		return domain.EvaluationContext{}, false
	}
	return p.Copy(), true
}

// Resolve implements domain.BackendAdapter deterministically from the
// flag table.
func (a *Adapter) Resolve(ctx context.Context, req domain.ResolveRequest) domain.Decision {
	a.resolveCount.Add(1)
	cp := req.Context.Copy()
	a.lastCtx.Store(&cp)

	a.mu.RLock()
	flag, ok := a.flags[req.FlagKey]
	a.mu.RUnlock()

	if !ok {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindFlagNotFound, "", nil), nil)
	}
	if flag.Type != req.Type {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindTypeMismatch, "", nil), nil)
	}
	if !matches(flag, req.Context) {
		return domain.Decision{FlagKey: req.FlagKey, Value: req.DefaultValue, Reason: domain.ReasonDefault, Metadata: buildMetadata(flag)}
	}

	meta := buildMetadata(flag)
	if !flag.Enabled {
		return domain.Decision{
			FlagKey:  req.FlagKey,
			Value:    convertValue(flag),
			Variant:  flag.Variant,
			Reason:   domain.ReasonDisabled,
			Metadata: meta,
		}
	}

	reason := domain.ReasonTargetingMatch
	if flag.OverrideReason != "" {
		reason = flag.OverrideReason
	}
	if flag.FromCache {
		reason = domain.ReasonStale
	}
	return domain.Decision{
		FlagKey:  req.FlagKey,
		Value:    convertValue(flag),
		Variant:  flag.Variant,
		Reason:   reason,
		Metadata: meta,
	}
}

func matches(flag Flag, ctx domain.EvaluationContext) bool {
	if flag.MatchTargetingKey != "" && flag.MatchTargetingKey != ctx.TargetingKey {
		return false
	}
	for k, want := range flag.MatchAttributes {
		if !jsonEqual(ctx.Attributes[k], want) {
			return false
		}
	}
	if len(flag.MatchGroups) > 0 {
		groups, ok := ctx.Attributes[domain.AttrGroups].(map[string]any)
		if !ok {
			groups, _ = ctx.Attributes["groups"].(map[string]any)
		}
		for k, want := range flag.MatchGroups {
			if groups == nil || !jsonEqual(groups[k], want) {
				return false
			}
		}
	}
	for k, want := range flag.MatchPerson {
		if !jsonEqual(ctx.Attributes[k], want) {
			return false
		}
	}
	return true
}

// jsonEqual compares two values by canonical JSON so json.Number, int64 and
// float64 encodings of the same number compare equal.
func jsonEqual(a, b any) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	ab, errA := json.Marshal(a)
	bb, errB := json.Marshal(b)
	return errA == nil && errB == nil && string(ab) == string(bb)
}

// convertValue coerces the stored fixture value to a float64 for a
// declared "number" flag (preserving numeric fixture input shapes such as
// json.Number/int), and passes every other type straight through.
func convertValue(flag Flag) any {
	if flag.Type == domain.FlagTypeNumber {
		switch v := flag.Value.(type) {
		case json.Number:
			if f, err := v.Float64(); err == nil {
				return f
			}
		case int:
			return float64(v)
		case int64:
			return float64(v)
		case float32:
			return float64(v)
		case float64:
			return v
		}
	}
	return flag.Value
}

func buildMetadata(flag Flag) map[string]any {
	meta := map[string]any{}
	if flag.Version != nil {
		meta[domain.MetaFlagVersion] = *flag.Version
	}
	// Vendor flag id + reason code are only exposed together, when the
	// vendor supplied both an id and a concrete condition index.
	if flag.VendorID != nil && flag.ConditionIndex != nil {
		meta[domain.MetaVendorFlagID] = *flag.VendorID
		meta[domain.MetaReasonCode] = flag.ReasonCode
	}
	if flag.FromCache {
		meta[domain.MetaFromCache] = true
	}
	if len(meta) == 0 {
		return nil
	}
	return meta
}

var _ domain.BackendAdapter = (*Adapter)(nil)
