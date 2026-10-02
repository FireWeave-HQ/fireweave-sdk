package fw

import (
	"sort"
	"strconv"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// Flag is one control point the app reads.
type Flag struct {
	// Local is the value served in local mode. Ignored in remote mode, where
	// fw-server and the rollout decide.
	Local bool
	// Description is an optional note for humans and agents. Never sent
	// anywhere.
	Description string
}

// Flags is every control point the app reads, keyed by control point key,
// with the value served in local mode. It lives in its own file
// (internal/fireweave/flags.go by convention) and is passed as
// Options.Flags.
//
// It holds local values only. In remote mode call sites keep false as their
// default, so a flags file can never switch a feature on in production.
type Flags map[string]Flag

// DefineFlags declares the app's control points and returns a copy of them.
// It checks every key with the core's control point key rule when the
// package-level var is initialised, so a typo fails where it was made: like
// regexp.MustCompile, it panics with a Configuration *fireweave.Error on a
// bad key.
//
//	var Flags = fw.DefineFlags(fw.Flags{
//		"new-checkout": {Local: true, Description: "new checkout flow"},
//	})
func DefineFlags(flags Flags) Flags {
	out, err := normalizeFlags(flags)
	if err != nil {
		panic(err)
	}
	return out
}

// normalizeFlags validates every key and returns a copy (never nil).
func normalizeFlags(flags Flags) (Flags, *fireweave.Error) {
	out := make(Flags, len(flags))
	for _, key := range sortedKeys(flags) {
		if _, err := fireweave.ValidateControlPointKey(key); err != nil {
			return nil, configError("flags: " + strconv.Quote(key) + " is not a valid control point key (" + err.Message + ").")
		}
		out[key] = flags[key]
	}
	return out, nil
}

// localSeeds is the core local adapter's seed map.
func localSeeds(flags Flags) map[string]bool {
	out := make(map[string]bool, len(flags))
	for key, flag := range flags {
		out[key] = flag.Local
	}
	return out
}

// flagsSignature is a canonical rendering of the local values, for the
// idempotency check.
func flagsSignature(flags Flags) string {
	s := ""
	for _, key := range sortedKeys(flags) {
		s += strconv.Quote(key) + "=" + strconv.FormatBool(flags[key].Local) + ";"
	}
	return s
}

func sortedKeys(flags Flags) []string {
	keys := make([]string, 0, len(flags))
	for key := range flags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func configError(message string) *fireweave.Error {
	return fireweave.NewError(fireweave.KindConfiguration, message, nil)
}
