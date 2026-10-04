package fw

import (
	"runtime/debug"
	"strings"
	"sync"
)

// Channel is the release channel this SDK build came from. It chooses the
// default fw-server endpoint (docs/adr/0012-start-profile.md, rule 3).
type Channel string

const (
	ChannelProduction Channel = "production"
	ChannelStaging    Channel = "staging"
)

// modulePath is this SDK's module path, looked up in the binary's build info.
// fw/channel_test.go pins it to go.mod's module line.
const modulePath = "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2"

// develVersion is reported when the build info does not carry a release
// version: a local checkout, a directory replace, or a test binary.
const develVersion = "(devel)"

// channelForVersion is the channel rule, as a pure function of a module
// version. tools/release/version.sh tags a Go staging release
// sdks/go/vX.Y.Z-staging.N, so the module version a consumer resolves is
// vX.Y.Z-staging.N. Anything else, including (devel), is production.
func channelForVersion(version string) Channel {
	if strings.Contains(version, "-staging.") {
		return ChannelStaging
	}
	return ChannelProduction
}

// versionFromBuildInfo finds this module's version in a binary's build info:
// the main module when the SDK is built on its own, otherwise its entry in
// Deps (a replace with a version wins; a directory replace is a local
// checkout, so (devel)).
func versionFromBuildInfo(info *debug.BuildInfo, ok bool) string {
	if !ok || info == nil {
		return develVersion
	}
	if info.Main.Path == modulePath {
		return nonEmptyVersion(info.Main.Version)
	}
	for _, dep := range info.Deps {
		if dep == nil || dep.Path != modulePath {
			continue
		}
		if dep.Replace != nil {
			return nonEmptyVersion(dep.Replace.Version)
		}
		return nonEmptyVersion(dep.Version)
	}
	return develVersion
}

func nonEmptyVersion(v string) string {
	if strings.TrimSpace(v) == "" {
		return develVersion
	}
	return v
}

var buildVersion = sync.OnceValue(func() string {
	return versionFromBuildInfo(debug.ReadBuildInfo())
})

// SDKVersion is this SDK's module version as recorded in the binary's build
// info (for example "v2.4.0" or "v2.4.0-staging.1"), or "(devel)" when the
// build info has none.
func SDKVersion() string { return buildVersion() }

// SDKChannel is the release channel of this SDK build: staging for a
// -staging.N version, production for anything else.
func SDKChannel() Channel { return channelForVersion(SDKVersion()) }
