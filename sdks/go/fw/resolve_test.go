package fw

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// The pure resolver (resolve.go): precedence, the mode rule, the endpoint
// from the channel, key families and controlPoints. Mirrors node's
// test/unit/start-resolve.test.ts row for row.

var (
	prodBuild    = buildInfo{version: "v2.4.0", channel: ChannelProduction}
	stagingBuild = buildInfo{version: "v2.4.0-staging.3", channel: ChannelStaging}
)

const testKey = "project-api-key_abc123"

// vendorPrefix builds an analytics-vendor key prefix without writing one as a
// literal (the core redactor and the repo's vendor-leak guards look for them).
func vendorPrefix(letter string) string { return "ph" + letter + "_" }

func envMap(m map[string]string) func(string) string {
	return func(name string) string { return m[name] }
}

func env(m map[string]string) lookupFunc { return envLookup(envMap(m)) }

// noEnv fails the test if the resolver reads any variable.
func noEnv(t *testing.T) lookupFunc {
	return func(name string) string {
		t.Helper()
		t.Fatalf("unexpected env read: %s", name)
		return ""
	}
}

// noEnvAfterKey allows only the URL variables: with the key from Options,
// the resolver must not read FIREWEAVE_KEY or an environment name.
func noEnvAfterKey(t *testing.T) lookupFunc {
	return func(name string) string {
		t.Helper()
		switch name {
		case envURL, "FW_API_URL", "FW_ATTEST_URL":
			return ""
		}
		t.Fatalf("unexpected env read: %s", name)
		return ""
	}
}

func mustResolve(t *testing.T, opts Options, lookup lookupFunc, build buildInfo) resolved {
	t.Helper()
	r, err := resolve(opts, lookup, build)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return r
}

func configMessage(t *testing.T, opts Options, lookup lookupFunc, build buildInfo) string {
	t.Helper()
	_, err := resolve(opts, lookup, build)
	if err == nil {
		t.Fatal("expected a Configuration error")
	}
	if err.Kind != fireweave.KindConfiguration {
		t.Fatalf("kind = %s, want Configuration", err.Kind)
	}
	if !errors.Is(err, fireweave.ErrConfiguration) {
		t.Fatal("errors.Is(err, fireweave.ErrConfiguration) must hold")
	}
	return err.Message
}

func assertContains(t *testing.T, s, substr string) {
	t.Helper()
	if !strings.Contains(s, substr) {
		t.Fatalf("%q does not contain %q", s, substr)
	}
}

func assertNotContains(t *testing.T, s, substr string) {
	t.Helper()
	if strings.Contains(s, substr) {
		t.Fatalf("%q must not contain %q", s, substr)
	}
}

// ---------------------------------------------------------------- mode: explicit

func TestResolveModeRemoteWithKeyIsRemote(t *testing.T) {
	r := mustResolve(t, Options{Mode: ModeRemote, Key: testKey}, env(map[string]string{"FIREWEAVE_ENV": "development"}), prodBuild)
	if r.mode != ModeRemote || r.modeSource != modeSourceOption {
		t.Fatalf("mode = %s (%s), want remote (option)", r.mode, r.modeSource)
	}
}

func TestResolveModeRemoteWithoutKeyNamesFireweaveKey(t *testing.T) {
	msg := configMessage(t, Options{Mode: ModeRemote}, env(nil), prodBuild)
	assertContains(t, msg, `Options.Mode "remote" needs a key`)
	assertContains(t, msg, "FIREWEAVE_KEY")
}

func TestResolveModeLocalIgnoresAKeyWithAWarning(t *testing.T) {
	r := mustResolve(t, Options{Mode: ModeLocal}, env(map[string]string{"FIREWEAVE_KEY": testKey, "APP_ENV": "production"}), prodBuild)
	if r.mode != ModeLocal || r.modeSource != modeSourceOption {
		t.Fatalf("mode = %s (%s), want local (option)", r.mode, r.modeSource)
	}
	if r.key != "" || r.url != "" || r.keySource != "none" {
		t.Fatalf("local mode must carry no key or url: %+v", r)
	}
	assertContains(t, strings.Join(r.warnings, "\n"), "ignores the key from FIREWEAVE_KEY")
}

func TestResolveUnknownModeIsRejected(t *testing.T) {
	assertContains(t, configMessage(t, Options{Mode: "auto"}, env(nil), prodBuild), `must be "remote" or "local"`)
}

// ---------------------------------------------------------------- mode: inference

