package fireweave

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestAllFifteenKinds(t *testing.T) {
	if len(AllErrorKinds) != 15 {
		t.Fatalf("want 15 canonical kinds, got %d", len(AllErrorKinds))
	}
	seen := map[ErrorKind]bool{}
	for _, k := range AllErrorKinds {
		if seen[k] {
			t.Errorf("duplicate kind %s", k)
		}
		seen[k] = true
		if DefaultMessage(k) == "" {
			t.Errorf("kind %s has no default message", k)
		}
	}
}

func TestErrorsIsMatchesSentinels(t *testing.T) {
	err := NewError(KindTimeout, "", nil)
	if !errors.Is(err, ErrTimeout) {
		t.Error("errors.Is should match ErrTimeout by kind")
	}
	if errors.Is(err, ErrNetwork) {
		t.Error("errors.Is must not match a different kind")
	}
}

func TestErrorsAsAndUnwrap(t *testing.T) {
	cause := errors.New("underlying: dial tcp refused")
	err := fmt.Errorf("wrapped: %w", NewError(KindNetwork, "", cause))

	var fwErr *Error
	if !errors.As(err, &fwErr) {
		t.Fatal("errors.As should find *Error through wrapping")
	}
	if fwErr.Kind != KindNetwork {
		t.Errorf("kind = %s, want Network", fwErr.Kind)
	}
	if !errors.Is(err, cause) {
		t.Error("cause should be reachable via Unwrap chain")
	}
}

func TestMessagesNeverContainSecrets(t *testing.T) {
	secrets := []string{
		"phc_SUPERSECRET000001",
		"phs_secretkey",
		"phx_personalkey",
		"Bearer abc.def.ghi",
		"FW_PROJECT_API_KEY",
	}
	for _, secret := range secrets {
		err := NewError(KindAuthentication, "auth failed for "+secret+" at host", nil)
		for _, needle := range []string{"phc_", "phs_", "phx_", "Bearer ", "FW_PROJECT_API_KEY"} {
			if strings.Contains(err.Message, needle) {
				t.Errorf("message %q leaked secret pattern %q", err.Message, needle)
			}
		}
		if !strings.Contains(err.Message, "[redacted]") {
			t.Errorf("message %q should carry a redaction marker", err.Message)
		}
	}
}

func TestRetryableClassification(t *testing.T) {
	retryable := []ErrorKind{KindNotReady, KindRateLimited, KindTimeout, KindNetwork, KindBackendUnavailable}
	for _, k := range retryable {
		if !Retryable(k) {
			t.Errorf("%s should be retryable", k)
		}
	}
	permanent := []ErrorKind{KindFlagNotFound, KindTypeMismatch, KindInvalidContext, KindAuthentication,
		KindAuthorization, KindMalformedResponse, KindUnsupportedCapability, KindConfiguration,
		KindAlreadyClosed, KindInternal}
	for _, k := range permanent {
		if Retryable(k) {
			t.Errorf("%s should not be retryable", k)
		}
	}
}

func TestDefaultMessagesMatchContracts(t *testing.T) {
	want := map[ErrorKind]string{
		KindNotReady:          "provider not ready",
		KindFlagNotFound:      "flag not found",
		KindTypeMismatch:      "flag type mismatch",
		KindAlreadyClosed:     "provider already closed",
		KindConfiguration:     "invalid configuration",
		KindMalformedResponse: "malformed backend response",
		KindTimeout:           "request timed out",
	}
	for k, msg := range want {
		if got := DefaultMessage(k); got != msg {
			t.Errorf("DefaultMessage(%s) = %q, want %q", k, got, msg)
		}
	}
}
