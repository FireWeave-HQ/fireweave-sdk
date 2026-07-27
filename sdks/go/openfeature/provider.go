// Package openfeature adapts the Fireweave runtime to the OpenFeature Go
// SDK (v1.17.2) FeatureProvider contract, per ADR-0003.
//
// The provider implements all five typed resolvers, ContextAwareStateHandler
// (context-bounded Init/Shutdown), and ships one provider hook that guards
// against reserved-key misuse before the Go SDK's context flattening
// destroys the evidence.
//
// Concurrency: Provider is stateless apart from the embedded *fireweave
// Runtime/Client, both safe for concurrent use; all resolvers may be called
// from many goroutines.
package openfeature

import (
	"context"
	"errors"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	of "github.com/open-feature/go-sdk/openfeature"
)

// Provider is the Fireweave OpenFeature provider.
type Provider struct {
	client *fireweave.Client
}

// NewProvider wraps a Fireweave client (and its runtime).
func NewProvider(client *fireweave.Client) *Provider {
	return &Provider{client: client}
}

// Client returns the FireweaveClient extension surface (releases,
// exposures, signals, guardrails, capabilities).
func (p *Provider) Client() *fireweave.Client { return p.client }

var _ of.FeatureProvider = (*Provider)(nil)
var _ of.StateHandler = (*Provider)(nil)
var _ of.ContextAwareStateHandler = (*Provider)(nil)

// Metadata implements of.FeatureProvider.
func (p *Provider) Metadata() of.Metadata {
	return of.Metadata{Name: "fireweave"}
}

// Hooks returns the provider-scoped hooks (the reserved-key guard).
func (p *Provider) Hooks() []of.Hook {
	return []of.Hook{contextGuardHook{}}
}

// --- StateHandler / ContextAwareStateHandler ---

// Init implements of.StateHandler (background-context initialization).
func (p *Provider) Init(evalCtx of.EvaluationContext) error {
	return p.InitWithContext(context.Background(), evalCtx)
}

// InitWithContext drives the Fireweave runtime lifecycle. Configuration
// failures surface as PROVIDER_FATAL; other failures as PROVIDER_NOT_READY
// (retryable).
func (p *Provider) InitWithContext(ctx context.Context, _ of.EvaluationContext) error {
	err := p.client.Runtime().Initialize(ctx)
	if err == nil {
		return nil
	}
	var fwErr *fireweave.Error
	code := of.ProviderNotReadyCode
	msg := fireweave.DefaultMessage(fireweave.KindNotReady)
	if errors.As(err, &fwErr) {
		msg = fwErr.Message
		if fwErr.Kind == fireweave.KindConfiguration {
			code = of.ProviderFatalCode
		}
	}
	return &of.ProviderInitError{ErrorCode: code, Message: msg}
}

// Shutdown implements of.StateHandler with a bounded background context.
func (p *Provider) Shutdown() {
	_ = p.ShutdownWithContext(context.Background())
}

// ShutdownWithContext shuts the runtime down; idempotent.
func (p *Provider) ShutdownWithContext(ctx context.Context) error {
	return p.client.Runtime().Shutdown(ctx)
}

// --- Resolvers ---

