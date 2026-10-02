package fw

// Start and the process-wide singleton behind the package-level functions
// (node: src/start/state.ts).
//
// The SDK keeps ONE permanent *fireweave.Client for the life of the process,
// built at package init with no env reads and no I/O. Its runtime sits on a
// forwarding adapter, so a pointer captured before Start (a package-level
// var, a struct built in init()) keeps working after Start, across Shutdown
// and a later Start. Start resolves the config, builds the real client with
// the unchanged core fireweave.Init (so the core validation table still
// runs), and points the forwarder at it.
//
// A read before any Start starts FireWeave from the environment alone, once,
// synchronously on that read. fireweave.Init does no network I/O, so this
// never blocks on the network.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// Options configures Start. Every field is optional; the zero Options reads
// everything from the environment.
type Options struct {
	// Flags is every control point the app reads, with its local value
	// (internal/fireweave/flags.go by convention). Applied in local mode only.
	Flags Flags
	// Mode forces a mode. Empty: a key means remote; no key means local only
	// when the environment name is development, dev, local or test.
	Mode Mode
	// Environment is the environment name used to infer the mode, instead of
	// FIREWEAVE_ENV or APP_ENV. Pass your own, e.g. a deploy-stage setting.
	Environment string
	// URL is the fw-server endpoint. Default: FIREWEAVE_URL, else this SDK
	// build's channel host. https is required except on localhost.
	URL string
	// Key is the project key (project-api-key_…). Default: FIREWEAVE_KEY.
	Key string
	// InstanceID is the value of InstanceKey(). Default:
	// FIREWEAVE_INSTANCE_ID, else a hash of the host name.
	InstanceID string
	// Env replaces the process environment for every variable the start
	// profile reads: tests, and run(getenv)-style apps. It returns "" for an
	// unset variable and must not apply defaults of its own.
	Env func(name string) string
	// Log receives [fireweave] lines: warnings at Warn, the local-mode line
	// and the local registerTarget trace at Info. Default: slog.Default(),
	// resolved at each line. Not part of the idempotency check.
	Log *slog.Logger
}

// State is where the singleton is in its life.
type State string

const (
	StateUnstarted State = "unstarted"
	StateReady     State = "ready"
	StateFailed    State = "failed"
	StateShutdown  State = "shutdown"
)

// signature is what makes two Starts "the same". Flags count in local mode
// only: remote ignores them, so an implicit env-only start followed by
// Start(Options{Flags: …}) under a key is not a conflict.
type signature struct {
	mode         Mode
	url          string
	keyHash      string
	allowedHosts string
	instanceID   string
	flags        string
}

func signatureOf(r resolved, instanceID string) signature {
	sig := signature{
		mode:         r.mode,
		url:          r.url,
		allowedHosts: strings.Join(r.allowedHosts, ","),
		instanceID:   strings.TrimSpace(instanceID),
	}
	if r.key != "" {
		sum := sha256.Sum256([]byte(r.key))
		sig.keyHash = hex.EncodeToString(sum[:])
	}
	if r.mode == ModeLocal {
		sig.flags = flagsSignature(r.flags)
	}
	return sig
}

// differs names the fields that differ, never their values.
func (s signature) differs(o signature) []string {
	var out []string
	add := func(changed bool, name string) {
		if changed {
			out = append(out, name)
		}
	}
	add(s.mode != o.mode, "mode")
	add(s.url != o.url, "url")
	add(s.keyHash != o.keyHash, "key")
	add(s.allowedHosts != o.allowedHosts, "allowed hosts")
	add(s.instanceID != o.instanceID, "instance id")
	add(s.flags != o.flags, "flags")
	return out
}

type logLine struct {
	level slog.Level
	msg   string
}

// singleton is the process-wide start state. Every field is guarded by mu;
// logging happens after mu is released, so a log handler can never deadlock
// against a read.
type singleton struct {
	mu sync.Mutex

	state         State
	implicit      bool // the running client came from an implicit start
	implicitTried bool // reads do not start implicitly again
	resolved      *resolved
	sig           signature
	client        *fireweave.Client
	err           *fireweave.Error
	lookup        lookupFunc

	instanceOption string
	instanceKey    string
	instanceSet    bool

	logger *slog.Logger
	warned map[string]bool
}

var st = &singleton{state: StateUnstarted, warned: map[string]bool{}}

// permanent is the one client handed out for the life of the process.
var permanent = newPermanentClient()

func newPermanentClient() *fireweave.Client {
	rt := fireweave.NewRuntime(forwarder{}, fireweave.Config{})
	// forwarder.Initialize never fails and does nothing.
	_ = rt.Initialize(context.Background())
	return fireweave.NewClient(rt)
}

func (s *singleton) loggerLocked() *slog.Logger {
	if s.logger != nil {
		return s.logger
	}
	return slog.Default()
}

