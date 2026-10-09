package fw

// The pure start-profile resolver: Options + env lookup + build channel in,
// one resolved config out. No I/O and no globals, so every rule here is
// unit-tested through resolve alone (node: src/start/resolve.ts).
//
// Precedence for every value: explicit Options field, then the FIREWEAVE_*
// variable, then the legacy FW_* name (one warning), then the default.
// Lookups are lazy: a source is read only if every earlier source was unset.

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/fireweave"
)

// Mode is the SDK mode the start profile selects: fw.ModeRemote or
// fw.ModeLocal. The empty Mode means "infer it" (see Start).
type Mode = fireweave.Mode

const (
	ModeLocal  = fireweave.ModeLocal
	ModeRemote = fireweave.ModeRemote
)

// Why a mode was chosen (Status.ModeSource).
const (
	modeSourceOption      = "option"
	modeSourceKey         = "key"
	modeSourceEnvironment = "environment"
)

// buildInfo is the SDK build the resolver defaults from.
type buildInfo struct {
	version string
	channel Channel
}

// resolved is one start decision. key is held only to hand it to
// fireweave.Init; it is never logged, printed or put in Status.
type resolved struct {
	mode       Mode
	modeSource string

	// Remote only.
	url          string
	urlSource    string
	allowedHosts []string // nil when the default channel endpoint is used
	key          string
	keySource    string // "none" in local mode

	// Set when the environment name was consulted (no key, no Mode option).
	environment       string
	environmentSource string

	controlPoints LocalControlPoints
	channel       Channel
	sdkVersion    string

	// Lines to log once each: legacy names, an ignored key.
	warnings []string
}

type sourced struct {
	value  string
	source string
}

// pick returns the first non-empty of: the option, then each env name in
// order, then each legacy name (adding one warning naming its replacement).
func pick(option, optionName string, names, legacy []string, lookup lookupFunc, warnings *[]string, replacement string) (sourced, bool) {
	if v := strings.TrimSpace(option); v != "" {
		return sourced{value: v, source: optionName}, true
	}
	for _, name := range names {
		if v := lookup(name); v != "" {
			return sourced{value: v, source: name}, true
		}
	}
	for _, name := range legacy {
		if v := lookup(name); v != "" {
			if warnings != nil {
				*warnings = append(*warnings, "[fireweave] "+name+" is a legacy name and will stop being read in the next major version (v3). Rename it to "+replacement+"; the value does not change.")
			}
			return sourced{value: v, source: name}, true
		}
	}
	return sourced{}, false
}

// vendorKey matches analytics-vendor key shapes. It is a pattern rather than
// literal prefixes, and the message says "analytics vendor key", so no vendor
// key prefix appears in this file or in an error.
var vendorKey = regexp.MustCompile(`^ph[a-z]_`)

// checkKeyFamily runs before any request. Messages name the source, never the
// value.
func checkKeyFamily(key, source string) *fireweave.Error {
	switch {
	case strings.HasPrefix(key, "fw_public_"):
		return configError("The key from " + source + " is a browser key (fw_public_…). Server apps need a project key (project-api-key_…) from Project settings, API keys.")
	case vendorKey.MatchString(key):
		return configError("The key from " + source + " is an analytics vendor key, not a FireWeave project key. Use the project key (project-api-key_…).")
	case strings.HasPrefix(key, "fw_org_"), strings.HasPrefix(key, "cli_at_"):
		return configError("The key from " + source + " is an organisation or CLI token, not a project key. Use the project key (project-api-key_…).")
	}
	return nil
}

// resolveURL picks the endpoint. The default is this build's channel host,
// which the core's default allowlist already admits; an override gets an
// allowlist of its own host plus loopback.
func resolveURL(opts Options, lookup lookupFunc, build buildInfo, warnings *[]string) (u, source string, hosts []string, err *fireweave.Error) {
	picked, ok := pick(opts.URL, "Options.URL", []string{envURL}, legacyURLNames, lookup, warnings, envURL)
	if !ok {
		return channelURLs[build.channel], "SDK channel (" + string(build.channel) + ")", nil, nil
	}
	raw := strings.TrimRight(picked.value, "/")
	parsed, perr := url.Parse(raw)
	if perr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return "", "", nil, configError("The endpoint from " + picked.source + " is not a valid URL.")
	}
	host := strings.ToLower(parsed.Hostname())
	if parsed.Scheme == "http" && !isLoopback(host) {
		return "", "", nil, configError("The endpoint from " + picked.source + " must use https (http is allowed only for localhost).")
	}
	hosts = []string{host}
	for _, h := range loopbackHosts {
		if h != host {
			hosts = append(hosts, h)
		}
	}
	return raw, picked.source, hosts, nil
}

