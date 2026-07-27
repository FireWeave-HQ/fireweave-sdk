package fireweave

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
)

// ReleaseContext identifies the rollout a workload participates in
// (spec/release-context.schema.json).
type ReleaseContext struct {
	RolloutID string
	ChangeID  string
	StampIDs  []string
}

func (rc ReleaseContext) copy() ReleaseContext {
	rc.StampIDs = slices.Clone(rc.StampIDs)
	return rc
}

// ReleaseStatus is the lifecycle status of the bound release.
type ReleaseStatus string

const (
	ReleaseStatusUnset      ReleaseStatus = ""
	ReleaseStatusInProgress ReleaseStatus = "in_progress"
	ReleaseStatusCompleted  ReleaseStatus = "completed"
	ReleaseStatusFailed     ReleaseStatus = "failed"
)

// Exposure is one deterministic exposure record.
type Exposure struct {
	TargetingKey string
	FlagKey      string
	Variant      string
	Value        any
	RolloutID    string
}

// RecordResult reports the outcome of Exposures.Record.
type RecordResult struct {
	// Queued is the number of exposures pending flush after this call.
	Queued int
	// Deduped is true when this exposure was suppressed as a duplicate of a
	// previously recorded (targetingKey, flagKey, variant, value) tuple.
	Deduped bool
}

// SignalKind names the four canonical signal kinds (spec/signal.schema.json).
type SignalKind string

const (
	SignalKindHealth  SignalKind = "health"
	SignalKindError   SignalKind = "error"
	SignalKindMetric  SignalKind = "metric"
	SignalKindOutcome SignalKind = "outcome"
)

// HealthSignal reports component health.
type HealthSignal struct {
	Name      string
	Status    string
	RolloutID string
}

// ErrorSignal reports an error occurrence. Message is redacted on record.
type ErrorSignal struct {
	Name      string
	ErrorKind ErrorKind
	Message   string
	RolloutID string
}

// MetricSignal reports a numeric measurement.
type MetricSignal struct {
	Name      string
	Value     float64
	RolloutID string
	StampID   string
}

// OutcomeSignal reports a release outcome.
type OutcomeSignal struct {
	Name      string
	Status    string
	RolloutID string
	ChangeID  string
}

// Signal is the normalized recorded form of any signal kind.
type Signal struct {
	Kind      SignalKind
	Name      string
	Status    string
	ErrorKind ErrorKind
	Message   string
	Value     float64
	RolloutID string
	ChangeID  string
	StampID   string
}

// Capabilities advertised by this SDK in phase one, in canonical order.
var capabilityList = []string{
	"releases.setContext",
	"releases.start",
	"releases.complete",
	"releases.fail",
	"exposures.record",
	"exposures.flush",
	"signals.recordHealth",
	"signals.recordError",
	"signals.recordMetric",
	"signals.recordOutcome",
	"capabilities.get",
}

// Client is the FireweaveClient extension surface layered on a Runtime:
// releases, exposures, signals, guardrails (phase-one stub), and
// capabilities. All methods are safe for concurrent use.
type Client struct {
	rt *Runtime

	mu             sync.Mutex
	releaseCtx     *ReleaseContext
	releaseStatus  ReleaseStatus
	lastFailReason string
	exposureSeen   map[string]int
	exposureQueue  []Exposure
	signals        []Signal
}

// NewClient wraps a Runtime with the extension surface.
func NewClient(rt *Runtime) *Client {
	return &Client{rt: rt, exposureSeen: map[string]int{}}
}

// Runtime returns the underlying runtime.
func (c *Client) Runtime() *Runtime { return c.rt }

func (c *Client) gate() *Error {
	switch c.rt.State() {
	case StateReady, StateStale:
		return nil
	case StateShutdown:
		return NewError(KindAlreadyClosed, "", nil)
	default:
		return NewError(KindNotReady, "", nil)
	}
}

func (c *Client) sink() TelemetrySink {
	if s, ok := c.rt.Adapter().(TelemetrySink); ok {
		return s
	}
	return nil
}

func (c *Client) emit(ctx context.Context, name, distinctID string, props map[string]any) error {
	if s := c.sink(); s != nil {
		return s.EnqueueTelemetry(ctx, TelemetryEvent{
			Name:       name,
			DistinctID: distinctID,
			Properties: sanitizeTelemetryProperties(props),
		})
	}
	return nil
}

// --- Releases ---

// Releases exposes release lifecycle operations.
type Releases struct{ c *Client }

