// Package inmemory provides a deterministic, fixture-driven BackendAdapter
// used by tests and the conformance harness. It performs no I/O.
package inmemory

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"sync/atomic"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
)

// Flag is one deterministic flag definition, mirroring the shape used by
// contracts/ fixtures (given.flags).
type Flag struct {
	Type    fireweave.FlagType
	Enabled bool
	Variant string
	Value   any
	Payload any

	// Vendor-style reason/metadata fields.
	ReasonCode     string
	ConditionIndex *int
	Version        *int64
	VendorID       *int64

	// OverrideReason forces the normalized reason (e.g. SPLIT).
	OverrideReason fireweave.Reason
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

// Adapter is a deterministic in-memory BackendAdapter. It is safe for
// concurrent use and also implements fireweave.TelemetrySink so client
// extensions (exposures, signals) can be exercised without a network.
type Adapter struct {
	mu        sync.RWMutex
	flags     map[string]Flag
	initErr   error
	pending   []fireweave.TelemetryEvent
	delivered []fireweave.TelemetryEvent

	resolveCount atomic.Int64
	lastCtx      atomic.Pointer[fireweave.EvaluationContext]
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

// Initialize implements fireweave.BackendAdapter.
func (a *Adapter) Initialize(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fireweave.NewError(fireweave.KindTimeout, "", err)
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.initErr
}

// Close implements fireweave.BackendAdapter; it is a no-op.
func (a *Adapter) Close(ctx context.Context) error { return nil }

// ResolveCount reports how many Resolve calls reached the adapter (the
// conformance harness uses it to assert networkCalls == 0 semantics).
func (a *Adapter) ResolveCount() int64 { return a.resolveCount.Load() }

// LastContext returns a copy of the most recently resolved context.
func (a *Adapter) LastContext() (fireweave.EvaluationContext, bool) {
	p := a.lastCtx.Load()
	if p == nil {
		return fireweave.EvaluationContext{}, false
	}
	return p.Copy(), true
}

// Resolve implements fireweave.BackendAdapter deterministically from the
// flag table.
func (a *Adapter) Resolve(ctx context.Context, req fireweave.ResolveRequest) fireweave.Decision {
	a.resolveCount.Add(1)
	cp := req.Context.Copy()
	a.lastCtx.Store(&cp)

	a.mu.RLock()
	flag, ok := a.flags[req.FlagKey]
	a.mu.RUnlock()

	if !ok {
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindFlagNotFound, "", nil), nil)
	}
	if flag.Type != req.Type {
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindTypeMismatch, "", nil), nil)
	}
	if !matches(flag, req.Context) {
		return fireweave.Decision{Value: req.DefaultValue, Reason: fireweave.ReasonDefault, Metadata: buildMetadata(flag, req.IncludePayload)}
	}

	meta := buildMetadata(flag, req.IncludePayload)
	if !flag.Enabled {
		return fireweave.Decision{
			Value:    convertValue(flag),
			Variant:  flag.Variant,
			Reason:   fireweave.ReasonDisabled,
			Metadata: meta,
		}
	}

	reason := fireweave.ReasonTargetingMatch
	if flag.OverrideReason != "" {
		reason = flag.OverrideReason
	}
	if flag.FromCache {
		reason = fireweave.ReasonStale
	}
	return fireweave.Decision{
		Value:    convertValue(flag),
		Variant:  flag.Variant,
		Reason:   reason,
		Metadata: meta,
	}
}

func matches(flag Flag, ctx fireweave.EvaluationContext) bool {
	if flag.MatchTargetingKey != "" && flag.MatchTargetingKey != ctx.TargetingKey {
		return false
	}
	for k, want := range flag.MatchAttributes {
		if !jsonEqual(ctx.Attributes[k], want) {
			return false
		}
	}
	if len(flag.MatchGroups) > 0 {
		groups, _ := ctx.Attributes["groups"].(map[string]any)
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

// convertValue coerces the stored fixture value to the language-native type
// for the declared flag type, preserving 64-bit integer precision.
func convertValue(flag Flag) any {
	switch flag.Type {
	case fireweave.FlagTypeInteger:
		switch v := flag.Value.(type) {
		case json.Number:
			if i, err := v.Int64(); err == nil {
				return i
			}
		case int:
			return int64(v)
		case int64:
			return v
		case float64:
			return int64(v)
		}
	case fireweave.FlagTypeFloat:
		switch v := flag.Value.(type) {
		case json.Number:
			if f, err := v.Float64(); err == nil {
				return f
			}
		case int:
			return float64(v)
		case int64:
			return float64(v)
		case float64:
			return v
		}
	}
	return flag.Value
}

func buildMetadata(flag Flag, includePayload bool) map[string]any {
	meta := map[string]any{}
	if flag.Version != nil {
		meta[fireweave.MetaFlagVersion] = *flag.Version
	}
	// Vendor flag id + reason code are only exposed together, when the
	// vendor supplied both an id and a concrete condition index.
	if flag.VendorID != nil && flag.ConditionIndex != nil {
		meta[fireweave.MetaVendorFlagID] = *flag.VendorID
		meta[fireweave.MetaReasonCode] = flag.ReasonCode
	}
	if includePayload && flag.Payload != nil {
		if b, err := json.Marshal(flag.Payload); err == nil {
			meta[fireweave.MetaPayload] = string(b)
		}
	}
	if flag.FromCache {
		meta[fireweave.MetaFromCache] = true
	}
	if len(meta) == 0 {
		return nil
	}
	return meta
}

// --- TelemetrySink ---

// EnqueueTelemetry stores the event in the pending buffer.
func (a *Adapter) EnqueueTelemetry(ctx context.Context, ev fireweave.TelemetryEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pending = append(a.pending, ev)
	return nil
}

// FlushTelemetry moves pending events to the delivered log.
func (a *Adapter) FlushTelemetry(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.delivered = append(a.delivered, a.pending...)
	a.pending = nil
	return nil
}

// PendingTelemetry returns a copy of undelivered events.
func (a *Adapter) PendingTelemetry() []fireweave.TelemetryEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]fireweave.TelemetryEvent, len(a.pending))
	copy(out, a.pending)
	return out
}

// DeliveredTelemetry returns a copy of flushed events.
func (a *Adapter) DeliveredTelemetry() []fireweave.TelemetryEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]fireweave.TelemetryEvent, len(a.delivered))
	copy(out, a.delivered)
	return out
}

var _ fireweave.BackendAdapter = (*Adapter)(nil)
var _ fireweave.TelemetrySink = (*Adapter)(nil)
