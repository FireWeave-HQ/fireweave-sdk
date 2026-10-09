package fw

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"testing"
)

func TestChannelForVersion(t *testing.T) {
	cases := map[string]Channel{
		"v2.4.0":                  ChannelProduction,
		"v2.4.0-staging.1":        ChannelProduction, // -staging.N stopped being staging at 3.0.0
		"v2.4.1-staging.12":       ChannelProduction,
		"v2.4.1-staging.3+dirty":  ChannelProduction,
		"v2.4.0-staging":          ChannelProduction,
		"v2.4.0-rc.1":             ChannelStaging,
		"v2.4.1-rc.12":            ChannelStaging,
		"v2.4.1-rc.3+dirty":       ChannelStaging,
		"v2.4.0-rc":               ChannelProduction, // not a release.sh rc tag
		"v0.0.0-20261002-abcdef":  ChannelProduction, // pseudo-version
		"v2.4.1-0.20261002-abcde": ChannelProduction,
		"(devel)":                 ChannelProduction,
		"":                        ChannelProduction,
		// Pseudo-versions keep the base tag's suffix: one built on an rc tag
		// is staging; one built on the legacy v3.0.0-staging.1 tag (every
		// main commit until v3.0.0 is tagged) is production.
		"v3.0.0-rc.1.0.20261010120000-abcdef123456":      ChannelStaging,
		"v3.0.0-staging.1.0.20261010120000-abcdef123456": ChannelProduction,
	}
	for version, want := range cases {
		if got := channelForVersion(version); got != want {
			t.Errorf("channelForVersion(%q) = %s, want %s", version, got, want)
		}
	}
}

func TestVersionFromBuildInfo(t *testing.T) {
	dep := func(path, version string, replace *debug.Module) *debug.Module {
		return &debug.Module{Path: path, Version: version, Replace: replace}
	}
	cases := []struct {
		name string
		info *debug.BuildInfo
		ok   bool
		want string
	}{
		{"no build info", nil, false, develVersion},
		{"sdk is the main module", &debug.BuildInfo{Main: debug.Module{Path: modulePath, Version: "v2.4.0-rc.2"}}, true, "v2.4.0-rc.2"},
		{"main module without a version", &debug.BuildInfo{Main: debug.Module{Path: modulePath}}, true, develVersion},
		{"a dependency", &debug.BuildInfo{
			Main: debug.Module{Path: "example.com/app", Version: "(devel)"},
			Deps: []*debug.Module{dep("example.com/other", "v1.0.0", nil), dep(modulePath, "v2.4.0", nil)},
		}, true, "v2.4.0"},
		{"replaced by a version", &debug.BuildInfo{
			Main: debug.Module{Path: "example.com/app"},
			Deps: []*debug.Module{dep(modulePath, "v2.4.0", &debug.Module{Path: modulePath, Version: "v2.5.0-rc.1"})},
		}, true, "v2.5.0-rc.1"},
		{"replaced by a directory", &debug.BuildInfo{
			Main: debug.Module{Path: "example.com/app"},
			Deps: []*debug.Module{dep(modulePath, "v2.4.0-staging.1", &debug.Module{Path: "../fireweave-sdk/sdks/go"})},
		}, true, develVersion},
		{"not linked at all", &debug.BuildInfo{Main: debug.Module{Path: "example.com/app"}}, true, develVersion},
	}
	for _, c := range cases {
		if got := versionFromBuildInfo(c.info, c.ok); got != c.want {
			t.Errorf("%s: version = %q, want %q", c.name, got, c.want)
		}
	}
}

// A test binary carries no release version, so it reports (devel) and the
// production channel.
func TestSDKVersionAndChannelOfThisBuild(t *testing.T) {
	if SDKVersion() == "" {
		t.Fatal("SDKVersion must never be empty")
	}
	if got := SDKChannel(); got != channelForVersion(SDKVersion()) {
		t.Fatalf("SDKChannel = %s, want the channel of %q", got, SDKVersion())
	}
}

func TestModulePathMatchesGoMod(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^module\s+(\S+)`).FindStringSubmatch(string(data))
	if m == nil || strings.TrimSpace(m[1]) != modulePath {
		t.Fatalf("go.mod module = %v, want %s", m, modulePath)
	}
}
