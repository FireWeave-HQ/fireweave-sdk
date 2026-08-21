package fireweave

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// Control-point SURFACE parity (spec/control-points.md,
// conformance/surface/control-points.surface.json).
//
// Behaviour is asserted elsewhere (application package tests); this file
// asserts the surface EXISTS, reading the descriptor rather than
// hard-coding names/arities. That distinction matters because a missing
// method is invisible: go shipped client.Flags() with no ControlPoints
// namespace at all — the exact gap the descriptor's own $comment calls
// out — and nothing structurally forced it to be noticed for months. This
// test turns that silent divergence into a failing assertion.

type surfaceMethod struct {
	Name      string   `json:"name"`
	Returns   string   `json:"returns"`
	Args      []string `json:"args"`
	LocalMode string   `json:"localMode"`
}

type surfaceDescriptor struct {
	Namespace struct {
		Documented             string            `json:"documented"`
		Casing                 map[string]string `json:"casing"`
		DeprecatedAlias        string            `json:"deprecatedAlias"`
		AliasMustShareIdentity bool              `json:"aliasMustShareIdentity"`
	} `json:"namespace"`
	Methods []surfaceMethod `json:"methods"`
	Client  struct {
		Methods       []surfaceMethod `json:"methods"`
		MustNotExpose []string        `json:"mustNotExpose"`
	} `json:"client"`
	Compatibility map[string]string `json:"compatibility"`
}

func loadDescriptor(t *testing.T) surfaceDescriptor {
	t.Helper()
	path := filepath.Join(repoRoot(t), "conformance", "surface", "control-points.surface.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read descriptor: %v", err)
	}
	var d surfaceDescriptor
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatalf("parse descriptor: %v", err)
	}
	return d
}

// goCase converts the descriptor's canonical camelCase method name
// ("getBooleanValue") to the Go casing conformance/surface/control-points.surface.json
// pins ("GetBooleanValue"): capitalize the first rune, leave the rest
// unchanged. Naming follows each language's idiom, but the method set and
// its semantics do not vary (spec/control-points.md "The nine methods").
func goCase(name string) string {
	if name == "" {
		return name
	}
	return strings.ToUpper(name[:1]) + name[1:]
}

func testClient(t *testing.T) *Client {
	t.Helper()
	c, err := Init(Options{Mode: ModeLocal})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	return c
}

func TestNamespaceCasingIsControlPointsPerDescriptor(t *testing.T) {
	d := loadDescriptor(t)
	if got := d.Namespace.Casing["go"]; got != "ControlPoints" {
		t.Fatalf("descriptor go casing = %q, want ControlPoints", got)
	}
	// The namespace exists under that exact accessor name.
	c := testClient(t)
	if c.ControlPoints() == nil {
		t.Fatal("Client.ControlPoints() must not be nil")
	}
}

func TestControlPointsExposesAllNineMethodsAtDescriptorArity(t *testing.T) {
	d := loadDescriptor(t)
	if len(d.Methods) == 0 {
		t.Fatal("expected methods in the surface descriptor")
	}

	cpType := reflect.TypeOf(testClient(t).ControlPoints())
	var offenders []string
	for _, m := range d.Methods {
		goName := goCase(m.Name)
		method, ok := cpType.MethodByName(goName)
		if !ok {
			offenders = append(offenders, goName+": missing")
			continue
		}
		// reflect.Type.Method (obtained from the pointer TYPE, not a bound
		// value) counts the receiver as NumIn()'s first parameter — hence
		// +1 against the descriptor's own arg count.
		wantArity := len(m.Args) + 1
		if method.Type.NumIn() != wantArity {
			offenders = append(offenders, goName+
				": expected arity "+strconv.Itoa(wantArity)+" (receiver + "+strconv.Itoa(len(m.Args))+" args), got "+strconv.Itoa(method.Type.NumIn()))
		}
	}
	if len(offenders) != 0 {
		t.Errorf("arity mismatches: %v", offenders)
	}
}