// Releases returns the release facade.
func (c *Client) Releases() Releases { return Releases{c} }

// SetContext binds the rollout identity used by subsequent release ops.
func (r Releases) SetContext(ctx context.Context, rc ReleaseContext) error {
	if err := r.c.gate(); err != nil {
		return err
	}
	if rc.RolloutID == "" {
		return NewError(KindConfiguration, "release context requires a rolloutId", nil)
	}
	cp := rc.copy()
	r.c.mu.Lock()
	r.c.releaseCtx = &cp
	r.c.releaseStatus = ReleaseStatusUnset
	r.c.lastFailReason = ""
	r.c.mu.Unlock()
	return nil
}

// Context returns the bound release context, if any.
func (r Releases) Context() (ReleaseContext, bool) {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	if r.c.releaseCtx == nil {
		return ReleaseContext{}, false
	}
	return r.c.releaseCtx.copy(), true
}

// Status returns the current release status.
func (r Releases) Status() ReleaseStatus {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	return r.c.releaseStatus
}

// FailReason returns the (redacted) reason recorded by Fail.
func (r Releases) FailReason() string {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	return r.c.lastFailReason
}

func (r Releases) transition(ctx context.Context, rolloutID string, to ReleaseStatus, reason string) error {
	if err := r.c.gate(); err != nil {
		return err
	}
	r.c.mu.Lock()
	if r.c.releaseCtx == nil || r.c.releaseCtx.RolloutID != rolloutID {
		r.c.mu.Unlock()
		return NewError(KindConfiguration, "release context not set for rollout", nil)
	}
	rc := r.c.releaseCtx.copy()
	r.c.releaseStatus = to
	r.c.lastFailReason = reason
	r.c.mu.Unlock()

	return r.c.emit(ctx, "$fw_release_"+string(to), rc.RolloutID, map[string]any{
		"rolloutId": rc.RolloutID,
		"changeId":  rc.ChangeID,
		"status":    string(to),
		"message":   reason,
	})
}

// Start marks the bound release in_progress.
func (r Releases) Start(ctx context.Context, rolloutID string) error {
	return r.transition(ctx, rolloutID, ReleaseStatusInProgress, "")
}

// Complete marks the bound release completed.
func (r Releases) Complete(ctx context.Context, rolloutID string) error {
	return r.transition(ctx, rolloutID, ReleaseStatusCompleted, "")
}

// Fail marks the bound release failed with a safe (redacted) reason.
func (r Releases) Fail(ctx context.Context, rolloutID, reason string) error {
	return r.transition(ctx, rolloutID, ReleaseStatusFailed, Redact(reason))
}

// --- Exposures ---

// Exposures exposes deterministic exposure recording with dedup.
type Exposures struct{ c *Client }

// Exposures returns the exposures facade.
func (c *Client) Exposures() Exposures { return Exposures{c} }

func exposureKey(e Exposure) string {
	v, _ := json.Marshal(e.Value)
	return e.TargetingKey + "\x00" + e.FlagKey + "\x00" + e.Variant + "\x00" + string(v)
}

// Record queues one exposure. Duplicate (targetingKey, flagKey, variant,
// value) tuples are deduplicated: the duplicate is counted but not queued.
func (x Exposures) Record(ctx context.Context, e Exposure) (RecordResult, error) {
	if err := x.c.gate(); err != nil {
		return RecordResult{}, err
	}
	key := exposureKey(e)
	x.c.mu.Lock()
	defer x.c.mu.Unlock()
	x.c.exposureSeen[key]++
	if x.c.exposureSeen[key] > 1 {
		return RecordResult{Queued: len(x.c.exposureQueue), Deduped: true}, nil
	}
	x.c.exposureQueue = append(x.c.exposureQueue, e)
	return RecordResult{Queued: len(x.c.exposureQueue)}, nil
}

// Pending returns the number of queued exposures.
func (x Exposures) Pending() int {
	x.c.mu.Lock()
	defer x.c.mu.Unlock()
	return len(x.c.exposureQueue)
}