func TestResolveKeyMeansRemoteWhateverTheEnvironmentSays(t *testing.T) {
	lookup := func(name string) string {
		switch name {
		case envKey:
			return testKey
		case envEnvironment, "APP_ENV":
			t.Fatalf("with a key the environment name must not be read (%s)", name)
		}
		return ""
	}
	r := mustResolve(t, Options{}, lookup, prodBuild)
	if r.mode != ModeRemote || r.modeSource != modeSourceKey || r.environment != "" {
		t.Fatalf("got %s (%s) env %q, want remote (key) and no environment", r.mode, r.modeSource, r.environment)
	}
}

func TestResolveNoKeyAndADevEnvironmentMeansLocal(t *testing.T) {
	for _, name := range []string{"development", "dev", "local", "test", "Development", " LOCAL ", "TEST"} {
		r := mustResolve(t, Options{}, env(map[string]string{"APP_ENV": name}), prodBuild)
		if r.mode != ModeLocal || r.modeSource != modeSourceEnvironment {
			t.Fatalf("%q: got %s (%s), want local (environment)", name, r.mode, r.modeSource)
		}
	}
}

func TestResolveEnvironmentOptionBeatsTheVariables(t *testing.T) {
	r := mustResolve(t, Options{Environment: "dev"}, env(map[string]string{"FIREWEAVE_ENV": "production", "APP_ENV": "production"}), prodBuild)
	if r.mode != ModeLocal || r.environmentSource != "Options.Environment" {
		t.Fatalf("got %s from %q", r.mode, r.environmentSource)
	}
}

func TestResolveFireweaveEnvBeatsAppEnv(t *testing.T) {
	r := mustResolve(t, Options{}, env(map[string]string{"FIREWEAVE_ENV": "dev", "APP_ENV": "prod"}), prodBuild)
	if r.environmentSource != "FIREWEAVE_ENV" {
		t.Fatalf("source = %q, want FIREWEAVE_ENV", r.environmentSource)
	}
	r = mustResolve(t, Options{}, env(map[string]string{"APP_ENV": "dev"}), prodBuild)
	if r.environmentSource != "APP_ENV" || r.environment != "dev" {
		t.Fatalf("source = %q (%q), want APP_ENV (dev)", r.environmentSource, r.environment)
	}
}

func TestResolveNodeEnvIsNotAGoEnvironmentName(t *testing.T) {
	msg := configMessage(t, Options{}, env(map[string]string{"NODE_ENV": "development", "GO_ENV": "dev", "ENV": "dev"}), prodBuild)
	assertContains(t, msg, "no environment name is set")
}

func TestResolveNoKeyAndANonDevEnvironmentFailsClosed(t *testing.T) {
	msg := configMessage(t, Options{}, env(map[string]string{"APP_ENV": "prod"}), prodBuild)
	assertContains(t, msg, "FIREWEAVE_KEY is not set")
	assertContains(t, msg, `"prod" (from APP_ENV)`)
}

func TestResolveNoKeyAndNoEnvironmentFailsClosed(t *testing.T) {
	msg := configMessage(t, Options{}, env(nil), prodBuild)
	assertContains(t, msg, "no environment name is set (checked Options.Environment, FIREWEAVE_ENV and APP_ENV)")
}

func TestResolvePointsAtFireweaveEnvWhenOnlyFwEnvIsSet(t *testing.T) {
	assertContains(t, configMessage(t, Options{}, env(map[string]string{"FW_ENV": "dev"}), prodBuild), "FW_ENV is no longer read; rename it to FIREWEAVE_ENV")
}

func TestResolveEmptyAndWhitespaceCountAsUnset(t *testing.T) {
	r := mustResolve(t, Options{Key: "  ", Environment: " "}, env(map[string]string{"FIREWEAVE_KEY": "", "FIREWEAVE_ENV": "   ", "APP_ENV": "test"}), prodBuild)
	if r.mode != ModeLocal || r.environmentSource != "APP_ENV" {
		t.Fatalf("got %s from %q, want local from APP_ENV", r.mode, r.environmentSource)
	}
}

func TestResolveNeverEchoesAKeyShapedEnvironmentName(t *testing.T) {
	msg := configMessage(t, Options{}, env(map[string]string{"APP_ENV": "project-api-key_leaked"}), prodBuild)
	assertNotContains(t, msg, "leaked")
	assertContains(t, msg, "from APP_ENV")
}

// ---------------------------------------------------------------- endpoint

func TestResolveProductionBuildCallsAppServer(t *testing.T) {
	r := mustResolve(t, Options{Key: testKey}, noEnvAfterKey(t), prodBuild)
	if r.url != "https://app-server.fireweave.ai" || r.allowedHosts != nil {
		t.Fatalf("url = %q hosts = %v", r.url, r.allowedHosts)
	}
	if r.urlSource != "SDK channel (production)" {
		t.Fatalf("urlSource = %q", r.urlSource)
	}
}