// BooleanEvaluation implements of.FeatureProvider.
func (p *Provider) BooleanEvaluation(ctx context.Context, flag string, defaultValue bool, flatCtx of.FlattenedContext) of.BoolResolutionDetail {
	d, detail := p.evaluate(ctx, flag, fireweave.FlagTypeBoolean, defaultValue, flatCtx)
	value, ok := d.Value.(bool)
	if !ok {
		return of.BoolResolutionDetail{Value: defaultValue, ProviderResolutionDetail: typeMismatchDetail()}
	}
	return of.BoolResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// StringEvaluation implements of.FeatureProvider.
func (p *Provider) StringEvaluation(ctx context.Context, flag string, defaultValue string, flatCtx of.FlattenedContext) of.StringResolutionDetail {
	d, detail := p.evaluate(ctx, flag, fireweave.FlagTypeString, defaultValue, flatCtx)
	value, ok := d.Value.(string)
	if !ok {
		return of.StringResolutionDetail{Value: defaultValue, ProviderResolutionDetail: typeMismatchDetail()}
	}
	return of.StringResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// FloatEvaluation implements of.FeatureProvider.
func (p *Provider) FloatEvaluation(ctx context.Context, flag string, defaultValue float64, flatCtx of.FlattenedContext) of.FloatResolutionDetail {
	d, detail := p.evaluate(ctx, flag, fireweave.FlagTypeFloat, defaultValue, flatCtx)
	value, ok := toFloat(d.Value)
	if !ok {
		return of.FloatResolutionDetail{Value: defaultValue, ProviderResolutionDetail: typeMismatchDetail()}
	}
	return of.FloatResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// IntEvaluation implements of.FeatureProvider.
func (p *Provider) IntEvaluation(ctx context.Context, flag string, defaultValue int64, flatCtx of.FlattenedContext) of.IntResolutionDetail {
	d, detail := p.evaluate(ctx, flag, fireweave.FlagTypeInteger, defaultValue, flatCtx)
	value, ok := toInt(d.Value)
	if !ok {
		return of.IntResolutionDetail{Value: defaultValue, ProviderResolutionDetail: typeMismatchDetail()}
	}
	return of.IntResolutionDetail{Value: value, ProviderResolutionDetail: detail}
}

// ObjectEvaluation implements of.FeatureProvider.
func (p *Provider) ObjectEvaluation(ctx context.Context, flag string, defaultValue any, flatCtx of.FlattenedContext) of.InterfaceResolutionDetail {
	d, detail := p.evaluate(ctx, flag, fireweave.FlagTypeObject, defaultValue, flatCtx)
	return of.InterfaceResolutionDetail{Value: d.Value, ProviderResolutionDetail: detail}
}

// evaluate funnels one resolution through the shared runtime.
func (p *Provider) evaluate(ctx context.Context, flag string, t fireweave.FlagType, defaultValue any, flatCtx of.FlattenedContext) (fireweave.Decision, of.ProviderResolutionDetail) {
	req := fireweave.ResolveRequest{
		FlagKey:        flag,
		Type:           t,
		DefaultValue:   defaultValue,
		Context:        fromFlattened(flatCtx),
		IncludePayload: fireweave.IncludePayloadFromContext(ctx),
	}
	d := p.client.Runtime().Evaluate(ctx, req)
	return d, toResolutionDetail(d)
}

// fromFlattened converts the Go SDK's flattened context into Fireweave's
// structured context: "targetingKey" maps to the distinct identity, every
// other entry is an attribute.
func fromFlattened(flatCtx of.FlattenedContext) fireweave.EvaluationContext {
	targetingKey := ""
	attrs := make(map[string]any, len(flatCtx))
	for k, v := range flatCtx {
		if k == of.TargetingKey {
			if s, ok := v.(string); ok {
				targetingKey = s
				continue
			}
		}
		attrs[k] = v
	}
	return fireweave.NewEvaluationContext(targetingKey, attrs)
}

// toResolutionDetail maps a normalized Decision onto the OpenFeature
// resolution detail, including the canonical error-code mapping
// (contracts/errors.json).
func toResolutionDetail(d fireweave.Decision) of.ProviderResolutionDetail {
	detail := of.ProviderResolutionDetail{
		Reason:  of.Reason(string(d.Reason)),
		Variant: d.Variant,
	}
	if len(d.Metadata) > 0 {
		detail.FlagMetadata = of.FlagMetadata(d.Metadata)
	}
	if d.Error != nil {
		detail.ResolutionError = resolutionErrorFor(d.Error)
	}
	return detail
}

func resolutionErrorFor(err *fireweave.Error) of.ResolutionError {
	msg := err.Message
	switch err.Kind {
	case fireweave.KindNotReady, fireweave.KindAlreadyClosed:
		return of.NewProviderNotReadyResolutionError(msg)
	case fireweave.KindFlagNotFound:
		return of.NewFlagNotFoundResolutionError(msg)
	case fireweave.KindTypeMismatch:
		return of.NewTypeMismatchResolutionError(msg)
	case fireweave.KindInvalidContext:
		if err.TargetingKeyMissing {
			return of.NewTargetingKeyMissingResolutionError(msg)
		}
		return of.NewInvalidContextResolutionError(msg)
	case fireweave.KindMalformedResponse:
		return of.NewParseErrorResolutionError(msg)
	case fireweave.KindConfiguration:
		return of.NewProviderFatalResolutionError(msg)
	default:
		// Authentication, Authorization, RateLimited, Timeout, Network,
		// BackendUnavailable, UnsupportedCapability, Internal → GENERAL.
		return of.NewGeneralResolutionError(msg)
	}
}

func typeMismatchDetail() of.ProviderResolutionDetail {
	return of.ProviderResolutionDetail{
		ResolutionError: of.NewTypeMismatchResolutionError(fireweave.DefaultMessage(fireweave.KindTypeMismatch)),
		Reason:          of.ErrorReason,
		FlagMetadata: of.FlagMetadata{
			fireweave.MetaErrorKind: string(fireweave.KindTypeMismatch),
		},
	}
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int64:
		return float64(t), true
	case int:
		return float64(t), true
	default:
		return 0, false
	}
}

func toInt(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case int:
		return int64(t), true
	case int32:
		return int64(t), true
	default:
		return 0, false
	}
}
