package fw

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/fireweave"
)

// Start, the singleton and the package facade (state.go, fw.go). Mirrors
// node's test/unit/start-facade.test.ts. These tests share the process-wide
// singleton, so none of them runs in parallel; each starts from
// resetForTests.

// recorder is a slog.Handler that keeps every message.
type recorder struct {
	mu    sync.Mutex
	lines []string
}

func (r *recorder) Enabled(context.Context, slog.Level) bool { return true }
func (r *recorder) Handle(_ context.Context, rec slog.Record) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, rec.Level.String()+" "+rec.Message)
	return nil
}
func (r *recorder) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recorder) WithGroup(string) slog.Handler      { return r }

func (r *recorder) count(substr string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, l := range r.lines {
		if strings.Contains(l, substr) {
			n++
		}
	}
	return n
}

func (r *recorder) all() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}

// fresh resets the singleton, routes its default log sink to a recorder (so
// implicit starts are observable) and resets again after the test.
func fresh(t *testing.T) (*recorder, *slog.Logger) {
	t.Helper()
	resetForTests()
	t.Cleanup(resetForTests)
	rec := &recorder{}
	logger := slog.New(rec)
	st.mu.Lock()
	st.logger = logger
	st.mu.Unlock()
	return rec, logger
}

// clearProcessEnv makes the process environment empty for every name the
// start profile reads (empty counts as unset).
func clearProcessEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{"FIREWEAVE_KEY", "FIREWEAVE_URL", "FIREWEAVE_ENV", "FIREWEAVE_INSTANCE_ID", "APP_ENV", "FW_PROJECT_API_KEY", "FW_API_URL", "FW_ATTEST_URL", "FW_ENV"} {
		t.Setenv(name, "")
	}
}

var (
	testControlPoints = DefineControlPoints(LocalControlPoints{"new-checkout": {Local: true}, "old-path": {Local: false}})
	devEnv            = envMap(map[string]string{"FIREWEAVE_ENV": "development"})
	noVars            = envMap(nil)
)

func mustStart(t *testing.T, opts Options) {
	t.Helper()
	if err := Start(opts); err != nil {
		t.Fatalf("Start: %v", err)
	}
}

func wantConfiguration(t *testing.T, err error, substr string) {
	t.Helper()
	var fwErr *fireweave.Error
	if !errors.As(err, &fwErr) || fwErr.Kind != fireweave.KindConfiguration {
		t.Fatalf("err = %v (%T), want a Configuration *fireweave.Error", err, err)
	}
	if substr != "" {
		assertContains(t, fwErr.Message, substr)
	}
}

// ---------------------------------------------------------------- local mode

func TestStartLocalServesEachFlagAndLogsOneLocalLine(t *testing.T) {
	rec, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	if !ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("new-checkout must be served true locally")
	}
	if ControlPoints().GetBooleanValue("old-path", true, For("u1")) {
		t.Fatal("old-path must be served false locally")
	}
	d := ControlPoints().GetBooleanDetails("new-checkout", false, For("u1"))
	if d.Reason != fireweave.ReasonStatic || d.Error != nil {
		t.Fatalf("decision = %+v, want STATIC", d)
	}
	if n := rec.count("[fireweave:local] Local mode (no FIREWEAVE_KEY; environment \"development\" from FIREWEAVE_ENV). Serving 2 control points"); n != 1 {
		t.Fatalf("local line logged %d times:\n%s", n, rec.all())
	}
}

func TestLocalReadOfAnUndeclaredKeyGetsTheDefaultAndWarnsOnce(t *testing.T) {
	rec, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	for _, user := range []string{"u1", "u2", "u3"} {
		if ControlPoints().GetBooleanValue("not-declared", false, For(user)) {
			t.Fatal("an undeclared key must get its default")
		}
	}
	if n := rec.count(`"not-declared" is not in your control points (internal/fireweave/control_points.go)`); n != 1 {
		t.Fatalf("missing-key warning logged %d times:\n%s", n, rec.all())
	}
}

func TestModeLocalNeedsNoEnvironmentName(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Mode: ModeLocal, Env: noVars, Log: log})
	if s := Status(); s.ModeSource != "option" || s.Mode != ModeLocal {
		t.Fatalf("status = %+v", s)
	}
	if !ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("new-checkout must be served true")
	}
}

