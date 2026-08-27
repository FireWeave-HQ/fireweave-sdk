package local

import (
	"context"
	"strings"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/domain"
)

func TestSeededKeyResolvesStatic(t *testing.T) {
	a := New(map[string]bool{"checkout-v2": true, "beta-off": false}, nil)
	ctx := context.Background()

	d := a.Resolve(ctx, domain.ResolveRequest{
		FlagKey: "checkout-v2", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Value != true || d.Reason != domain.ReasonStatic || d.Variant != "on" {
		t.Fatalf("on = %+v", d)
	}

	d = a.Resolve(ctx, domain.ResolveRequest{
		FlagKey: "beta-off", Type: domain.FlagTypeBoolean, DefaultValue: true,
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Value != false || d.Reason != domain.ReasonStatic || d.Variant != "off" {
		t.Fatalf("off = %+v", d)
	}
}

// modes.md "Behaviour per mode": local's unknown-key row is
// default/DEFAULT — deliberately NOT an error, unlike remote's
// default/ERROR/FlagNotFound.
func TestUnknownKeyMissesAsDefaultNotError(t *testing.T) {
	a := New(map[string]bool{}, nil)
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "does-not-exist", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Error != nil {
		t.Fatalf("miss must not carry an error, got %+v", d)
	}
	if d.Value != false || d.Reason != domain.ReasonDefault {
		t.Fatalf("miss = %+v, want default/DEFAULT", d)
	}
}

func TestSeededKeyReadAsWrongTypeIsTypeMismatch(t *testing.T) {
	a := New(map[string]bool{"checkout-v2": true}, nil)
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "checkout-v2", Type: domain.FlagTypeString, DefaultValue: "x",
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Error == nil || d.Error.Kind != domain.KindTypeMismatch {
		t.Fatalf("got %+v, want TypeMismatch", d)
	}
}

func TestRegisterTargetRecordsInProcessAndTraces(t *testing.T) {
	var lines []string
	a := New(nil, func(msg string) { lines = append(lines, msg) })

	res := a.RegisterTarget(context.Background(), "user-1", domain.RegisterTargetOptions{
		Properties: map[string]any{"plan": "pro"},
	})
	if !res.OK {
		t.Fatalf("expected ok:true, got %+v", res)
	}

	targets := a.GetRegisteredTargets()
	if len(targets) != 1 || targets[0].TargetingKey != "user-1" || targets[0].Properties["plan"] != "pro" {
		t.Fatalf("recorded targets = %+v", targets)
	}
	if targets[0].Kind != domain.TargetKindUser {
		t.Errorf("kind = %s, want default user", targets[0].Kind)
	}

	if len(lines) != 1 {
		t.Fatalf("expected exactly one trace line, got %d: %v", len(lines), lines)
	}
	if !strings.Contains(lines[0], "[fireweave:local]") {
		t.Errorf("trace line must name the mode: %q", lines[0])
	}
	if !strings.Contains(lines[0], "NOT sent to fw-server") {
		t.Errorf("trace line must say nothing was sent: %q", lines[0])
	}
}

func TestRegisterTargetDefaultsLogSinkWithoutPanicking(t *testing.T) {
	a := New(nil, nil)
	if res := a.RegisterTarget(context.Background(), "user-1", domain.RegisterTargetOptions{}); !res.OK {
		t.Fatalf("expected ok:true, got %+v", res)
	}
}

var (
	_ domain.BackendAdapter  = (*Adapter)(nil)
	_ domain.TargetRegistrar = (*Adapter)(nil)
)
