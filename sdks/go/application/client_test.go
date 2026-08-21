package application

import (
	"context"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
)

func readyClient(t *testing.T) *Client {
	t.Helper()
	return NewClient(readyRuntime(t, &stubAdapter{resolveFn: func(_ context.Context, req ResolveRequest) domain.Decision {
		if req.FlagKey == "fw-on" {
			return domain.Decision{FlagKey: req.FlagKey, Value: true, Variant: "on", Reason: domain.ReasonTargetingMatch}
		}
		return domain.Decision{FlagKey: req.FlagKey, Value: req.DefaultValue, Reason: domain.ReasonDefault}
	}}))
}

func TestFlagsAndControlPointsShareIdentity(t *testing.T) {
	c := readyClient(t)
	if c.ControlPoints() != c.Flags() {
		t.Fatal("Client.Flags() must return the identical *ControlPoints as Client.ControlPoints()")
	}
}

func TestControlPointsGetBooleanValueAndDetails(t *testing.T) {
	c := readyClient(t)
	cp := c.ControlPoints()

	if v := cp.GetBooleanValue("fw-on", false, nil); v != true {
		t.Errorf("GetBooleanValue = %v, want true", v)
	}
	d := cp.GetBooleanDetails("fw-on", false, nil)
	if d.Value != true || d.Reason != domain.ReasonTargetingMatch || d.FlagKey != "fw-on" {
		t.Fatalf("GetBooleanDetails = %+v", d)
	}

	// *Value returns the bare value; *Details returns the whole Decision —
	// same arguments, so a caller upgrades from one to the other without
	// restructuring the call.
	if v := cp.GetBooleanValue("absent", false, nil); v != false {
		t.Errorf("miss value = %v, want caller default false", v)
	}
	miss := cp.GetBooleanDetails("absent", false, nil)
	if miss.Value != false || miss.Reason != domain.ReasonDefault {
		t.Fatalf("miss details = %+v", miss)
	}
}

func TestControlPointsAllNineMethodsReachable(t *testing.T) {
	c := readyClient(t)
	cp := c.ControlPoints()

	_ = cp.GetBooleanValue("k", false, nil)
	_ = cp.GetStringValue("k", "d", nil)
	_ = cp.GetNumberValue("k", 1, nil)
	_ = cp.GetObjectValue("k", map[string]any{}, nil)
	_ = cp.GetBooleanDetails("k", false, nil)
	_ = cp.GetStringDetails("k", "d", nil)
	_ = cp.GetNumberDetails("k", 1, nil)
	_ = cp.GetObjectDetails("k", map[string]any{}, nil)
	d := cp.Evaluate("k", domain.FlagTypeBoolean, false, nil, nil)
	if d.FlagKey != "k" {
		t.Errorf("Evaluate: %+v", d)
	}
}

func TestControlPointsNeverPanicsOnCyclicContext(t *testing.T) {
	c := readyClient(t)
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	ctx := domain.NewEvaluationContext("u", map[string]any{"loop": cyclic})

	d := c.ControlPoints().GetBooleanDetails("fw-on", false, &ctx)
	if d.Value != false || d.Reason != domain.ReasonError || d.Error == nil || d.Error.Kind != domain.KindInvalidContext {
		t.Fatalf("decision = %+v, want ERROR/InvalidContext default", d)
	}
}

func TestInvokeCapabilityAlwaysDegradesInV1(t *testing.T) {
	c := readyClient(t)
	for _, capability := range []string{"releases.setContext", "exposures.record", "signals.recordHealth", "capabilities.get", "guardrails.check", "anything"} {
		if err := c.InvokeCapability(capability, nil); err == nil || err.Kind != domain.KindUnsupportedCapability {
			t.Errorf("capability %q: got %v, want UnsupportedCapability", capability, err)
		}
	}
}

func TestRegisterTargetResolvesRatherThanPanicking(t *testing.T) {
	c := readyClient(t)
	res := c.RegisterTarget("user-1", nil)
	if !res.OK {
		t.Fatalf("expected ok:true, got %+v", res)
	}
}

func TestClientConcurrentSafety(t *testing.T) {
	c := readyClient(t)
	done := make(chan struct{})
	for i := 0; i < 16; i++ {
		go func(i int) {
			_ = c.ControlPoints().GetBooleanValue("fw-on", false, nil)
			_ = c.RegisterTarget("u", nil)
			_ = c.InvokeCapability("x", nil)
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 16; i++ {
		<-done
	}
}