func TestControlPointsIsTheCoreNamespaceOnThePermanentClient(t *testing.T) {
	fresh(t)
	if ControlPoints() != Client().ControlPoints() || Client() == nil {
		t.Fatal("ControlPoints() must be Client().ControlPoints()")
	}
	if reflect.TypeOf(ControlPoints()) != reflect.TypeOf(&fireweave.ControlPoints{}) {
		t.Fatalf("ControlPoints() type = %T, want *fireweave.ControlPoints", ControlPoints())
	}
}

// ---------------------------------------------------------------- idempotency

func TestASecondIdenticalStartIsANoOp(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
}

func TestASecondStartWithDifferentFlagsIsAConflict(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	err := Start(Options{ControlPoints: LocalControlPoints{"new-checkout": {Local: false}}, Env: devEnv, Log: log})
	wantConfiguration(t, err, "different configuration (controlPoints)")
	if !ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("a conflicting Start must leave the running client alone")
	}
}

func TestADifferentKeyIsAConflictButTheLogSinkIsNot(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{Key: testKey, Env: noVars, Log: log})
	mustStart(t, Options{Key: testKey, Env: noVars, Log: slog.New(&recorder{})})
	err := Start(Options{Key: "project-api-key_other", Env: noVars, Log: log})
	wantConfiguration(t, err, "different configuration (key)")
	assertNotContains(t, err.Error(), "other")
	assertNotContains(t, err.Error(), "abc123")
}

func TestTheFirstStartKeepsItsLogSink(t *testing.T) {
	rec, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	other := &recorder{}
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: slog.New(other)})
	ControlPoints().GetBooleanValue("not-declared", false, For("u1"))
	if rec.count(`"not-declared"`) != 1 || other.all() != "" {
		t.Fatalf("first sink:\n%s\nsecond sink:\n%s", rec.all(), other.all())
	}
}

func TestBadConfigFailsStartAndReadsServeDefaults(t *testing.T) {
	_, log := fresh(t)
	err := Start(Options{ControlPoints: testControlPoints, Env: envMap(map[string]string{"APP_ENV": "production"}), Log: log})
	wantConfiguration(t, err, "FIREWEAVE_KEY is not set")
	if ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("a failed start must serve the default")
	}
	d := ControlPoints().GetBooleanDetails("new-checkout", false, For("u1"))
	if d.Reason != fireweave.ReasonError || d.Error == nil || d.Error.Kind != fireweave.KindConfiguration || d.Value != false {
		t.Fatalf("decision = %+v, want ERROR/Configuration with the default", d)
	}
	if s := Status(); s.State != StateFailed || !strings.Contains(s.Error, "FIREWEAVE_KEY is not set") {
		t.Fatalf("status = %+v", s)
	}
	// A corrected Start recovers.
	mustStart(t, Options{ControlPoints: testControlPoints, Mode: ModeLocal, Env: noVars, Log: log})
	if !ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("a corrected Start must recover")
	}
}

func TestMustStartPanicsWithTheConfigurationError(t *testing.T) {
	_, log := fresh(t)
	defer func() {
		err, ok := recover().(error)
		if !ok {
			t.Fatal("MustStart must panic with an error")
		}
		wantConfiguration(t, err, "FIREWEAVE_KEY is not set")
	}()
	MustStart(Options{Env: noVars, Log: log})
}

func TestASuccessfulStartReturnsAnUntypedNil(t *testing.T) {
	_, log := fresh(t)
	// A typed nil *fireweave.Error in the error interface would be != nil.
	if err := Start(Options{Mode: ModeLocal, Env: noVars, Log: log}); err != nil {
		t.Fatalf("err = %#v, want untyped nil", err)
	}
}

// ---------------------------------------------------------------- reads before Start

func TestAReadBeforeStartStartsFromTheProcessEnvironment(t *testing.T) {
	rec, _ := fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_ENV", "development")
	if ControlPoints().GetBooleanValue("anything", false, For("u1")) {
		t.Fatal("an undeclared key must get its default")
	}
	s := Status()
	if s.State != StateReady || s.Mode != ModeLocal || s.ModeSource != "environment" {
		t.Fatalf("status = %+v", s)
	}
	if rec.count("[fireweave:local] Local mode") != 1 {
		t.Fatalf("implicit local start must log its line:\n%s", rec.all())
	}
}

func TestAnExplicitStartAfterAnImplicitOneIsANoOpWhenItAgrees(t *testing.T) {
	_, log := fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_KEY", testKey)
	ControlPoints().GetBooleanValue("anything", false, nil) // implicit remote start; nil context degrades locally, no I/O
	// LocalControlPoints do not count in remote mode, so this agrees with the env-only start.
	mustStart(t, Options{ControlPoints: testControlPoints, Log: log})
}

