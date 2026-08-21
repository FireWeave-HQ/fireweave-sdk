package application

import (
	"context"

	"github.com/FireWeave-HQ/fireweave-sdk/go/domain"
	"github.com/FireWeave-HQ/fireweave-sdk/go/infrastructure/adapters/local"
	"github.com/FireWeave-HQ/fireweave-sdk/go/infrastructure/adapters/remote"
)

// Init — the single SDK entry point (spec/modes.md).
//
// Mode is required and never inferred: a missing or mistyped credential
// must fail loudly at boot, not silently fall back to local evaluation —
// that failure mode looks like a green boot and a feature that never ramps.
// This file's only job is to validate the initialisation-time contract and
// select the matching adapter; nothing downstream branches on mode again
// (spec/modes.md "Behaviour per mode" — both adapters implement the same
// BackendAdapter port, so Runtime/Client stay mode-blind).
//
// Initialisation fails loudly (Init returns a non-nil error — Go's
// "throw"); reads on the returned Client never do (spec/control-points.md
// "initialise is the exception"). The validation itself lives in
// domain.ValidateInitOptions, which returns a plain *domain.Error like
// every other validator — Init is what surfaces a failed validation as the
// returned error spec/modes.md requires.
//
// This is the SANCTIONED composition root (mirrors node's
// application/mode.ts / java's application/Fireweave.java): the only file
// under application/ that imports concrete infrastructure/adapters/*
// types — enforced by the layering guard in the fireweave facade package.

// LocalOptions configures Mode: local (spec/modes.md).
type LocalOptions struct {
	// ControlPoints is the seeded local map: a present key resolves with
	// reason STATIC; an absent key misses so the caller's own default is
	// used. May be empty or nil.
	ControlPoints map[string]bool
	// Log is the sink for the "[fireweave:local]" registerTarget trace line
	// (spec/modes.md "registerTarget in local mode"). Defaults to log.Print
	// when nil. Injectable so tests can assert the call without capturing
	// stdout, and so a host that owns its logging can route it.
	Log func(string)
}

// Options configures Init. Mode is required; remote requires APIKey +
// APIURL; local takes an optional ControlPoints seed map.
//
// Local- and remote-mode fields live on the SAME struct rather than two
// disjoint types, deliberately: spec/modes.md's initialisation-validation
// table has a row for "mode: local with credentials supplied" (a config
// half-migrated from remote to local reads as neither, silently, unless
// rejected) — that row is only reachable when a caller CAN construct a
// value carrying both a mode and left-over credentials, which two disjoint
// types would prevent by construction (this mirrors java's InitOptions,
// built for the identical reason).
type Options struct {
	Mode domain.Mode

	// Remote mode (spec/modes.md): required, never read from env.
	APIKey       string
	APIURL       string
	AllowedHosts []string

	// Local mode (spec/modes.md): optional; nil behaves like an empty seed map.
	Local *LocalOptions
}

// Init builds the adapter matching options.Mode and brings a Client to
// READY.
//
// Returns a non-nil error (kind Configuration) for every row of the
// initialisation-validation table (spec/modes.md):
//   - mode absent or unrecognised
//   - mode "remote" with apiKey or apiUrl missing/blank
//   - apiUrl fails the host allowlist
//   - mode "local" with credentials supplied
//
// The first, second and fourth rows are domain.ValidateInitOptions's job;
// the third is validated downstream, when Runtime.Initialize brings the
// remote adapter up (the remote adapter's own SSRF allowlist check).
func Init(options Options) (*Client, error) {
	if err := domain.ValidateInitOptions(options.Mode, options.APIKey, options.APIURL); err != nil {
		return nil, err
	}
	if options.Mode == domain.ModeLocal {
		return initLocal(options)
	}
	return initRemote(options)
}

func initLocal(options Options) (*Client, error) {
	seed := map[string]bool{}
	var logSink func(string)
	if options.Local != nil {
		if options.Local.ControlPoints != nil {
			seed = options.Local.ControlPoints
		}
		logSink = options.Local.Log
	}
	adapter := local.New(seed, logSink)
	runtime := NewRuntime(adapter, Config{})
	if err := runtime.Initialize(context.Background()); err != nil {
		return nil, err
	}
	return NewClient(runtime), nil
}

func initRemote(options Options) (*Client, error) {
	adapter := remote.New(remote.Config{
		APIURL:       options.APIURL,
		APIKey:       options.APIKey,
		AllowedHosts: options.AllowedHosts,
	})
	runtime := NewRuntime(adapter, Config{})
	if err := runtime.Initialize(context.Background()); err != nil {
		return nil, err
	}
	return NewClient(runtime), nil
}
