package application

import (
	"context"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/domain"
)

// EvaluateOptions is the reserved fifth argument of
// evaluate(key, type, default, context?, options?)
// (conformance/surface/control-points.surface.json). v1 reads are
// side-effect free (spec/control-points.md "Side effects": "no read emits
// telemetry as a consequence of being called") — there is no per-call
// exposure opt-in to carry, unlike the pre-v1 Go surface this replaces.
//
// IncludePayload (task-10b item 5, contracts/evaluation/eval-payload-
// attached.json) is the one real field: node's EvaluateOptions.includePayload
// has the equivalent effect (attach the resolved flag's payload, when any, as
// fireweave.payload metadata — a deterministic sorted-key JSON string). Every
// other cross-language surface concern this type existed for (arity parity)
// remains unaffected.
type EvaluateOptions struct {
	IncludePayload bool
}

// supportedCapabilities names the capability strings InvokeCapability will
// dispatch instead of degrading with UnsupportedCapability. Empty in v1:
// releases, exposures, signals, capabilities discovery, and guardrails are
// all out of scope (spec/control-points.md "Scope of v1") and MUST NOT be
// exposed, so a cut namespace's capability string resolves exactly like any
// other unknown string.
var supportedCapabilities = map[string]bool{}

// Client is the FireweaveClient surface: control-point evaluation plus
// target registration — the only two v1 capabilities
// (spec/control-points.md "Scope of v1"). All methods are safe for
// concurrent use.
type Client struct {
	runtime       *Runtime
	controlPoints *ControlPoints
}

// NewClient wraps a Runtime with the public client surface.
func NewClient(runtime *Runtime) *Client {
	c := &Client{runtime: runtime}
	c.controlPoints = &ControlPoints{c: c}
	return c
}

// Runtime returns the underlying runtime.
func (c *Client) Runtime() *Runtime { return c.runtime }

// ControlPoints returns the documented evaluation namespace (ADR-0007's Go
// casing: ControlPoints).
func (c *Client) ControlPoints() *ControlPoints { return c.controlPoints }

// RegisterTarget registers a user or device so rules can target its durable
// properties (POST /v1/targets/register in remote mode; recorded
// in-process and traced in local mode). Never panics: this runs in sign-in
// paths, where a targeting concern must not break authentication.
//
// opts may be nil (equivalent to the zero RegisterTargetOptions).
func (c *Client) RegisterTarget(targetingKey string, opts *RegisterTargetOptions) RegisterTargetResult {
	o := RegisterTargetOptions{}
	if opts != nil {
		o = *opts
	}
	return c.runtime.RegisterTarget(context.Background(), targetingKey, o)
}

// InvokeCapability dispatches a capability by name. Every name degrades
// with UnsupportedCapability in v1 — SUPPORTED_CAPABILITIES is empty — and
// this never panics (fixture ext-unsupported-capability-degrade). A future
// capability listed in supportedCapabilities would additionally be
// lifecycle-gated the same way extension calls always were.
func (c *Client) InvokeCapability(capability string, args map[string]any) *domain.Error {
	if !supportedCapabilities[capability] {
		return domain.NewError(domain.KindUnsupportedCapability, "", nil)
	}
	switch c.runtime.State() {
	case StateReady, StateStale:
		return nil
	case StateShutdown:
		return domain.NewError(domain.KindAlreadyClosed, "", nil)
	default:
		return domain.NewError(domain.KindUnsupportedCapability, "", nil)
	}
}

// ControlPoints is the typed evaluation surface — the nine methods
// (spec/control-points.md "The nine methods"), Go-cased per
// conformance/surface/control-points.surface.json. Documented as
// Client.ControlPoints(). The Client.Flags() alias was removed in 3.0.0
// (ADR-0013).
type ControlPoints struct {
	c *Client
}