// Flush drains the exposure queue to the adapter's telemetry sink (when
// available) and returns the number of exposures flushed.
func (x Exposures) Flush(ctx context.Context) (int, error) {
	if err := x.c.gate(); err != nil {
		return 0, err
	}
	x.c.mu.Lock()
	batch := x.c.exposureQueue
	x.c.exposureQueue = nil
	x.c.mu.Unlock()

	for i, e := range batch {
		props := map[string]any{
			"flagKey":   e.FlagKey,
			"variant":   e.Variant,
			"value":     e.Value,
			"rolloutId": e.RolloutID,
		}
		if err := x.c.emit(ctx, "$fw_exposure", e.TargetingKey, props); err != nil {
			// Requeue the unflushed remainder so nothing is silently lost.
			x.c.mu.Lock()
			x.c.exposureQueue = append(slices.Clone(batch[i:]), x.c.exposureQueue...)
			x.c.mu.Unlock()
			return i, asFireweaveError(err, KindInternal)
		}
	}
	if s := x.c.sink(); s != nil {
		if err := s.FlushTelemetry(ctx); err != nil {
			return len(batch), asFireweaveError(err, KindInternal)
		}
	}
	return len(batch), nil
}

// --- Signals ---

// Signals exposes health/error/metric/outcome signal recording.
type Signals struct{ c *Client }

// Signals returns the signals facade.
func (c *Client) Signals() Signals { return Signals{c} }

func (s Signals) record(ctx context.Context, sig Signal) error {
	if err := s.c.gate(); err != nil {
		return err
	}
	if sig.Name == "" {
		return NewError(KindConfiguration, "signal requires a name", nil)
	}
	sig.Message = Redact(sig.Message)
	s.c.mu.Lock()
	s.c.signals = append(s.c.signals, sig)
	s.c.mu.Unlock()
	return s.c.emit(ctx, "$fw_signal_"+string(sig.Kind), sig.RolloutID, map[string]any{
		"kind":        string(sig.Kind),
		"name":        sig.Name,
		"status":      sig.Status,
		"errorKind":   string(sig.ErrorKind),
		"message":     sig.Message,
		"metricValue": sig.Value,
		"rolloutId":   sig.RolloutID,
		"changeId":    sig.ChangeID,
		"stampId":     sig.StampID,
	})
}

// RecordHealth records a health signal.
func (s Signals) RecordHealth(ctx context.Context, sig HealthSignal) error {
	return s.record(ctx, Signal{Kind: SignalKindHealth, Name: sig.Name, Status: sig.Status, RolloutID: sig.RolloutID})
}

// RecordError records an error signal; the message is redacted.
func (s Signals) RecordError(ctx context.Context, sig ErrorSignal) error {
	return s.record(ctx, Signal{Kind: SignalKindError, Name: sig.Name, ErrorKind: sig.ErrorKind, Message: sig.Message, RolloutID: sig.RolloutID})
}

// RecordMetric records a metric signal.
func (s Signals) RecordMetric(ctx context.Context, sig MetricSignal) error {
	return s.record(ctx, Signal{Kind: SignalKindMetric, Name: sig.Name, Value: sig.Value, RolloutID: sig.RolloutID, StampID: sig.StampID})
}

// RecordOutcome records an outcome signal.
func (s Signals) RecordOutcome(ctx context.Context, sig OutcomeSignal) error {
	return s.record(ctx, Signal{Kind: SignalKindOutcome, Name: sig.Name, Status: sig.Status, RolloutID: sig.RolloutID, ChangeID: sig.ChangeID})
}

// Recorded returns a copy of every signal recorded so far.
func (s Signals) Recorded() []Signal {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	return slices.Clone(s.c.signals)
}

// --- Guardrails (phase-one stub) ---

// Guardrails is the phase-one guardrail facade. Every operation degrades
// gracefully with an UnsupportedCapability error; nothing panics.
type Guardrails struct{ c *Client }

// Guardrails returns the guardrails facade.
func (c *Client) Guardrails() Guardrails { return Guardrails{c} }

// Check always reports UnsupportedCapability in phase one.
func (g Guardrails) Check(ctx context.Context, name string, args map[string]any) error {
	return NewError(KindUnsupportedCapability, "", nil)
}

// --- Capabilities ---

// CapabilitySet exposes capability negotiation.
type CapabilitySet struct{ c *Client }

// Capabilities returns the capability facade.
func (c *Client) Capabilities() CapabilitySet { return CapabilitySet{c} }

// Get returns the negotiated capability list for this SDK build.
func (cs CapabilitySet) Get() []string { return slices.Clone(capabilityList) }

// Invoke dispatches a capability by name. Unknown capabilities degrade with
// a typed UnsupportedCapability error instead of panicking.
func (cs CapabilitySet) Invoke(ctx context.Context, capability string, args map[string]any) error {
	if !slices.Contains(capabilityList, capability) {
		return NewError(KindUnsupportedCapability, "", nil)
	}
	return nil
}
