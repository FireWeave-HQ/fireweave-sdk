package remote_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/domain"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/infrastructure/adapters/remote"
)

// GO-1: Close may run while reads and registrations are in flight (the
// runtime checks its own state, then calls the adapter outside its lock).
// Run under -race: the adapter's closed/ready state must be synchronised.

func evaluateServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/targets/register" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"decisions": []map[string]any{{"controlPointKey": "checkout-v2", "value": true, "reason": "TARGETING_MATCH", "found": true}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteCloseDuringConcurrentReadsIsRaceFree(t *testing.T) {
	srv := evaluateServer(t)
	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	req := domain.ResolveRequest{
		ControlPointKey: "checkout-v2",
		Type:            domain.FlagTypeBoolean,
		DefaultValue:    false,
		Context:         domain.NewEvaluationContext("user-1", nil),
	}

	var (
		wg      sync.WaitGroup
		started sync.WaitGroup
		mu      sync.Mutex
		bad     []string
	)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		started.Add(1)
		go func() {
			defer wg.Done()
			first := true
			for j := 0; j < 40; j++ {
				d := a.Resolve(context.Background(), req)
				res := a.RegisterTarget(context.Background(), "user-1", domain.RegisterTargetOptions{})
				if first {
					started.Done()
					first = false
				}
				if d.Error != nil && d.Error.Kind != domain.KindAlreadyClosed {
					mu.Lock()
					bad = append(bad, "resolve: "+string(d.Error.Kind))
					mu.Unlock()
				}
				if res.Error != nil && res.Error.Kind != domain.KindAlreadyClosed {
					mu.Lock()
					bad = append(bad, "register: "+string(res.Error.Kind))
					mu.Unlock()
				}
			}
		}()
	}
	started.Wait()
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	wg.Wait()

	if len(bad) > 0 {
		t.Fatalf("a read racing Close must succeed or report AlreadyClosed, got %v", bad)
	}
	if d := a.Resolve(context.Background(), req); d.Error == nil || d.Error.Kind != domain.KindAlreadyClosed {
		t.Fatalf("after Close: %+v, want AlreadyClosed", d)
	}
}

// The adapter owns its connection pool: Close releases its idle keep-alive
// connections instead of leaving them in a process-wide shared transport.
func TestRemoteCloseReleasesIdleConnections(t *testing.T) {
	var (
		mu     sync.Mutex
		closed = make(chan struct{})
		once   sync.Once
		opened int
	)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"decisions": []map[string]any{{"controlPointKey": "checkout-v2", "value": true, "reason": "TARGETING_MATCH", "found": true}},
		})
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		mu.Lock()
		defer mu.Unlock()
		switch s {
		case http.StateNew:
			opened++
		case http.StateClosed:
			once.Do(func() { close(closed) })
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		ControlPointKey: "checkout-v2", Type: domain.FlagTypeBoolean, DefaultValue: false,
		Context: domain.NewEvaluationContext("user-1", nil),
	})
	if d.Error != nil {
		t.Fatalf("resolve: %+v", d)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close left the adapter's keep-alive connection open")
	}
	mu.Lock()
	defer mu.Unlock()
	if opened != 1 {
		t.Fatalf("opened %d connections, want 1", opened)
	}
}
