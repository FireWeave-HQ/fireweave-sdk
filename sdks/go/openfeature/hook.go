package openfeature

import (
	"context"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	of "github.com/open-feature/go-sdk/openfeature"
)

// contextGuardHook detects reserved-key misuse ("targetingKey" or "kind"
// supplied as context attributes) before the Go OpenFeature SDK flattens
// the context. Flattening folds the dedicated targeting key into the same
// map as attributes, which would silently mask the conflict; the hook
// preserves the evidence by injecting the internal
// fireweave.ReservedInvalidContextKey sentinel, which context validation
// always rejects as INVALID_CONTEXT.
type contextGuardHook struct{}

var _ of.Hook = contextGuardHook{}

func (contextGuardHook) Before(ctx context.Context, hookCtx of.HookContext, _ of.HookHints) (*of.EvaluationContext, error) {
	ec := hookCtx.EvaluationContext()
	attrs := ec.Attributes()
	_, hasTargetingKey := attrs[of.TargetingKey]
	_, hasKind := attrs["kind"]
	if !hasTargetingKey && !hasKind {
		return nil, nil
	}
	attrs[fireweave.ReservedInvalidContextKey] = true
	guarded := of.NewEvaluationContext(ec.TargetingKey(), attrs)
	return &guarded, nil
}

func (contextGuardHook) After(context.Context, of.HookContext, of.InterfaceEvaluationDetails, of.HookHints) error {
	return nil
}

func (contextGuardHook) Error(context.Context, of.HookContext, error, of.HookHints) {}

func (contextGuardHook) Finally(context.Context, of.HookContext, of.InterfaceEvaluationDetails, of.HookHints) {
}