func TestResolveStagingBuildCallsStagingAppServer(t *testing.T) {
	r := mustResolve(t, Options{Key: testKey}, noEnvAfterKey(t), stagingBuild)
	if r.url != "https://staging-app-server.fireweave.ai" || r.channel != ChannelStaging {
		t.Fatalf("url = %q channel = %s", r.url, r.channel)
	}
}

// Both channel hosts must be in the core remote adapter's default allowlist,
// or the default endpoint would fail fireweave.Init.
func TestChannelHostsPassTheCoreDefaultAllowlist(t *testing.T) {
	for channel, u := range channelURLs {
		client, err := fireweave.Init(fireweave.Options{Mode: fireweave.ModeRemote, APIKey: testKey, APIURL: u})
		if err != nil {
			t.Fatalf("%s endpoint %s rejected by the core: %v", channel, u, err)
		}
		_ = client.Runtime().Shutdown(context.Background())
	}
}

func TestResolveURLOptionWinsAndTheAllowlistFollowsIt(t *testing.T) {
	r := mustResolve(t, Options{Key: testKey, URL: "https://Flags.Example.com/"}, noEnv(t), stagingBuild)
	if r.url != "https://Flags.Example.com" || r.urlSource != "Options.URL" {
		t.Fatalf("url = %q from %q", r.url, r.urlSource)
	}
	want := []string{"flags.example.com", "localhost", "127.0.0.1", "::1"}
	if !reflect.DeepEqual(r.allowedHosts, want) {
		t.Fatalf("allowedHosts = %v, want %v", r.allowedHosts, want)
	}
}