// Evaluate resolves a flag and returns the full Decision — the general form
// the eight typed methods below delegate to. Never panics: failures
// degrade to the caller's default with Reason ERROR (spec/control-points.md
// "Return discipline").
//
// evalCtx and opts may be nil (equivalent to their zero values) — the Go
// port of the descriptor's optional "context?"/"options?" arguments.
func (cp *ControlPoints) Evaluate(controlPointKey string, flagType domain.FlagType, defaultValue any, evalCtx *domain.EvaluationContext, opts *EvaluateOptions) domain.Decision {
	var ec domain.EvaluationContext
	if evalCtx != nil {
		ec = *evalCtx
	}
	var includePayload bool
	if opts != nil {
		includePayload = opts.IncludePayload
	}
	return cp.c.runtime.Evaluate(context.Background(), ResolveRequest{
		ControlPointKey: controlPointKey,
		Type:            flagType,
		DefaultValue:    defaultValue,
		Context:         ec,
		IncludePayload:  includePayload,
	})
}

// GetBooleanValue returns the resolved boolean value (Decision.Value),
// falling back to defaultValue when the resolved value is not itself a bool
// (an adapter/type-mismatch edge the typed accessor must not propagate as a
// panic).
func (cp *ControlPoints) GetBooleanValue(controlPointKey string, defaultValue bool, evalCtx *domain.EvaluationContext) bool {
	d := cp.Evaluate(controlPointKey, domain.FlagTypeBoolean, defaultValue, evalCtx, nil)
	if v, ok := d.Value.(bool); ok {
		return v
	}
	return defaultValue
}

// GetStringValue returns the resolved string value.
func (cp *ControlPoints) GetStringValue(controlPointKey string, defaultValue string, evalCtx *domain.EvaluationContext) string {
	d := cp.Evaluate(controlPointKey, domain.FlagTypeString, defaultValue, evalCtx, nil)
	if v, ok := d.Value.(string); ok {
		return v
	}
	return defaultValue
}

// GetNumberValue returns the resolved number value. number, not integer —
// Decision.Value is jsonValue.
func (cp *ControlPoints) GetNumberValue(controlPointKey string, defaultValue float64, evalCtx *domain.EvaluationContext) float64 {
	d := cp.Evaluate(controlPointKey, domain.FlagTypeNumber, defaultValue, evalCtx, nil)
	if v, ok := asFloat64(d.Value); ok {
		return v
	}
	return defaultValue
}

// GetObjectValue returns the resolved JSON object/array value. REQUIRED,
// not optional (spec/control-points.md "The nine methods").
func (cp *ControlPoints) GetObjectValue(controlPointKey string, defaultValue any, evalCtx *domain.EvaluationContext) any {
	d := cp.Evaluate(controlPointKey, domain.FlagTypeObject, defaultValue, evalCtx, nil)
	switch d.Value.(type) {
	case map[string]any, []any:
		return d.Value
	default:
		return defaultValue
	}
}

// GetBooleanDetails returns the full Decision rather than just its value.
// Same arguments as GetBooleanValue, so a caller upgrades from one to the
// other without restructuring the call.
func (cp *ControlPoints) GetBooleanDetails(controlPointKey string, defaultValue bool, evalCtx *domain.EvaluationContext) domain.Decision {
	return cp.Evaluate(controlPointKey, domain.FlagTypeBoolean, defaultValue, evalCtx, nil)
}

// GetStringDetails returns the full Decision for a string control point.
func (cp *ControlPoints) GetStringDetails(controlPointKey string, defaultValue string, evalCtx *domain.EvaluationContext) domain.Decision {
	return cp.Evaluate(controlPointKey, domain.FlagTypeString, defaultValue, evalCtx, nil)
}

// GetNumberDetails returns the full Decision for a number control point.
func (cp *ControlPoints) GetNumberDetails(controlPointKey string, defaultValue float64, evalCtx *domain.EvaluationContext) domain.Decision {
	return cp.Evaluate(controlPointKey, domain.FlagTypeNumber, defaultValue, evalCtx, nil)
}

// GetObjectDetails returns the full Decision for an object control point.
func (cp *ControlPoints) GetObjectDetails(controlPointKey string, defaultValue any, evalCtx *domain.EvaluationContext) domain.Decision {
	return cp.Evaluate(controlPointKey, domain.FlagTypeObject, defaultValue, evalCtx, nil)
}

func asFloat64(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	default:
		return 0, false
	}
}