// warnOnceLocked appends line unless this process already logged it.
func (s *singleton) warnOnceLocked(lines []logLine, line string) []logLine {
	if s.warned[line] {
		return lines
	}
	s.warned[line] = true
	return append(lines, logLine{level: slog.LevelWarn, msg: line})
}

func emit(logger *slog.Logger, lines []logLine) {
	for _, l := range lines {
		logger.Log(context.Background(), l.level, l.msg)
	}
}

// infoSink routes the core local adapter's "[fireweave:local]" trace through
// the current logger.
func infoSink(line string) {
	st.mu.Lock()
	logger := st.loggerLocked()
	st.mu.Unlock()
	logger.Info(line)
}

// freshRunLocked forgets a failed or shut-down start, keeping the warned set,
// the log sink and the instance key.
func (s *singleton) freshRunLocked() {
	s.state = StateUnstarted
	s.implicit = false
	s.implicitTried = false
	s.resolved = nil
	s.sig = signature{}
	s.client = nil
	s.err = nil
	s.lookup = nil
	// The instance key outlives a run: it identifies the process, so a key
	// handed out before a failed or shut-down start stays the same after it.
}

func localLine(r resolved) string {
	why := `Options.Mode "local"`
	if r.modeSource == modeSourceEnvironment {
		why = "no " + envKey + "; environment " + strconv.Quote(r.environment) + " from " + r.environmentSource
	}
	n := len(r.flags)
	noun := "flags"
	if n == 1 {
		noun = "flag"
	}
	return "[fireweave:local] Local mode (" + why + "). Serving " + strconv.Itoa(n) + " " + noun + " from your flags; nothing is sent to fw-server."
}

func initOptions(r resolved) fireweave.Options {
	if r.mode == ModeLocal {
		return fireweave.Options{
			Mode:  fireweave.ModeLocal,
			Local: &fireweave.LocalOptions{ControlPoints: localSeeds(r.flags), Log: infoSink},
		}
	}
	return fireweave.Options{
		Mode:         fireweave.ModeRemote,
		APIKey:       r.key,
		APIURL:       r.url,
		AllowedHosts: r.allowedHosts,
	}
}

func asFireweaveError(err error) *fireweave.Error {
	var fwErr *fireweave.Error
	if errors.As(err, &fwErr) {
		return fwErr
	}
	return fireweave.NewError(fireweave.KindInternal, "", err)
}

// startLocked is Start's body. It returns the lines to log once mu is
// released.
func (s *singleton) startLocked(opts Options, implicit bool) ([]logLine, *fireweave.Error) {
	var lines []logLine
	if s.state == StateFailed || s.state == StateShutdown {
		s.freshRunLocked()
	}

	lookup := envLookup(opts.Env)
	r, err := resolve(opts, lookup, buildInfo{version: SDKVersion(), channel: SDKChannel()})
	if err != nil {
		if s.state == StateReady {
			// A bad second Start never takes down the running client.
			return lines, err
		}
		s.state, s.err, s.implicitTried = StateFailed, err, true
		if implicit {
			lines = s.warnOnceLocked(lines, "[fireweave] "+err.Message+" (FireWeave was not started; reads serve their defaults.)")
		}
		return lines, err
	}
	sig := signatureOf(r, opts.InstanceID)

	if s.state == StateReady {
		diff := s.sig.differs(sig)
		if len(diff) == 0 {
			return lines, nil
		}
		fields := strings.Join(diff, ", ")
		if s.implicit {
			return lines, configError("A control point was read before fw.Start ran, so FireWeave started from the environment alone; this Start differs in " + fields + ". Call fw.Start first in main, before anything reads a control point.")
		}
		return lines, configError("fw.Start was already called with a different configuration (" + fields + "). Call fw.Start once, from main.")
	}

	if id := strings.TrimSpace(opts.InstanceID); id != "" && s.instanceSet && s.instanceKey != id {
		return lines, configError("Options.InstanceID differs from the InstanceKey() already handed out. Pass InstanceID on the first fw.Start.")
	}

	// Only a start that actually begins sets the log sink: an identical
	// second Start is a no-op and a conflicting one fails, and neither may
	// swap it.
	if !implicit && opts.Log != nil {
		s.logger = opts.Log
	}

	client, initErr := fireweave.Init(initOptions(r))
	if initErr != nil {
		fwErr := asFireweaveError(initErr)
		s.state, s.err, s.implicitTried = StateFailed, fwErr, true
		lines = s.warnOnceLocked(lines, "[fireweave] start failed: "+fwErr.Message+". Reads serve their defaults.")
		return lines, fwErr
	}

	s.state = StateReady
	s.implicit = implicit
	s.implicitTried = true
	s.resolved = &r
	s.sig = sig
	s.client = client
	s.err = nil
	s.lookup = lookup
	if id := strings.TrimSpace(opts.InstanceID); id != "" {
		s.instanceOption = id
	}
	for _, w := range r.warnings {
		lines = s.warnOnceLocked(lines, w)
	}
	if r.mode == ModeLocal {
		lines = append(lines, logLine{level: slog.LevelInfo, msg: localLine(r)})
	}
	return lines, nil
}

