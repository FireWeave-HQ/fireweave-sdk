package fw

// Every name the start profile reads, in one place, so the README, the
// initialise skill and the error messages cannot drift apart (node:
// src/start/names.ts).

// Env vars the start profile reads. Explicit Options fields always win.
const (
	envKey         = "FIREWEAVE_KEY"
	envURL         = "FIREWEAVE_URL"
	envEnvironment = "FIREWEAVE_ENV"
	envInstanceID  = "FIREWEAVE_INSTANCE_ID"
)

// environmentFallbacks are read after Options.Environment and FIREWEAVE_ENV.
// NODE_ENV is not a Go convention and ENV/GO_ENV are not read (see the build
// plan's Go section): only names an operator sets on purpose select a mode.
var environmentFallbacks = []string{"APP_ENV"}

// devEnvironments are the environment names that mean "local development"
// when no key is set. Compared trimmed and case-insensitively.
var devEnvironments = map[string]bool{"development": true, "dev": true, "local": true, "test": true}

// channelURLs is the fw-server host for each release channel of this module.
// Both hosts are in the core remote adapter's default allowlist, so the
// default endpoint needs no custom allowlist.
var channelURLs = map[Channel]string{
	ChannelProduction: "https://app-server.fireweave.ai",
	ChannelStaging:    "https://staging-app-server.fireweave.ai",
}

// loopbackHosts are always allowed beside a custom endpoint, so local stacks
// keep working.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// controlPointsFile is where the app's control points conventionally live; named in the
// local-mode "missing key" warning.
const controlPointsFile = "internal/fireweave/control_points.go"
