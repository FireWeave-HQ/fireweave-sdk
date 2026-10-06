// Package fw is the FireWeave start profile: one-line setup layered over the
// unchanged core SDK (docs/adr/0012-start-profile.md).
//
// The core (package fireweave and everything under it) reads no environment
// and never infers a mode. This package is the documented exception: it reads
// FIREWEAVE_* variables, chooses the mode by a fail-closed rule, defaults the
// endpoint from this SDK build's release channel, and keeps one client per
// process. It is built only on the fireweave package's public API and the
// standard library.
//
//	// internal/fireweave/control_points.go: every control point the app reads, with its local value
//	var ControlPoints = fw.DefineControlPoints(fw.LocalControlPoints{
//		"new-checkout": {Local: true, Description: "new checkout flow"},
//	})
//
//	// main(), after the app's own config loading
//	// (appfw is the app's internal/fireweave package)
//	if err := fw.Start(fw.Options{ControlPoints: appfw.ControlPoints}); err != nil {
//		log.Fatal(err)
//	}
//
//	// anywhere
//	// @fireweave-controlpoint new-checkout
//	if fw.ControlPoints().GetBooleanValue("new-checkout", false, fw.For(user.ID)) { … }
//
// Deployed environments set one variable, FIREWEAVE_KEY (the project key,
// project-api-key_…). Local development needs nothing when FIREWEAVE_ENV or
// APP_ENV is development, dev, local or test.
//
// # Mode rule
//
// Options.Mode wins. Otherwise a key means remote; no key and a development
// environment name means local; anything else (including no environment name
// at all) is a Configuration error from Start naming FIREWEAVE_KEY, so a
// deploy that forgot its key fails instead of silently serving defaults.
//
// # Reads
//
// Reads never panic and never fail: if start failed they serve the caller's
// default, and the *Details forms return an ERROR Decision carrying the start
// error. A read before any Start starts FireWeave from the environment alone,
// once, on that read; a later Start with a different configuration then
// returns a Configuration error saying so. Call Start first in main.
//
// In remote mode each read is one request to fw-server with the core's
// request timeout and no cache, exactly as with fireweave.Init.
//
// # Debugging
//
// Status reports the state, mode and why, channel, SDK version, host,
// endpoint source, key source, environment and control-point count, and the start
// error if any. It never contains the key.
package fw