func isLoopback(host string) bool {
	for _, h := range loopbackHosts {
		if host == h {
			return true
		}
	}
	return false
}

func resolveKey(opts Options, lookup lookupFunc, warnings *[]string) (sourced, bool, *fireweave.Error) {
	picked, ok := pick(opts.Key, "Options.Key", []string{envKey}, legacyKeyNames, lookup, warnings, envKey)
	if !ok {
		return sourced{}, false, nil
	}
	if err := checkKeyFamily(picked.value, picked.source); err != nil {
		return sourced{}, false, err
	}
	return picked, true, nil
}

// safeEcho is the rule for quoting an environment name back in an error: a
// short plain token that does not look like a key.
var safeEcho = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)

func echoable(value string) bool {
	if !safeEcho.MatchString(value) || vendorKey.MatchString(value) {
		return false
	}
	for _, prefix := range []string{"project-api-key_", "fw_"} {
		if strings.HasPrefix(value, prefix) {
			return false
		}
	}
	return true
}

func noKeyError(env sourced, found bool, lookup lookupFunc) *fireweave.Error {
	var where string
	switch {
	case !found:
		where = "no environment name is set (checked Options.Environment, " + envEnvironment + " and " + strings.Join(environmentFallbacks, ", ") + ")"
	case echoable(env.value):
		where = "the environment is " + strconv.Quote(env.value) + " (from " + env.source + "), which is not a development name"
	default:
		where = "the environment name from " + env.source + " is not a development name"
	}
	retired := ""
	if !found && lookup(retiredEnvironmentName) != "" {
		retired = " " + retiredEnvironmentName + " is no longer read; rename it to " + envEnvironment + "."
	}
	return configError(envKey + " is not set and " + where + ". Set " + envKey + " to the project's server key, or for local development set " + envEnvironment + " to development or pass Options.Mode fw.ModeLocal." + retired)
}

// resolve applies the start profile's rules to opts.
// It returns a Configuration *fireweave.Error naming the source at fault.
func resolve(opts Options, lookup lookupFunc, build buildInfo) (resolved, *fireweave.Error) {
	controlPoints, ferr := normalizeControlPoints(opts.ControlPoints)
	if ferr != nil {
		return resolved{}, ferr
	}
	r := resolved{controlPoints: controlPoints, channel: build.channel, sdkVersion: build.version, keySource: "none"}

	mode := Mode(strings.ToLower(strings.TrimSpace(string(opts.Mode))))
	if mode != "" && mode != ModeRemote && mode != ModeLocal {
		return resolved{}, configError(`Options.Mode must be "remote" or "local", or empty to infer it.`)
	}

	if mode == ModeLocal {
		// The key is ignored. Look only to warn.
		if src, ok := pick(opts.Key, "Options.Key", []string{envKey}, legacyKeyNames, lookup, nil, envKey); ok {
			r.warnings = append(r.warnings, `[fireweave] Options.Mode "local" ignores the key from `+src.source+"; nothing is sent to fw-server.")
		}
		r.mode, r.modeSource = ModeLocal, modeSourceOption
		return r, nil
	}

	key, hasKey, kerr := resolveKey(opts, lookup, &r.warnings)
	if kerr != nil {
		return resolved{}, kerr
	}

	if mode == ModeRemote && !hasKey {
		return resolved{}, configError(`Options.Mode "remote" needs a key. Set ` + envKey + " or pass Options.Key.")
	}

	if hasKey {
		u, source, hosts, uerr := resolveURL(opts, lookup, build, &r.warnings)
		if uerr != nil {
			return resolved{}, uerr
		}
		r.mode, r.modeSource = ModeRemote, modeSourceKey
		if mode == ModeRemote {
			r.modeSource = modeSourceOption
		}
		r.url, r.urlSource, r.allowedHosts = u, source, hosts
		r.key, r.keySource = key.value, key.source
		return r, nil
	}

	env, found := pick(opts.Environment, "Options.Environment", append([]string{envEnvironment}, environmentFallbacks...), nil, lookup, nil, envEnvironment)
	if found && devEnvironments[strings.ToLower(env.value)] {
		r.mode, r.modeSource = ModeLocal, modeSourceEnvironment
		r.environment, r.environmentSource = env.value, env.source
		return r, nil
	}
	return resolved{}, noKeyError(env, found, lookup)
}
