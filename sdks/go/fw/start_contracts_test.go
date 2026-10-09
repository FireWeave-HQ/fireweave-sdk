package fw

// The shared start-profile suite (contracts/start/, spec/start-profile.md) on
// Go. Drives the pure resolver, the instance-key derivation with an injected
// host name, DefineControlPoints and channelForVersion with each case's inputs,
// compares by the rules in contracts/start/README.md, and writes
// fw/compatibility-report.start.go.json (gitignored). A port of node's
// test/unit/start-contracts.test.ts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/fireweave"
)

const startLang = "go"

var (
	startContractsDir = filepath.Join("..", "..", "..", "contracts", "start")
	startReportPath   = "compatibility-report.start.go.json"
)

type startOptions struct {
	Key         *string `json:"key"`
	URL         *string `json:"url"`
	Environment *string `json:"environment"`
	Mode        *string `json:"mode"`
	InstanceID  *string `json:"instanceId"`
}

type startWhen struct {
	Operation     string                     `json:"operation"`
	Options       startOptions               `json:"options"`
	Env           map[string]string          `json:"env"`
	Build         map[string]string          `json:"build"`
	Channel       string                     `json:"channel"`
	HostName      *string                    `json:"hostName"`
	ControlPoints map[string]json.RawMessage `json:"controlPoints"`
	Version       *string                    `json:"version"`
}

type startCase struct {
	Name      string                     `json:"name"`
	AppliesTo []string                   `json:"appliesTo"`
	When      startWhen                  `json:"when"`
	Expect    map[string]json.RawMessage `json:"expect"`
}

type startFixture struct {
	ID            string            `json:"id"`
	Profile       string            `json:"profile"`
	Cases         []startCase       `json:"cases"`
	Compatibility map[string]string `json:"compatibility"`
}

