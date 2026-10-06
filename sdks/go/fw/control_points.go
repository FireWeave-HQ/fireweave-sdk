package fw

import (
	"sort"
	"strconv"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// LocalControlPoint is one control point the app reads.
type LocalControlPoint struct {
	// Local is the value served in local mode. Ignored in remote mode, where
	// fw-server and the rollout decide.
	Local bool
	// Description is an optional note for humans and agents. Never sent
	// anywhere.
	Description string
}

// LocalControlPoints is every control point the app reads, keyed by control
// point key, with the value served in local mode. It lives in its own file
// (internal/fireweave/control_points.go by convention) and is passed as
// Options.ControlPoints.
//
// It holds local values only. In remote mode call sites keep false as their
// default, so this file can never switch a feature on in production.
type LocalControlPoints map[string]LocalControlPoint

// DefineControlPoints declares the app's control points and returns a copy of them.
// It checks every key with the core's control point key rule when the
// package-level var is initialised, so a typo fails where it was made: like
// regexp.MustCompile, it panics with a Configuration *fireweave.Error on a
// bad key.
//
//	var ControlPoints = fw.DefineControlPoints(fw.LocalControlPoints{
//		"new-checkout": {Local: true, Description: "new checkout flow"},
//	})
func DefineControlPoints(controlPoints LocalControlPoints) LocalControlPoints {
	out, err := normalizeControlPoints(controlPoints)
	if err != nil {
		panic(err)
	}
	return out
}

// normalizeControlPoints validates every key and returns a copy (never nil).
func normalizeControlPoints(controlPoints LocalControlPoints) (LocalControlPoints, *fireweave.Error) {
	out := make(LocalControlPoints, len(controlPoints))
	for _, key := range sortedKeys(controlPoints) {
		if _, err := fireweave.ValidateControlPointKey(key); err != nil {
			return nil, configError("Options.ControlPoints: " + strconv.Quote(key) + " is not a valid control point key (" + err.Message + ").")
		}
		out[key] = controlPoints[key]
	}
	return out, nil
}

// localSeeds is the core local adapter's seed map.
func localSeeds(controlPoints LocalControlPoints) map[string]bool {
	out := make(map[string]bool, len(controlPoints))
	for key, flag := range controlPoints {
		out[key] = flag.Local
	}
	return out
}

// controlPointsSignature is a canonical rendering of the local values, for the
// idempotency check.
func controlPointsSignature(controlPoints LocalControlPoints) string {
	s := ""
	for _, key := range sortedKeys(controlPoints) {
		s += strconv.Quote(key) + "=" + strconv.FormatBool(controlPoints[key].Local) + ";"
	}
	return s
}

func sortedKeys(controlPoints LocalControlPoints) []string {
	keys := make([]string, 0, len(controlPoints))
	for key := range controlPoints {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func configError(message string) *fireweave.Error {
	return fireweave.NewError(fireweave.KindConfiguration, message, nil)
}
