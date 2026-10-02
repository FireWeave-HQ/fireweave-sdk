package fw

// The ONLY file in this module that reads the process environment or the
// host name.
//
// The core SDK reads no environment variables (spec/modes.md). The start
// profile is the documented exception (docs/adr/0011-start-profile.md), and
// fireweave/architecture_guard_test.go pins every env read and the host-name
// lookup to this file.

import (
	"os"
	"strings"
)

// lookupFunc reads one variable, trimmed. "" means unset, empty or only
// whitespace: the three are the same to the start profile.
type lookupFunc func(name string) string

// processEnv reads the running process's environment.
func processEnv(name string) string {
	v, _ := os.LookupEnv(name)
	return strings.TrimSpace(v)
}

// envLookup is Options.Env when set (tests, run(getenv)-style apps), else the
// process environment. Values are trimmed either way.
func envLookup(get func(name string) string) lookupFunc {
	if get == nil {
		return processEnv
	}
	return func(name string) string { return strings.TrimSpace(get(name)) }
}

// processHostname is the host name, or "" when the OS will not say.
func processHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(h)
}
