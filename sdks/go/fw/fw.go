package fw

// The package-level facade beside Start (node: src/start/fw.ts). Safe to
// call from anywhere, in any order, from any goroutine. Reads never panic
// and never fail: if start failed, they serve the caller's default (and an
// ERROR Decision for the *Details forms), exactly as a core read degrades.

import (
	"context"
	"maps"
	"net/url"
	"strings"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// Client is the one *fireweave.Client for this process: never nil, and the
// same pointer before Start, after it, and across Shutdown and a later
// Start. Use it for dependency injection and anything the package functions
// do not cover. Its reads behave like ControlPoints'.
//
// Shut down with fw.Shutdown, never Client().Runtime().Shutdown, which would
// close this permanent handle for the rest of the process.
func Client() *fireweave.Client { return permanent }

// ControlPoints is the core's control point namespace on Client(): the same
// nine read methods with the same signatures (Evaluate, GetBooleanValue,
// GetStringValue, GetNumberValue, GetObjectValue and the four *Details).
//
//	if fw.ControlPoints().GetBooleanValue("new-checkout", false, fw.For(user.ID)) { … }
//
// A read before any Start starts FireWeave from the environment alone (once).
func ControlPoints() *fireweave.ControlPoints { return permanent.ControlPoints() }

// For builds the evaluation context for a read: the targeting key plus any
// attribute maps, merged left to right and deep-copied.
//
//	fw.ControlPoints().GetBooleanValue("new-checkout", false, fw.For(user.ID, map[string]any{"plan": user.Plan}))
func For(targetingKey string, attributes ...map[string]any) *fireweave.EvaluationContext {
	var merged map[string]any
	for _, attrs := range attributes {
		if len(attrs) == 0 {
			continue
		}
		if merged == nil {
			merged = make(map[string]any, len(attrs))
		}
		maps.Copy(merged, attrs)
	}
	ec := fireweave.NewEvaluationContext(targetingKey, merged)
	return &ec
}

// IdentifyOptions tunes Identify.
type IdentifyOptions struct {
	// Kind defaults to fireweave.TargetKindUser.
	Kind fireweave.TargetKind
}

// Identify registers durable targeting facts for a user at sign-in (the
// core's RegisterTarget, kind user unless opts says otherwise). It returns
// nil when the target was registered, otherwise the *fireweave.Error; the
// caller logs and carries on. It never panics. A blank targeting key is
// InvalidContext in both modes.
//
// In remote mode it is one POST, retried once on a transient failure, so it
// can take two request timeouts when fw-server hangs; ctx bounds it. Call it
// off the request path when that matters.
func Identify(ctx context.Context, targetingKey string, properties map[string]any, opts ...IdentifyOptions) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fireweave.NewError(fireweave.KindInternal, "", nil)
		}
	}()
	if strings.TrimSpace(targetingKey) == "" {
		e := fireweave.NewError(fireweave.KindInvalidContext, "targeting key missing", nil)
		e.TargetingKeyMissing = true
		return e
	}
	if ctx == nil {
		ctx = context.Background()
	}
	o := fireweave.RegisterTargetOptions{Kind: fireweave.TargetKindUser, Properties: properties}
	if len(opts) > 0 && opts[0].Kind != "" {
		o.Kind = opts[0].Kind
	}
	res := permanent.Runtime().RegisterTarget(ctx, targetingKey, o)
	if res.OK {
		return nil
	}
	if res.Error != nil {
		return res.Error
	}
	return fireweave.NewError(fireweave.KindInternal, "", nil)
}

// InstanceKey is a stable targeting key for reads where the server itself is
// the subject (cron, workers, boot-time decisions): Options.InstanceID, else
// FIREWEAVE_INSTANCE_ID, else "inst_" plus a hash of the host name, else a
// random id for the life of the process. Nothing is written to disk. Set
// FIREWEAVE_INSTANCE_ID when replicas share a host name or a host name is
// not stable.
//
//	fw.ControlPoints().GetBooleanValue("nightly-reindex", false, fw.For(fw.InstanceKey()))
func InstanceKey() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if !st.instanceSet {
		lookup := st.lookup
		if lookup == nil {
			lookup = processEnv
		}
		st.instanceKey, _ = deriveInstanceKey(st.instanceOption, lookup, processHostname)
		st.instanceSet = true
	}
	return st.instanceKey
}

// StartStatus is what Start decided. It never contains the key.
type StartStatus struct {
	State State
	// Mode is empty until a start resolved one.
	Mode Mode
	// ModeSource is "option", "key" or "environment".
	ModeSource string
	Channel    Channel
	SDKVersion string
	// Host is the fw-server host name only (remote mode): never a path or a
	// credential.
	Host string
	// EndpointSource is where the endpoint came from: Options.URL, a variable
	// name, or "SDK channel (…)".
	EndpointSource string
	// KeySource is Options.Key or the variable the key came from; "none" in
	// local mode.
	KeySource string
	// Environment is the environment name, when it chose the mode.
	Environment string
	FlagCount   int
	// Error is why start failed, when it did. Already redacted.
	Error string
}

// Status reports the singleton's state and what Start decided: mode and why,
// channel, SDK version, host, endpoint source, key source, environment and
// flag count. It never includes the key, so it is safe to log.
//
//	log.Printf("fireweave: %+v", fw.Status())
func Status() StartStatus {
	st.mu.Lock()
	defer st.mu.Unlock()
	s := StartStatus{State: st.state, Channel: SDKChannel(), SDKVersion: SDKVersion()}
	if r := st.resolved; r != nil {
		s.Mode = r.mode
		s.ModeSource = r.modeSource
		s.Channel = r.channel
		s.SDKVersion = r.sdkVersion
		s.KeySource = r.keySource
		s.FlagCount = len(r.flags)
		s.Environment = r.environment
		if r.url != "" {
			if u, err := url.Parse(r.url); err == nil {
				s.Host = u.Hostname()
			}
			s.EndpointSource = r.urlSource
		}
	}
	if st.err != nil {
		s.Error = st.err.Message
	}
	return s
}