func TestResolveFireweaveURLBeatsTheLegacyNames(t *testing.T) {
	r := mustResolve(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": testKey, "FIREWEAVE_URL": "https://a.example.com", "FW_API_URL": "https://b.example.com"}), prodBuild)
	if r.url != "https://a.example.com" || len(r.warnings) != 0 {
		t.Fatalf("url = %q warnings = %v", r.url, r.warnings)
	}
}

func TestResolveLegacyURLNamesAreReadWithAWarning(t *testing.T) {
	r := mustResolve(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": testKey, "FW_ATTEST_URL": "https://c.example.com"}), prodBuild)
	if r.url != "https://c.example.com" || r.urlSource != "FW_ATTEST_URL" {
		t.Fatalf("url = %q from %q", r.url, r.urlSource)
	}
	if len(r.warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly one", r.warnings)
	}
	assertContains(t, r.warnings[0], "FW_ATTEST_URL is a legacy name")
	assertContains(t, r.warnings[0], "Rename it to FIREWEAVE_URL")

	r = mustResolve(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": testKey, "FW_API_URL": "https://b.example.com", "FW_ATTEST_URL": "https://c.example.com"}), prodBuild)
	if r.url != "https://b.example.com" {
		t.Fatalf("FW_API_URL must beat FW_ATTEST_URL, got %q", r.url)
	}
}

func TestResolveHTTPIsAllowedOnLoopbackOnly(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"} {
		if r := mustResolve(t, Options{Key: testKey, URL: u}, noEnv(t), prodBuild); r.url != u {
			t.Fatalf("url = %q, want %q", r.url, u)
		}
	}
	msg := configMessage(t, Options{Key: testKey, URL: "http://flags.example.com"}, noEnv(t), prodBuild)
	assertContains(t, msg, "from Options.URL must use https")
	assertNotContains(t, msg, "flags.example.com")
}

func TestResolveAnInvalidURLNamesItsSource(t *testing.T) {
	for _, u := range []string{"not a url", "ftp://flags.example.com", "https://", "://x"} {
		msg := configMessage(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": testKey, "FIREWEAVE_URL": u}), prodBuild)
		assertContains(t, msg, "from FIREWEAVE_URL is not a valid URL")
	}
}

func TestResolveLocalModeResolvesNoEndpoint(t *testing.T) {
	if r := mustResolve(t, Options{Mode: ModeLocal, URL: "https://x.example.com"}, env(nil), prodBuild); r.url != "" {
		t.Fatalf("url = %q, want none", r.url)
	}
}

// ---------------------------------------------------------------- key

func TestResolveKeyOptionBeatsFireweaveKey(t *testing.T) {
	r := mustResolve(t, Options{Key: testKey}, noEnvAfterKey(t), prodBuild)
	if r.key != testKey || r.keySource != "Options.Key" {
		t.Fatalf("key source = %q", r.keySource)
	}
}

func TestResolveFireweaveKeyBeatsTheLegacyName(t *testing.T) {
	r := mustResolve(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": testKey, "FW_PROJECT_API_KEY": "project-api-key_old"}), prodBuild)
	if r.key != testKey || r.keySource != "FIREWEAVE_KEY" || len(r.warnings) != 0 {
		t.Fatalf("key source = %q warnings = %v", r.keySource, r.warnings)
	}
}

func TestResolveLegacyProjectKeyIsReadWithAWarning(t *testing.T) {
	r := mustResolve(t, Options{}, env(map[string]string{"FW_PROJECT_API_KEY": testKey}), prodBuild)
	if r.keySource != "FW_PROJECT_API_KEY" || r.mode != ModeRemote {
		t.Fatalf("key source = %q mode = %s", r.keySource, r.mode)
	}
	assertContains(t, strings.Join(r.warnings, "\n"), "FW_PROJECT_API_KEY is a legacy name")
	assertContains(t, strings.Join(r.warnings, "\n"), "Rename it to FIREWEAVE_KEY")
}

func TestResolveABrowserKeyIsRejectedWithoutPrintingIt(t *testing.T) {
	msg := configMessage(t, Options{}, env(map[string]string{"FIREWEAVE_KEY": "fw_public_secretvalue"}), prodBuild)
	assertContains(t, msg, "The key from FIREWEAVE_KEY is a browser key")
	assertNotContains(t, msg, "secretvalue")
}

func TestResolveVendorOrgAndCLIKeysAreRejected(t *testing.T) {
	for _, letter := range []string{"c", "x", "s"} {
		msg := configMessage(t, Options{Key: vendorPrefix(letter) + "secretvalue"}, noEnv(t), prodBuild)
		assertContains(t, msg, "The key from Options.Key is an analytics vendor key")
		assertNotContains(t, msg, "secretvalue")
	}
	for _, key := range []string{"fw_org_secretvalue", "cli_at_secretvalue"} {
		msg := configMessage(t, Options{Key: key}, noEnv(t), prodBuild)
		assertContains(t, msg, "organisation or CLI token")
		assertNotContains(t, msg, "secretvalue")
	}
}

// The core redactor scrubs values, never a variable name, so a legacy key
// source is named directly in an error.
func TestResolveALegacyKeySourceIsNamedInAnError(t *testing.T) {
	msg := configMessage(t, Options{}, env(map[string]string{"FW_PROJECT_API_KEY": "fw_public_secretvalue"}), prodBuild)
	assertContains(t, msg, "The key from FW_PROJECT_API_KEY is a browser key")
	assertNotContains(t, msg, "[REDACTED]")
	assertNotContains(t, msg, "secretvalue")
}

// ---------------------------------------------------------------- controlPoints

func TestResolveCopiesTheControlPoints(t *testing.T) {
	controlPoints := LocalControlPoints{"new-checkout": {Local: true, Description: "x"}}
	r := mustResolve(t, Options{Mode: ModeLocal, ControlPoints: controlPoints}, env(nil), prodBuild)
	if !reflect.DeepEqual(r.controlPoints, controlPoints) {
		t.Fatalf("controlPoints = %v", r.controlPoints)
	}
	controlPoints["new-checkout"] = LocalControlPoint{Local: false}
	if !r.controlPoints["new-checkout"].Local {
		t.Fatal("resolved controlPoints must be a copy")
	}
}

func TestResolveRejectsAnInvalidFlagKey(t *testing.T) {
	for _, key := range []string{"", strings.Repeat("k", 257), "bad\nkey"} {
		msg := configMessage(t, Options{Mode: ModeLocal, ControlPoints: LocalControlPoints{key: {Local: true}}}, env(nil), prodBuild)
		assertContains(t, msg, "is not a valid control point key")
	}
}

func TestDefineFlagsReturnsACopyAndPanicsOnABadKey(t *testing.T) {
	in := LocalControlPoints{"new-checkout": {Local: true}}
	out := DefineControlPoints(in)
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("DefineControlPoints = %v, want %v", out, in)
	}
	in["new-checkout"] = LocalControlPoint{}
	if !out["new-checkout"].Local {
		t.Fatal("DefineControlPoints must return a copy")
	}

	defer func() {
		r := recover()
		err, ok := r.(*fireweave.Error)
		if !ok || err.Kind != fireweave.KindConfiguration {
			t.Fatalf("panic = %v (%T), want a Configuration *fireweave.Error", r, r)
		}
	}()
	DefineControlPoints(LocalControlPoints{"": {Local: true}})
}