func TestAnExplicitStartThatDisagreesWithAnImplicitOneSaysWhy(t *testing.T) {
	_, log := fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_ENV", "development")
	ControlPoints().GetBooleanValue("new-checkout", false, For("u1"))
	err := Start(Options{ControlPoints: testControlPoints, Log: log})
	wantConfiguration(t, err, "read before fw.Start ran")
}

func TestAFailedImplicitStartServesDefaultsAndNeverPanics(t *testing.T) {
	rec, log := fresh(t)
	clearProcessEnv(t)
	t.Setenv("APP_ENV", "production")
	if ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("must serve the default")
	}
	if ControlPoints().GetStringValue("theme", "light", For("u1")) != "light" {
		t.Fatal("must serve the default")
	}
	if ControlPoints().GetNumberValue("limit", 7, For("u1")) != 7 {
		t.Fatal("must serve the default")
	}
	obj := map[string]any{"a": 1.0}
	if !reflect.DeepEqual(ControlPoints().GetObjectValue("cfg", obj, For("u1")), obj) {
		t.Fatal("must serve the default")
	}
	for _, d := range []fireweave.Decision{
		ControlPoints().GetBooleanDetails("new-checkout", false, For("u1")),
		ControlPoints().GetStringDetails("theme", "light", For("u1")),
		ControlPoints().GetNumberDetails("limit", 7.0, For("u1")),
		ControlPoints().GetObjectDetails("cfg", obj, For("u1")),
		ControlPoints().Evaluate("new-checkout", fireweave.FlagTypeBoolean, false, For("u1"), nil),
	} {
		if d.Reason != fireweave.ReasonError || d.Error == nil || d.Error.Kind != fireweave.KindConfiguration {
			t.Fatalf("decision = %+v, want ERROR/Configuration", d)
		}
		if d.Metadata[fireweave.MetaErrorKind] != "Configuration" {
			t.Fatalf("metadata = %v", d.Metadata)
		}
	}
	if s := Status(); s.State != StateFailed {
		t.Fatalf("status = %+v", s)
	}
	if err := Identify(context.Background(), "u1", nil); err == nil {
		t.Fatal("Identify must report the start failure")
	}
	if n := rec.count("FIREWEAVE_KEY is not set"); n != 1 {
		t.Fatalf("start failure logged %d times:\n%s", n, rec.all())
	}
	// An explicit Start recovers.
	mustStart(t, Options{ControlPoints: testControlPoints, Mode: ModeLocal, Env: noVars, Log: log})
	if !ControlPoints().GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("an explicit Start must recover after a failed implicit one")
	}
}

func TestACapturedClientWorksAcrossStartShutdownAndRestart(t *testing.T) {
	_, log := fresh(t)
	captured := Client()
	cp := captured.ControlPoints()
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	if !cp.GetBooleanValue("new-checkout", false, For("u1")) {
		t.Fatal("a pointer captured before Start must read after it")
	}
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := cp.GetBooleanDetails("new-checkout", false, For("u1"))
	if d.Value != false || d.Error == nil || d.Error.Kind != fireweave.KindAlreadyClosed {
		t.Fatalf("after Shutdown: %+v, want the default with AlreadyClosed", d)
	}
	if Status().State != StateShutdown {
		t.Fatalf("status = %+v", Status())
	}
	mustStart(t, Options{ControlPoints: LocalControlPoints{"new-checkout": {Local: false}}, Env: devEnv, Log: log})
	if cp.GetBooleanValue("new-checkout", true, For("u1")) {
		t.Fatal("a Start after Shutdown begins fresh, with its own controlPoints")
	}
	if Client() != captured {
		t.Fatal("Client() must be the same pointer for the life of the process")
	}
}

func TestNoImplicitStartAfterShutdown(t *testing.T) {
	fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_ENV", "development")
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := ControlPoints().GetBooleanDetails("x", false, For("u1"))
	if d.Error == nil || d.Error.Kind != fireweave.KindAlreadyClosed || Status().State != StateShutdown {
		t.Fatalf("decision = %+v status = %+v", d, Status())
	}
}

// ---------------------------------------------------------------- identity, instance key, status

