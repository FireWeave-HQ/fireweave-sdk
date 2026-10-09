package fw

// InstanceKey's derivation: a stable targeting key for reads where the server
// itself is the subject (cron, migrations, boot-time decisions). Request
// reads still pass the user's id (node: src/start/instance.ts).
//
// Sources, in order: Options.InstanceID, FIREWEAVE_INSTANCE_ID, then a hash
// of the host name, then a random id for the life of the process. Nothing is
// written to disk: in a container the file would not outlive the process.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"strings"
)

// Where an instance key came from.
const (
	instanceSourceOption = "option"
	instanceSourceEnv    = envInstanceID
	instanceSourceHost   = "host"
	instanceSourceRandom = "random"
)

// fnv1a64 is FNV-1a 64-bit as 16 hex digits: the same function node uses, so
// one host name gives one instance key in every SDK. Not a security hash.
func fnv1a64(text string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(text))
	return fmt.Sprintf("%016x", h.Sum64())
}

func randomID() string {
	b := make([]byte, 16)
	// Since Go 1.24 crypto/rand.Read never returns an error (go.mod's floor is
	// above that).
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// deriveInstanceKey is pure apart from the random fallback: the lookup and
// the host name are injected.
func deriveInstanceKey(option string, lookup lookupFunc, hostname func() string) (value, source string) {
	if v := strings.TrimSpace(option); v != "" {
		return v, instanceSourceOption
	}
	if v := lookup(envInstanceID); v != "" {
		return v, instanceSourceEnv
	}
	if host := strings.TrimSpace(hostname()); host != "" {
		return "inst_" + fnv1a64(host), instanceSourceHost
	}
	return "inst_" + randomID(), instanceSourceRandom
}