func TestTheDeprecatedFlagsAliasSharesIdentityWithControlPoints(t *testing.T) {
	d := loadDescriptor(t)
	if d.Namespace.DeprecatedAlias != "flags" {
		t.Fatalf("deprecatedAlias = %q, want flags", d.Namespace.DeprecatedAlias)
	}
	if !d.Namespace.AliasMustShareIdentity {
		t.Fatal("aliasMustShareIdentity must be true")
	}

	c := testClient(t)
	if c.ControlPoints() != c.Flags() {
		t.Fatal("Client.Flags() must return the identical *ControlPoints as Client.ControlPoints()")
	}
}

func TestDetailsReturnsADecisionValueReturnsTheBareValue(t *testing.T) {
	c := testClient(t)
	value := c.ControlPoints().GetBooleanValue("absent", false, nil)
	details := c.ControlPoints().GetBooleanDetails("absent", false, nil)

	if value != false {
		t.Errorf("value = %v, want false", value)
	}
	if details.Value != false {
		t.Errorf("details.Value = %v, want false", details.Value)
	}
	if details.FlagKey != "absent" {
		t.Errorf("details.FlagKey = %q, want absent", details.FlagKey)
	}
	if details.Reason == "" {
		t.Error("details.Reason must be set")
	}
}

func TestRegisterTargetExistsWithLocalModeRecordedAndTraced(t *testing.T) {
	d := loadDescriptor(t)
	var entry *surfaceMethod
	for i := range d.Client.Methods {
		if d.Client.Methods[i].Name == "registerTarget" {
			entry = &d.Client.Methods[i]
		}
	}
	if entry == nil {
		t.Fatal("registerTarget must be declared under client.methods")
	}
	if entry.LocalMode != "recorded-and-traced" {
		t.Fatalf("registerTarget.localMode = %q, want recorded-and-traced", entry.LocalMode)
	}

	clientType := reflect.TypeOf(testClient(t))
	if _, ok := clientType.MethodByName("RegisterTarget"); !ok {
		t.Fatal("Client must expose a RegisterTarget method")
	}

	c := testClient(t)
	res := c.RegisterTarget("user_1", nil)
	if !res.OK {
		t.Fatalf("local mode registerTarget must resolve ok:true, got %+v", res)
	}
}

func TestMustNotExposeCutNamespacesAsMethods(t *testing.T) {
	d := loadDescriptor(t)
	clientType := reflect.TypeOf(testClient(t))
	productNamespaces := map[string]bool{
		"releases": true, "exposures": true, "signals": true, "capabilities": true, "guardrails": true,
	}

	var offenders []string
	for _, name := range d.Client.MustNotExpose {
		if productNamespaces[name] {
			for i := 0; i < clientType.NumMethod(); i++ {
				if strings.EqualFold(clientType.Method(i).Name, name) {
					offenders = append(offenders, name+" exposed on Client")
				}
			}
			continue
		}
		// Cut OpenFeature provider types: the package they used to live in
		// must not exist at all under go.
		if _, err := os.Stat(filepath.Join(sdkGoRoot(t), "openfeature")); err == nil {
			offenders = append(offenders, name+": go/openfeature must not exist")
		}
	}
	if len(offenders) != 0 {
		t.Errorf("v1 scope violations: %v", offenders)
	}
}

func TestMustNotExposeListMatchesTheFixedV1ScopeBoundary(t *testing.T) {
	d := loadDescriptor(t)
	want := []string{"releases", "exposures", "signals", "capabilities", "guardrails", "FireweaveProvider", "FireweaveWebProvider"}
	if !reflect.DeepEqual(d.Client.MustNotExpose, want) {
		t.Fatalf("mustNotExpose = %v, want %v", d.Client.MustNotExpose, want)
	}
}

func TestCompatibilityCellIsGreenForGo(t *testing.T) {
	d := loadDescriptor(t)
	if got := d.Compatibility["go"]; got != "green" {
		t.Fatalf(`compatibility.go = %q, want "green"`, got)
	}
}