func TestIdentifyRegistersAUserTarget(t *testing.T) {
	rec, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	if err := Identify(context.Background(), "user-1", map[string]any{"plan": "pro"}); err != nil {
		t.Fatalf("Identify: %v", err)
	}
	if rec.count("registerTarget user user-1") != 1 {
		t.Fatalf("local trace missing:\n%s", rec.all())
	}
	if err := Identify(context.Background(), "device-1", nil, IdentifyOptions{Kind: fireweave.TargetKindDevice}); err != nil {
		t.Fatal(err)
	}
	if rec.count("registerTarget device device-1") != 1 {
		t.Fatalf("device trace missing:\n%s", rec.all())
	}
	for _, blank := range []string{"", "  "} {
		err := Identify(context.Background(), blank, nil)
		if !errors.Is(err, fireweave.ErrInvalidContext) {
			t.Fatalf("blank key: err = %v, want InvalidContext", err)
		}
	}
}

func TestInstanceKeyOrder(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{ControlPoints: testControlPoints, Env: envMap(map[string]string{"FIREWEAVE_ENV": "development", "FIREWEAVE_INSTANCE_ID": "worker-7"}), Log: log})
	if got := InstanceKey(); got != "worker-7" {
		t.Fatalf("InstanceKey = %q, want worker-7", got)
	}

	resetForTests()
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, InstanceID: "cron-1", Log: log})
	if got := InstanceKey(); got != "cron-1" {
		t.Fatalf("InstanceKey = %q, want cron-1", got)
	}

	resetForTests()
	mustStart(t, Options{ControlPoints: testControlPoints, Env: devEnv, Log: log})
	key := InstanceKey()
	host := processHostname()
	if host != "" && key != "inst_"+fnv1a64(host) {
		t.Fatalf("InstanceKey = %q, want the host hash", key)
	}
	if !regexp.MustCompile(`^inst_[0-9a-f]{16}([0-9a-f]{16})?$`).MatchString(key) || InstanceKey() != key {
		t.Fatalf("InstanceKey = %q must be inst_<hex> and stable", key)
	}
}

func TestStartRefusesAnInstanceIDThatDiffersFromOneHandedOut(t *testing.T) {
	_, log := fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_INSTANCE_ID", "early")
	if InstanceKey() != "early" {
		t.Fatal("InstanceKey before Start reads the process environment")
	}
	wantConfiguration(t, Start(Options{Mode: ModeLocal, Env: noVars, InstanceID: "late", Log: log}), "InstanceID differs")
	mustStart(t, Options{Mode: ModeLocal, Env: noVars, InstanceID: "early", Log: log})
}

func TestStatusReportsTheDecisionAndNeverTheKey(t *testing.T) {
	_, log := fresh(t)
	mustStart(t, Options{Key: testKey, Env: noVars, Log: log})
	s := Status()
	want := StartStatus{
		State: StateReady, Mode: ModeRemote, ModeSource: "key", Channel: SDKChannel(), SDKVersion: SDKVersion(),
		Host: "app-server.fireweave.ai", EndpointSource: "SDK channel (" + string(SDKChannel()) + ")", KeySource: "Options.Key",
	}
	if s != want {
		t.Fatalf("status = %+v\nwant     %+v", s, want)
	}
	for _, rendered := range []string{fmt.Sprintf("%v", s), fmt.Sprintf("%+v", s), fmt.Sprintf("%#v", s)} {
		assertNotContains(t, rendered, "abc123")
	}
}

func TestStatusBeforeAnyStart(t *testing.T) {
	fresh(t)
	if s := Status(); s.State != StateUnstarted || s.Mode != "" || s.SDKVersion == "" {
		t.Fatalf("status = %+v", s)
	}
}

func TestForMergesAttributesLeftToRight(t *testing.T) {
	ec := For("u1", map[string]any{"plan": "free", "a": 1}, nil, map[string]any{"plan": "pro"})
	if ec.TargetingKey != "u1" || ec.Attributes["plan"] != "pro" || ec.Attributes["a"] != 1 {
		t.Fatalf("For = %+v", ec)
	}
	if For("u2").Attributes != nil {
		t.Fatal("no attributes means nil attributes")
	}
}

// ---------------------------------------------------------------- concurrency

func TestConcurrentReadsStartsAndStatusAreRaceFree(t *testing.T) {
	_, log := fresh(t)
	clearProcessEnv(t)
	t.Setenv("FIREWEAVE_ENV", "development")
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				ControlPoints().GetBooleanValue("new-checkout", false, For("u1"))
				_ = Status()
				_ = InstanceKey()
				_ = Identify(context.Background(), "u1", nil)
			}
		}()
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// The implicit start (no control points) and this one may race; whichever
			// loses gets a Configuration conflict, never a crash.
			_ = Start(Options{Log: log})
		}()
	}
	wg.Wait()
	if Status().State != StateReady {
		t.Fatalf("status = %+v", Status())
	}
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
