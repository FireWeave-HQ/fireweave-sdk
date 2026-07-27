package openfeature

import (
	"context"
	"errors"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/inmemory"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	of "github.com/open-feature/go-sdk/openfeature"
)

func testProvider(t *testing.T, flags map[string]inmemory.Flag, cfg fireweave.Config, initialize bool) *Provider {
	t.Helper()
	adapter := inmemory.New(inmemory.WithFlags(flags))
	client := fireweave.NewClient(fireweave.NewRuntime(adapter, cfg))
	p := NewProvider(client)
	if initialize {
		if err := p.InitWithContext(context.Background(), of.EvaluationContext{}); err != nil {
			t.Fatalf("init: %v", err)
		}
	}
	t.Cleanup(func() { _ = p.ShutdownWithContext(context.Background()) })
	return p
}

func version(v int64) *int64 { return &v }

func defaultFlags() map[string]inmemory.Flag {
	return map[string]inmemory.Flag{
		"fw-bool":  {Type: fireweave.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true, Version: version(1)},
		"fw-str":   {Type: fireweave.FlagTypeString, Enabled: true, Variant: "dark", Value: "dark"},
		"fw-int":   {Type: fireweave.FlagTypeInteger, Enabled: true, Variant: "fifty", Value: int64(50)},
		"fw-float": {Type: fireweave.FlagTypeFloat, Enabled: true, Variant: "half", Value: 0.5},
		"fw-obj":   {Type: fireweave.FlagTypeObject, Enabled: true, Variant: "v1", Value: map[string]any{"mode": "safe"}},
	}
}

func flat(targetingKey string) of.FlattenedContext {
	return of.FlattenedContext{of.TargetingKey: targetingKey}
}

func TestAllFiveResolvers(t *testing.T) {
	p := testProvider(t, defaultFlags(), fireweave.Config{}, true)
	ctx := context.Background()

	b := p.BooleanEvaluation(ctx, "fw-bool", false, flat("u1"))
	if b.Value != true || b.Variant != "on" || b.Reason != of.TargetingMatchReason {
		t.Errorf("bool = %+v", b)
	}
	if b.FlagMetadata[fireweave.MetaFlagVersion] != int64(1) {
		t.Errorf("bool metadata = %v", b.FlagMetadata)
	}

	s := p.StringEvaluation(ctx, "fw-str", "light", flat("u1"))
	if s.Value != "dark" || s.Variant != "dark" {
		t.Errorf("string = %+v", s)
	}
	i := p.IntEvaluation(ctx, "fw-int", 0, flat("u1"))
	if i.Value != 50 {
		t.Errorf("int = %+v", i)
	}
	f := p.FloatEvaluation(ctx, "fw-float", 0, flat("u1"))
	if f.Value != 0.5 {
		t.Errorf("float = %+v", f)
	}
	o := p.ObjectEvaluation(ctx, "fw-obj", nil, flat("u1"))
	if m, ok := o.Value.(map[string]any); !ok || m["mode"] != "safe" {
		t.Errorf("object = %+v", o)
	}
}

func TestErrorCodeMapping(t *testing.T) {
	p := testProvider(t, defaultFlags(), fireweave.Config{}, true)
	ctx := context.Background()

	missing := p.BooleanEvaluation(ctx, "nope", false, flat("u1"))
	if missing.ResolutionDetail().ErrorCode != of.FlagNotFoundCode || missing.Value != false {
		t.Errorf("missing flag = %+v", missing.ResolutionDetail())
	}
	if missing.FlagMetadata[fireweave.MetaErrorKind] != "FlagNotFound" {
		t.Errorf("metadata = %v", missing.FlagMetadata)
	}

	mismatch := p.StringEvaluation(ctx, "fw-bool", "fb", flat("u1"))
	if mismatch.ResolutionDetail().ErrorCode != of.TypeMismatchCode || mismatch.Value != "fb" {
		t.Errorf("mismatch = %+v", mismatch.ResolutionDetail())
	}
}

