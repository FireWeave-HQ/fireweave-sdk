// Package local is the local-development BackendAdapter — the counterpart
// to infrastructure/adapters/remote: production evaluates control points
// against fw-server, development evaluates them here, in-process, with no
// network and no credentials (spec/modes.md).
package local

import (
	"context"
	"log"
	"sync"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/domain"
)

// RegisteredTarget is one target recorded by Adapter.RegisterTarget.
type RegisteredTarget struct {
	TargetingKey string
	Kind         domain.TargetKind
	Properties   map[string]any
	Environment  string
}

// Adapter is the local-development BackendAdapter (domain.BackendAdapter
// + domain.TargetRegistrar).
//
// Resolution policy is deliberately minimal:
//   - a key present in the seeded map resolves to its mapped value with
//     reason STATIC — the only supported way to turn a control point ON
//     (or force it OFF) on a laptop;
//   - every other key MISSES with reason DEFAULT, which
//     application.(*Runtime).Evaluate turns into the caller's own default —
//     not an error (spec/modes.md "Behaviour per mode": local's
//     unknown-key row is deliberately default/DEFAULT, unlike remote's
//     default/ERROR/FlagNotFound). This adapter never returns an error on a
//     miss — a plain Decision with reason DEFAULT is the strict, typed seam
//     that keeps that distinction from the runtime's perspective.
type Adapter struct {
	seed map[string]bool
	log  func(string)

	mu      sync.Mutex
	targets map[string]RegisteredTarget
}

// New builds a local adapter. seed may be nil (empty seed map). log
// defaults to log.Print when nil.
func New(seed map[string]bool, logSink func(string)) *Adapter {
	s := make(map[string]bool, len(seed))
	for k, v := range seed {
		s[k] = v
	}
	if logSink == nil {
		logSink = func(msg string) { log.Print(msg) }
	}
	return &Adapter{seed: s, log: logSink, targets: map[string]RegisteredTarget{}}
}

// Initialize implements domain.BackendAdapter. Nothing to connect to.
func (a *Adapter) Initialize(ctx context.Context) error { return nil }

// Resolve implements domain.BackendAdapter.
//
// A seed hit reports the mapped boolean with reason STATIC and variant
// "on"/"off". Reporting a false override as DISABLED would mean "switched
// off upstream" — not what a local override expresses. The seed map is
// boolean-only, so reading an overridden key as a non-boolean type yields
// TypeMismatch rather than silently returning the default (a genuine
// caller mistake, better surfaced than hidden).
func (a *Adapter) Resolve(ctx context.Context, req domain.ResolveRequest) domain.Decision {
	override, ok := a.seed[req.FlagKey]
	if !ok {
		return domain.Decision{FlagKey: req.FlagKey, Value: req.DefaultValue, Reason: domain.ReasonDefault}
	}
	if req.Type != domain.FlagTypeBoolean {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindTypeMismatch, "", nil), nil)
	}
	variant := "off"
	if override {
		variant = "on"
	}
	return domain.Decision{FlagKey: req.FlagKey, Value: override, Variant: variant, Reason: domain.ReasonStatic}
}

// RegisterTarget implements domain.TargetRegistrar.
//
// Records the target in-process and traces it, rather than reporting
// UnsupportedCapability (spec/modes.md "registerTarget in local mode").
// The failure being guarded against is a developer believing their
// targeting works because nothing objected: an explicit
// "[fireweave:local]" line preserves that guarantee without the cost —
// nothing is silent, and local dev can exercise targeting rules offline
// instead of only against fw-server. The trace names the mode
// deliberately: a "[fireweave:local]" line appearing in a production log
// is itself the signal that something booted in local mode by mistake.
//
// No network call is made and nothing reaches fw-server. Always resolves
// OK: true.
func (a *Adapter) RegisterTarget(ctx context.Context, targetingKey string, opts domain.RegisterTargetOptions) domain.RegisterTargetResult {
	kind := opts.Kind
	if kind == "" {
		kind = domain.TargetKindUser
	}
	properties := make(map[string]any, len(opts.Properties))
	for k, v := range opts.Properties {
		properties[k] = v
	}
	target := RegisteredTarget{
		TargetingKey: targetingKey,
		Kind:         kind,
		Properties:   properties,
		Environment:  opts.Environment,
	}
	a.mu.Lock()
	a.targets[targetingKey] = target
	a.mu.Unlock()

	a.log("[fireweave:local] registerTarget " + string(kind) + " " + targetingKey +
		" — recorded in-process, NOT sent to fw-server")
	return domain.RegisterTargetResult{OK: true}
}

// GetRegisteredTargets returns the targets recorded this process, for
// assertions and dev inspection.
func (a *Adapter) GetRegisteredTargets() []RegisteredTarget {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]RegisteredTarget, 0, len(a.targets))
	for _, t := range a.targets {
		out = append(out, t)
	}
	return out
}

// Close implements domain.BackendAdapter; it is a no-op.
func (a *Adapter) Close(ctx context.Context) error { return nil }

var (
	_ domain.BackendAdapter  = (*Adapter)(nil)
	_ domain.TargetRegistrar = (*Adapter)(nil)
)