// Start starts FireWeave for this process. Call it once, first thing in main,
// after the app's own config loading.
//
// Mode rule: Options.Mode wins ("local" ignores any key, with one warning;
// "remote" without a key is an error). Otherwise a key (Options.Key,
// FIREWEAVE_KEY) means remote; no key and an environment name
// (Options.Environment, FIREWEAVE_ENV, APP_ENV) of development, dev, local or
// test means local; anything else, including no environment name at all, is
// a Configuration error naming FIREWEAVE_KEY. A deploy that forgot its key
// fails here instead of silently serving defaults.
//
// Start is synchronous and does no network I/O. A second Start with the same
// configuration is a no-op; a different one returns a Configuration error
// and leaves the running client alone. Every error is a *fireweave.Error and
// names the option or variable at fault, never a key.
func Start(opts Options) error {
	st.mu.Lock()
	lines, err := st.startLocked(opts, false)
	logger := st.loggerLocked()
	st.mu.Unlock()
	emit(logger, lines)
	if err != nil {
		return err
	}
	return nil
}

// MustStart is Start that panics with the *fireweave.Error, for a main that
// has nothing better to do with a misconfiguration than stop.
func MustStart(opts Options) {
	if err := Start(opts); err != nil {
		panic(err)
	}
}

// acquire returns the running client for one read or registration, starting
// FireWeave from the environment if nothing has started it yet. On failure
// it returns the error a read reports instead.
func acquire(flagKey string, isRead bool) (*fireweave.Client, *fireweave.Error) {
	st.mu.Lock()
	var lines []logLine
	if st.state == StateUnstarted && !st.implicitTried {
		lines, _ = st.startLocked(Options{}, true)
	}
	var (
		client *fireweave.Client
		err    *fireweave.Error
	)
	switch st.state {
	case StateReady:
		client = st.client
		r := st.resolved
		if isRead && r != nil && r.mode == ModeLocal {
			if _, ok := r.flags[flagKey]; !ok {
				lines = st.warnOnceLocked(lines, "[fireweave:local] "+strconv.Quote(flagKey)+" is not in your flags ("+flagsFile+"), so it gets its default. Add it there to try it locally.")
			}
		}
	case StateShutdown:
		err = fireweave.NewError(fireweave.KindAlreadyClosed, "", nil)
	default:
		err = st.err
		if err == nil {
			err = fireweave.NewError(fireweave.KindNotReady, "FireWeave was not started.", nil)
		}
	}
	logger := st.loggerLocked()
	st.mu.Unlock()
	emit(logger, lines)
	return client, err
}

// forwarder is the permanent client's adapter: it hands each call to the
// client the latest Start built. Reads that cannot reach one degrade to the
// caller's default with the start error, exactly as a core read degrades.
type forwarder struct{}

func (forwarder) Initialize(context.Context) error { return nil }

func (forwarder) Resolve(ctx context.Context, req fireweave.ResolveRequest) fireweave.Decision {
	client, err := acquire(req.FlagKey, true)
	if err != nil {
		return fireweave.ErrorDecision(req.FlagKey, req.DefaultValue, err, nil)
	}
	return client.Runtime().Evaluate(ctx, req)
}

func (forwarder) RegisterTarget(ctx context.Context, targetingKey string, opts fireweave.RegisterTargetOptions) fireweave.RegisterTargetResult {
	client, err := acquire("", false)
	if err != nil {
		return fireweave.RegisterTargetResult{Error: err}
	}
	return client.Runtime().RegisterTarget(ctx, targetingKey, opts)
}

// Close never runs: fw.Shutdown shuts the started client, never the
// permanent one.
func (forwarder) Close(context.Context) error { return nil }

var (
	_ fireweave.BackendAdapter  = forwarder{}
	_ fireweave.TargetRegistrar = forwarder{}
)

// Shutdown flushes and closes the started client. Afterwards reads serve
// their defaults (AlreadyClosed) and nothing starts implicitly; a later Start
// begins fresh.
func Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	st.mu.Lock()
	client := st.client
	st.client = nil
	st.state = StateShutdown
	st.implicitTried = true
	st.mu.Unlock()
	if client != nil {
		if err := client.Runtime().Shutdown(ctx); err != nil {
			return err
		}
	}
	return nil
}

// resetForTests shuts down and forgets the singleton, warnings, instance key
// and log sink included, so the next Start begins as in a new process. The
// permanent client is kept: it holds no state of its own.
func resetForTests() {
	st.mu.Lock()
	client := st.client
	st.freshRunLocked()
	st.instanceOption, st.instanceKey, st.instanceSet = "", "", false
	st.logger = nil
	st.warned = map[string]bool{}
	st.mu.Unlock()
	if client != nil {
		_ = client.Runtime().Shutdown(context.Background())
	}
}
