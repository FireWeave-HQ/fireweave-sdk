package fw

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/fireweave"
)

// SP-27: when fw-server refuses the key, rate-limits or cannot be reached, a
// read or Identify through fw logs ONE line per kind for the life of the
// process, naming the key's source or the endpoint, never the key, and
// Status().LastErrorKind reports the latest kind.

const signalKey = "project-api-key_s3cretSignalValue"

// statusServer answers every request with the status the test sets.
func statusServer(t *testing.T, code *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(code.Load()))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func warnLines(rec *recorder, substr string) []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var out []string
	for _, l := range rec.lines {
		if strings.HasPrefix(l, "WARN ") && strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

func TestARejectedKeyLogsOneLineNamingItsSource(t *testing.T) {
	rec, log := fresh(t)
	var code atomic.Int32
	code.Store(http.StatusUnauthorized)
	srv := statusServer(t, &code)
	host, _ := url.Parse(srv.URL)

	mustStart(t, Options{Env: envMap(map[string]string{"FIREWEAVE_KEY": signalKey, "FIREWEAVE_URL": srv.URL}), Log: log})
	if s := Status(); s.LastErrorKind != "" {
		t.Fatalf("LastErrorKind before any request = %q, want empty", s.LastErrorKind)
	}
	for i := 0; i < 5; i++ {
		if got := ControlPoints().GetBooleanValue("new-checkout", true, For("user-1")); got != true {
			t.Fatal("a rejected key serves the caller's default")
		}
	}
	if err := Identify(context.Background(), "user-1", nil); !errorsIsKind(err, fireweave.KindAuthentication) {
		t.Fatalf("Identify err = %v, want Authentication", err)
	}

	lines := warnLines(rec, "(HTTP 401)")
	if len(lines) != 1 {
		t.Fatalf("want one 401 line for six failures, got %d:\n%s", len(lines), rec.all())
	}
	assertContains(t, lines[0], "rejected the key from FIREWEAVE_KEY")
	assertContains(t, lines[0], "fw-server at "+host.Hostname())
	if strings.Contains(rec.all(), "s3cretSignalValue") {
		t.Fatalf("a log line carries the key:\n%s", rec.all())
	}
	s := Status()
	if s.LastErrorKind != fireweave.KindAuthentication {
		t.Fatalf("LastErrorKind = %q, want Authentication", s.LastErrorKind)
	}
	if strings.Contains(s.Error, "s3cretSignalValue") {
		t.Fatalf("status carries the key: %+v", s)
	}
}

func TestEachFailureKindLogsOnceAndLastErrorKindFollowsTheLatest(t *testing.T) {
	rec, log := fresh(t)
	var code atomic.Int32
	srv := statusServer(t, &code)
	mustStart(t, Options{Key: signalKey, URL: srv.URL, Env: noVars, Log: log})

	read := func() { ControlPoints().GetBooleanValue("new-checkout", false, For("user-1")) }
	for _, step := range []struct {
		status int
		kind   fireweave.ErrorKind
		line   string
	}{
		{http.StatusForbidden, fireweave.KindAuthorization, "refused the key from Options.Key"},
		{http.StatusTooManyRequests, fireweave.KindRateLimited, "rate-limited the key from Options.Key"},
		{http.StatusServiceUnavailable, fireweave.KindBackendUnavailable, "(endpoint from Options.URL): it answered with an error status"},
		{http.StatusForbidden, fireweave.KindAuthorization, "refused the key from Options.Key"},
	} {
		code.Store(int32(step.status))
		read()
		read()
		if got := Status().LastErrorKind; got != step.kind {
			t.Fatalf("after HTTP %d: LastErrorKind = %q, want %q", step.status, got, step.kind)
		}
		if n := len(warnLines(rec, step.line)); n != 1 {
			t.Fatalf("after HTTP %d: %d lines for %q, want 1:\n%s", step.status, n, step.line, rec.all())
		}
	}

	// Recovering does not log; the latest failure stays in LastErrorKind.
	code.Store(http.StatusOK)
	read()
	if got := Status().LastErrorKind; got != fireweave.KindAuthorization {
		t.Fatalf("LastErrorKind = %q, want the latest failure", got)
	}
	if strings.Contains(rec.all(), "s3cretSignalValue") {
		t.Fatalf("a log line carries the key:\n%s", rec.all())
	}
}

func TestAnUnreachableEndpointLogsOnceNamingTheEndpoint(t *testing.T) {
	rec, log := fresh(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	dead := srv.URL
	srv.Close() // nothing listens there now

	mustStart(t, Options{Key: signalKey, URL: dead, Env: noVars, Log: log})
	for i := 0; i < 3; i++ {
		ControlPoints().GetBooleanValue("new-checkout", false, For("user-1"))
	}
	lines := warnLines(rec, "Could not reach fw-server")
	if len(lines) != 1 {
		t.Fatalf("want one unreachable line, got %d:\n%s", len(lines), rec.all())
	}
	assertContains(t, lines[0], "endpoint from Options.URL")
	if k := Status().LastErrorKind; k != fireweave.KindNetwork {
		t.Fatalf("LastErrorKind = %q, want Network", k)
	}
}

// The signal is once per process: a restart forgets LastErrorKind but does
// not log the same kind again.
func TestTheSignalIsOncePerProcessAcrossARestart(t *testing.T) {
	rec, log := fresh(t)
	var code atomic.Int32
	code.Store(http.StatusUnauthorized)
	srv := statusServer(t, &code)
	opts := Options{Key: signalKey, URL: srv.URL, Env: noVars, Log: log}

	mustStart(t, opts)
	ControlPoints().GetBooleanValue("new-checkout", false, For("user-1"))
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	mustStart(t, opts)
	if k := Status().LastErrorKind; k != "" {
		t.Fatalf("a fresh start reports LastErrorKind %q, want empty", k)
	}
	ControlPoints().GetBooleanValue("new-checkout", false, For("user-1"))
	if n := len(warnLines(rec, "(HTTP 401)")); n != 1 {
		t.Fatalf("401 logged %d times across a restart, want 1:\n%s", n, rec.all())
	}
	if k := Status().LastErrorKind; k != fireweave.KindAuthentication {
		t.Fatalf("LastErrorKind = %q, want Authentication", k)
	}
}

// Local mode never talks to fw-server, so nothing is signalled.
func TestLocalModeNeverSignals(t *testing.T) {
	rec, log := fresh(t)
	mustStart(t, Options{Mode: ModeLocal, Env: noVars, Log: log, ControlPoints: LocalControlPoints{"new-checkout": {Local: true}}})
	ControlPoints().GetBooleanValue("new-checkout", false, For("user-1"))
	ControlPoints().GetBooleanValue("missing", false, nil)
	if k := Status().LastErrorKind; k != "" {
		t.Fatalf("LastErrorKind = %q in local mode", k)
	}
	if len(warnLines(rec, "fw-server at")) != 0 {
		t.Fatalf("local mode logged a remote failure:\n%s", rec.all())
	}
}

// GO-1 end to end: remote reads and Identify overlapping Shutdown are
// race-free (run under -race) and degrade to the default.
func TestRemoteReadsOverlappingShutdownAreRaceFree(t *testing.T) {
	_, log := fresh(t)
	srv := newStub(t, signalKey)
	mustStart(t, Options{Key: signalKey, URL: srv.URL, Env: noVars, Log: log})

	var wg, started sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		started.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				d := ControlPoints().GetBooleanDetails("fw-bool-on", false, For("user-1"))
				if d.Error != nil && d.Error.Kind != fireweave.KindAlreadyClosed {
					t.Errorf("read during Shutdown: %+v", d)
				}
				_ = Identify(context.Background(), "user-1", nil)
				_ = Status()
				if j == 0 {
					started.Done()
				}
			}
		}()
	}
	started.Wait()
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if Status().State != StateShutdown {
		t.Fatalf("status = %+v", Status())
	}
}