func TestNotReadyAndClosedMapToProviderNotReady(t *testing.T) {
	p := testProvider(t, defaultFlags(), fireweave.Config{}, false)
	ctx := context.Background()

	d := p.BooleanEvaluation(ctx, "fw-bool", false, flat("u1"))
	rd := d.ResolutionDetail()
	if rd.ErrorCode != of.ProviderNotReadyCode || rd.ErrorMessage != "provider not ready" {
		t.Errorf("not ready = %+v", rd)
	}

	if err := p.InitWithContext(ctx, of.EvaluationContext{}); err != nil {
		t.Fatal(err)
	}
	if err := p.ShutdownWithContext(ctx); err != nil {
		t.Fatal(err)
	}
	d = p.BooleanEvaluation(ctx, "fw-bool", false, flat("u1"))
	rd = d.ResolutionDetail()
	if rd.ErrorCode != of.ProviderNotReadyCode || rd.ErrorMessage != "provider already closed" {
		t.Errorf("closed = %+v", rd)
	}
	if d.FlagMetadata[fireweave.MetaErrorKind] != "AlreadyClosed" {
		t.Errorf("metadata = %v", d.FlagMetadata)
	}
}

func TestTargetingKeyMissingCode(t *testing.T) {
	p := testProvider(t, defaultFlags(), fireweave.Config{RequireTargetingKey: true}, true)
	d := p.BooleanEvaluation(context.Background(), "fw-bool", false, of.FlattenedContext{"plan": "pro"})
	rd := d.ResolutionDetail()
	if rd.ErrorCode != of.TargetingKeyMissingCode {
		t.Errorf("code = %s, want TARGETING_KEY_MISSING", rd.ErrorCode)
	}
}

func TestReservedKeyGuardThroughRealOFClient(t *testing.T) {
	p := testProvider(t, defaultFlags(), fireweave.Config{}, true)
	domain := "provider-test/reserved-keys"
	if err := of.SetNamedProviderAndWait(domain, p); err != nil {
		t.Fatal(err)
	}
	client := of.NewClient(domain)

	// targetingKey misused as an attribute alongside the dedicated field.
	evalCtx := of.NewEvaluationContext("u1", map[string]any{"targetingKey": "duplicate-illegal"})
	d, _ := client.BooleanValueDetails(context.Background(), "fw-bool", false, evalCtx)
	if d.ErrorCode != of.InvalidContextCode {
		t.Errorf("code = %s, want INVALID_CONTEXT (guard hook must catch pre-flatten misuse)", d.ErrorCode)
	}
	if d.Value != false {
		t.Errorf("value = %v, want default", d.Value)
	}
}

func TestInitErrorCodesForFatalVsTransient(t *testing.T) {
	fatal := inmemory.New(inmemory.WithInitError(fireweave.NewError(fireweave.KindConfiguration, "", nil)))
	p := NewProvider(fireweave.NewClient(fireweave.NewRuntime(fatal, fireweave.Config{})))
	err := p.InitWithContext(context.Background(), of.EvaluationContext{})
	var initErr *of.ProviderInitError
	if !asInitError(err, &initErr) || initErr.ErrorCode != of.ProviderFatalCode {
		t.Fatalf("fatal init err = %v", err)
	}

	transient := inmemory.New(inmemory.WithInitError(fireweave.NewError(fireweave.KindNetwork, "", nil)))
	p2 := NewProvider(fireweave.NewClient(fireweave.NewRuntime(transient, fireweave.Config{})))
	err = p2.InitWithContext(context.Background(), of.EvaluationContext{})
	if !asInitError(err, &initErr) || initErr.ErrorCode != of.ProviderNotReadyCode {
		t.Fatalf("transient init err = %v", err)
	}
}

func asInitError(err error, target **of.ProviderInitError) bool {
	return errors.As(err, target)
}

func TestMetadataName(t *testing.T) {
	p := testProvider(t, nil, fireweave.Config{}, false)
	if p.Metadata().Name != "fireweave" {
		t.Errorf("metadata name = %q", p.Metadata().Name)
	}
}