func loadStartFixtures(t *testing.T) []startFixture {
	t.Helper()
	entries, err := os.ReadDir(startContractsDir)
	if err != nil {
		t.Fatalf("read %s: %v", startContractsDir, err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && e.Name() != "start-fixture.schema.json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	out := make([]startFixture, 0, len(names))
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(startContractsDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		var fx startFixture
		if err := json.Unmarshal(raw, &fx); err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		out = append(out, fx)
	}
	return out
}

// startKnownNames are the variable names a source may carry as-is
// (contracts/start/README.md "Comparing results").
var startKnownNames = map[string]bool{
	"FIREWEAVE_KEY": true, "FIREWEAVE_URL": true, "FIREWEAVE_ENV": true, "APP_ENV": true,
	"FW_PROJECT_API_KEY": true, "FW_API_URL": true, "FW_ATTEST_URL": true,
}

// normaliseStartSource maps an SDK source onto the suite's vocabulary:
// variable names stay, any Options.* field is "option", the default endpoint
// is "channel", no key is "none". "" (not set) stays nil.
func normaliseStartSource(source string) any {
	switch {
	case source == "":
		return nil
	case source == "none":
		return "none"
	case strings.HasPrefix(source, "SDK channel"):
		return "channel"
	case startKnownNames[source]:
		return source
	}
	return "option"
}

type startOutcome struct {
	fields   map[string]any
	warnings []string
	err      *fireweave.Error
}

func optString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func runStartResolve(c startCase) (startOutcome, error) {
	o := c.When.Options
	opts := Options{
		Mode:        Mode(optString(o.Mode)),
		Environment: optString(o.Environment),
		URL:         optString(o.URL),
		Key:         optString(o.Key),
	}
	envBag := c.When.Env
	lookup := envLookup(func(name string) string { return envBag[name] })
	channel := ChannelProduction
	switch c.When.Channel {
	case "", "production":
	case "staging":
		channel = ChannelStaging
	default:
		return startOutcome{}, fmt.Errorf("unknown channel %q", c.When.Channel)
	}
	r, err := resolve(opts, lookup, buildInfo{version: "v0.0.0-contract", channel: channel})
	if err != nil {
		return startOutcome{err: err}, nil
	}
	var hosts any
	if r.allowedHosts != nil {
		hosts = append([]string(nil), r.allowedHosts...)
	}
	fields := map[string]any{
		"mode":              string(r.mode),
		"modeSource":        r.modeSource,
		"url":               nilIfEmpty(r.url),
		"urlSource":         normaliseStartSource(r.urlSource),
		"allowedHosts":      hosts,
		"keySource":         normaliseStartSource(r.keySource),
		"environment":       nilIfEmpty(r.environment),
		"environmentSource": normaliseStartSource(r.environmentSource),
	}
	return startOutcome{fields: fields, warnings: append([]string(nil), r.warnings...)}, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func runStartInstanceKey(c startCase) (startOutcome, error) {
	envBag := c.When.Env
	lookup := envLookup(func(name string) string { return envBag[name] })
	host := func() string { return optString(c.When.HostName) } // null: unavailable
	value, _ := deriveInstanceKey(optString(c.When.Options.InstanceID), lookup, host)
	return startOutcome{fields: map[string]any{"value": value}}, nil
}

type startFlagJSON struct {
	Local       *bool   `json:"local"`
	Description *string `json:"description"`
}

// runStartDefineControlPoints translates the canonical controlPoints object to fw.LocalControlPoints.
// A shape Go cannot express (non-boolean local, ...) is a runner error: those
// cases live in start-flags-untyped, which Go marks not-applicable.
func runStartDefineControlPoints(c startCase) (out startOutcome, rerr error) {
	controlPoints := make(LocalControlPoints, len(c.When.ControlPoints))
	for key, raw := range c.When.ControlPoints {
		var f startFlagJSON
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f); err != nil || f.Local == nil {
			return startOutcome{}, fmt.Errorf("flag %q has a shape Go cannot express: %s", key, raw)
		}
		controlPoints[key] = LocalControlPoint{Local: *f.Local, Description: optString(f.Description)}
	}
	defer func() {
		if p := recover(); p != nil {
			var fe *fireweave.Error
			if e, ok := p.(error); ok && errors.As(e, &fe) {
				out, rerr = startOutcome{err: fe}, nil
				return
			}
			panic(p)
		}
	}()
	DefineControlPoints(controlPoints)
	return startOutcome{fields: map[string]any{"ok": true}}, nil
}

func runStartChannelForVersion(c startCase) (startOutcome, error) {
	if c.When.Version == nil {
		return startOutcome{}, errors.New("channelForVersion needs a version")
	}
	return startOutcome{fields: map[string]any{"channel": string(channelForVersion(*c.When.Version))}}, nil
}

func runStartCase(c startCase) (startOutcome, error) {
	switch c.When.Operation {
	case "resolve":
		return runStartResolve(c)
	case "instanceKey":
		return runStartInstanceKey(c)
	case "defineControlPoints":
		return runStartDefineControlPoints(c)
	case "channelForVersion":
		return runStartChannelForVersion(c)
	}
	return startOutcome{}, fmt.Errorf("operation %s is not applicable to %s", c.When.Operation, startLang)
}

type startNames struct {
	Mention        []string `json:"mention"`
	MustNotMention []string `json:"mustNotMention"`
}

type startErrorExpect struct {
	Kind           string   `json:"kind"`
	Mentions       []string `json:"mentions"`
	MustNotMention []string `json:"mustNotMention"`
}

// compareStart returns the differences; empty when the case passes.
func compareStart(expect map[string]json.RawMessage, out startOutcome) []string {
	var diffs []string
	if raw, ok := expect["error"]; ok {
		var want startErrorExpect
		if err := json.Unmarshal(raw, &want); err != nil {
			return []string{"bad error expectation: " + err.Error()}
		}
		if out.err == nil {
			got, _ := json.Marshal(out.fields)
			return []string{fmt.Sprintf("expected a %s error, got %s", want.Kind, got)}
		}
		if string(out.err.Kind) != want.Kind {
			diffs = append(diffs, fmt.Sprintf("error kind %s, expected %s", out.err.Kind, want.Kind))
		}
		for _, n := range want.Mentions {
			if !strings.Contains(out.err.Message, n) {
				diffs = append(diffs, fmt.Sprintf("error does not mention %s: %s", n, out.err.Message))
			}
		}
		for _, n := range want.MustNotMention {
			if strings.Contains(out.err.Message, n) {
				diffs = append(diffs, "error mentions "+n)
			}
		}
		return diffs
	}
	if out.err != nil {
		return []string{fmt.Sprintf("unexpected %s error: %s", out.err.Kind, out.err.Message)}
	}
	fields := make([]string, 0, len(expect))
	for f := range expect {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	for _, field := range fields {
		raw := expect[field]
		switch field {
		case "warnings":
			var w startNames
			if err := json.Unmarshal(raw, &w); err != nil {
				diffs = append(diffs, "bad warnings expectation: "+err.Error())
				continue
			}
			for _, n := range w.Mention {
				if !anyContains(out.warnings, n) {
					diffs = append(diffs, "no warning mentions "+n)
				}
			}
			for _, n := range w.MustNotMention {
				if anyContains(out.warnings, n) {
					diffs = append(diffs, "a warning mentions "+n)
				}
			}
			continue
		case "prefix":
			var want string
			_ = json.Unmarshal(raw, &want)
			v, _ := out.fields["value"].(string)
			if !strings.HasPrefix(v, want) {
				diffs = append(diffs, fmt.Sprintf("value %s does not start with %s", v, want))
			}
			continue
		}
		var want any
		if err := json.Unmarshal(raw, &want); err != nil {
			diffs = append(diffs, fmt.Sprintf("bad %s expectation: %v", field, err))
			continue
		}
		got := out.fields[field]
		if field == "allowedHosts" {
			if wantList, ok := want.([]any); ok {
				gotList, _ := got.([]string)
				if got == nil || !sameStringSet(wantList, gotList) {
					diffs = append(diffs, fmt.Sprintf("allowedHosts %s, expected %s", jsonText(got), raw))
				}
				continue
			}
		}
		// Round-trip through JSON so typed and decoded values compare alike.
		var gotNorm any
		_ = json.Unmarshal([]byte(jsonText(got)), &gotNorm)
		if !reflect.DeepEqual(gotNorm, want) {
			diffs = append(diffs, fmt.Sprintf("%s %s, expected %s", field, jsonText(got), raw))
		}
	}
	return diffs
}

func anyContains(lines []string, name string) bool {
	for _, l := range lines {
		if strings.Contains(l, name) {
			return true
		}
	}
	return false
}

func sameStringSet(want []any, got []string) bool {
	a := map[string]bool{}
	for _, w := range want {
		s, ok := w.(string)
		if !ok {
			return false
		}
		a[s] = true
	}
	b := map[string]bool{}
	for _, g := range got {
		b[g] = true
	}
	return reflect.DeepEqual(a, b)
}

func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

type startCaseResult struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

type startFixtureResult struct {
	FixtureID string            `json:"fixtureId"`
	Status    string            `json:"status"`
	Cases     []startCaseResult `json:"cases"`
	Message   string            `json:"message"`
}

func appliesToStartLang(c startCase) bool {
	if c.AppliesTo == nil {
		return true
	}
	for _, l := range c.AppliesTo {
		if l == startLang {
			return true
		}
	}
	return false
}

func runStartFixture(fx startFixture) startFixtureResult {
	if fx.Compatibility[startLang] == "not-applicable" {
		return startFixtureResult{FixtureID: fx.ID, Status: "not-applicable", Cases: []startCaseResult{}}
	}
	cases := make([]startCaseResult, 0, len(fx.Cases))
	var failed []string
	for _, c := range fx.Cases {
		if !appliesToStartLang(c) {
			cases = append(cases, startCaseResult{Name: c.Name, Status: "not-applicable"})
			continue
		}
		out, err := runStartCase(c)
		var diffs []string
		if err != nil {
			diffs = []string{"runner: " + err.Error()}
		} else {
			diffs = compareStart(c.Expect, out)
		}
		if len(diffs) == 0 {
			cases = append(cases, startCaseResult{Name: c.Name, Status: "pass"})
			continue
		}
		msg := strings.Join(diffs, "; ")
		cases = append(cases, startCaseResult{Name: c.Name, Status: "fail", Message: msg})
		failed = append(failed, c.Name+": "+msg)
	}
	status := "pass"
	if len(failed) > 0 {
		status = "fail"
	}
	return startFixtureResult{FixtureID: fx.ID, Status: status, Cases: cases, Message: strings.Join(failed, " | ")}
}

func TestStartContracts(t *testing.T) {
	fixtures := loadStartFixtures(t)
	if len(fixtures) < 10 {
		t.Fatalf("expected the shared start-profile suite, found %d fixtures in %s", len(fixtures), startContractsDir)
	}
	results := make([]startFixtureResult, 0, len(fixtures))
	for _, fx := range fixtures {
		results = append(results, runStartFixture(fx))
	}

	report, err := json.MarshalIndent(map[string]any{"language": startLang, "suite": "start", "results": results}, "", "  ")
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	if err := os.WriteFile(startReportPath, append(report, '\n'), 0o644); err != nil {
		t.Fatalf("write %s: %v", startReportPath, err)
	}

	for i, fx := range fixtures {
		if fx.Compatibility[startLang] != "pass" {
			continue
		}
		r := results[i]
		t.Run(fx.ID, func(t *testing.T) {
			if r.Status != "pass" {
				t.Errorf("%s", r.Message)
			}
		})
	}
}
